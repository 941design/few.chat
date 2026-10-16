/**
 * applicationRumorDispatcher.ts
 *
 * Single message-carrying `group.on('authenticatedApplicationMessage')`
 * listener (plus a diagnostic-only `unauthenticatedMessage` listener,
 * AC-OBS-1) with per-group LRU seen-id deduplication and sequential handler
 * dispatch.
 *
 * Boundary rules (architecture.md):
 *   - Zero React imports
 *   - Zero context imports
 *   - Zero IDB calls at subscribe time
 *   - Only console.warn (never console.error) for handler errors
 */

// Static top-level import so vi.mock() in tests can intercept deserialization.

export interface ApplicationRumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface DispatcherContext {
  groupId: string;
  selfPubkeyHex: string;
  getActiveGroupId: () => string | null;
}

export interface AuthenticatedSender {
  pubkey: string;
  // Production always emits 'mls' post-migration: the dispatcher builds the
  // sender from the library-authenticated `authenticatedApplicationMessage`
  // payload (marmot-ts 0.7.0), so a non-MLS-authenticated sender never reaches
  // a handler. 'claimed' is retained only for unit-test helpers that exercise
  // handler logic independently of the authentication source.
  authenticity: 'claimed' | 'mls';
}

/**
 * Contract (bug: journal-ack-before-durable-side-effects): `handle` throws (or
 * rejects) when a local side effect the rumor needs did not durably land —
 * the dispatcher then keeps the rumor's journal entry and it is handled again
 * at the next subscription (re-subscribe or next startup). Handlers must
 * therefore be idempotent under such a replay. Failures that a replay should
 * NOT retry (a network send another mechanism retries, a best-effort UI
 * refresh) are caught inside the handler.
 */
export interface RumorHandler<TKind extends number = number> {
  kind: TKind;
  handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender, meta?: DispatchMeta): Promise<void> | void;
}

/** How a rumor reached its handlers. */
export interface DispatchMeta {
  /**
   * True when it came from replay() (the write-ahead journal: an earlier
   * session or subscription received it), false for a live/history delivery.
   */
  replayed: boolean;
}

export interface DispatcherSubscription {
  (): void;
  /** Wait for work accepted before this call. After disposal, queued work is
   * skipped and the running handler finishes. Await before reassigning storage. */
  drain(): Promise<void>;
  /**
   * Feed write-ahead-journaled rumors (rumorJournal.ts) through the SAME
   * listener live deliveries use — sender choke point, LRU dedup, handlers,
   * ack. Entries are enqueued synchronously, so calling this before live
   * ingestion starts puts them ahead of every live/history rumor on the FIFO
   * queue; their ids then suppress the live duplicates. Resolves when the
   * replayed work (and anything queued before it) has run. No-op after disposal.
   */
  replay(entries: ReadonlyArray<{ data: Uint8Array; senderPubkey: string }>): Promise<void>;
  /**
   * Run a maintenance task (e.g. the held poll-state sweep) on the SAME FIFO
   * queue as the handlers, after everything accepted before this call — so a
   * read-then-save task never interleaves with a handler of the group.
   * Skipped when disposed before it starts; a running task gets isDisposed()
   * and must stop writing once it holds (disposal cannot interrupt an await).
   * A throwing task is warned, never propagated (the queue keeps running).
   * Resolves once it has run.
   */
  enqueueMaintenance(task: (isDisposed: () => boolean) => Promise<void>): Promise<void>;
}

/** Write-ahead journal hook (rumorJournal.ts). */
export interface DispatcherJournal {
  /**
   * Delete the journal entry once every matching handler completed without
   * throwing. Failures are warned, never thrown out of the dispatcher.
   */
  ack(groupId: string, rumorId: string): Promise<void>;
  /**
   * Count one failed attempt (a handler threw) on the entry and return the
   * new count (rumorJournal.recordRumorFailure). Optional; a rejection is
   * warned and the entry is simply kept.
   */
  recordFailure?(groupId: string, rumorId: string): Promise<number>;
}

export interface DispatcherOptions {
  journal?: DispatcherJournal;
  /**
   * Failed attempts after which a journaled rumor is dropped as poison (acked
   * with a warning naming kind and id). Default 5
   * (rumorJournal.RUMOR_JOURNAL_MAX_FAILED_ATTEMPTS).
   */
  maxFailedAttempts?: number;
}

export interface Dispatcher {
  subscribe(group: MarmotGroupLike, ctx: DispatcherContext): DispatcherSubscription;
}

import { deserializeApplicationData } from '@internet-privacy/marmot-ts';
import type { AuthenticatedApplicationMessage, UnauthenticatedMessageInfo } from '@internet-privacy/marmot-ts';

// Minimal structural type — avoids a hard import dependency on the concrete
// MarmotGroup class. Post-migration (Change 3 / Seam A) the dispatcher
// listens on the library's MLS-authenticated event, never the raw
// 'applicationMessage' event (both fire for the same authenticated message —
// registering both would double-process, AC-SEAM-2).
interface MarmotGroupLike {
  on(event: 'authenticatedApplicationMessage', listener: (message: AuthenticatedApplicationMessage) => void): void;
  off(event: 'authenticatedApplicationMessage', listener: (message: AuthenticatedApplicationMessage) => void): void;
  on(event: 'unauthenticatedMessage', listener: (info: UnauthenticatedMessageInfo) => void): void;
  off(event: 'unauthenticatedMessage', listener: (info: UnauthenticatedMessageInfo) => void): void;
}

/** Maximum number of seen IDs stored per group. */
const LRU_CAP = 1000;
const DEFAULT_MAX_FAILED_ATTEMPTS = 5;

export function createDispatcher(handlers: RumorHandler[], options: DispatcherOptions = {}): Dispatcher {
  const journal = options.journal;
  const maxFailedAttempts = options.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
  // Per-group LRU: Map<groupId, Map<rumorId, completed>>. `completed` is false
  // while the rumor's handlers run and stays false when one failed (its journal
  // entry is kept), so a duplicate never acks a failed rumor's entry.
  // Map preserves insertion order; we evict from the front when size > LRU_CAP.
  const seenByGroup = new Map<string, Map<string, boolean>>();
  // Per-group capacity, raised by replay() (bug: rumor-journal-cap-evicts-unapplied):
  // the journal is bounded by age only, so one replay batch can exceed LRU_CAP.
  // Widening this group's window by the batch size keeps every replayed id (and
  // the LRU_CAP most recent ids before it) deduped against live redeliveries for
  // the rest of the session. Bounded: grows only by what the journal held.
  const capByGroup = new Map<string, number>();

  function isSeen(groupId: string, rumorId: string): boolean {
    return seenByGroup.get(groupId)?.has(rumorId) ?? false;
  }

  /**
   * True once the rumor's handlers all completed (false: running, failed, or
   * evicted). Only asked after isSeen, so the group's map exists.
   */
  function isCompleted(groupId: string, rumorId: string): boolean {
    return seenByGroup.get(groupId)!.get(rumorId) === true;
  }

  function markSeen(groupId: string, rumorId: string): void {
    let set = seenByGroup.get(groupId);
    if (!set) {
      set = new Map<string, boolean>();
      seenByGroup.set(groupId, set);
    }
    set.set(rumorId, false);
    // Evict oldest entries if the cap is exceeded.
    const cap = capByGroup.get(groupId) ?? LRU_CAP;
    if (set.size > cap) {
      const toEvict = set.size - cap;
      const iter = set.keys();
      for (let i = 0; i < toEvict; i++) {
        const entry = iter.next();
        if (!entry.done) {
          set.delete(entry.value);
        }
      }
    }
  }

  return {
    subscribe(group: MarmotGroupLike, ctx: DispatcherContext): DispatcherSubscription {
      let disposed = false;
      let tail = Promise.resolve();
      // Never throws, never rejects: an ack failure must not break the queue.
      const ack = async (rumorId: string): Promise<void> => {
        if (!journal) return;
        try {
          await journal.ack(ctx.groupId, rumorId);
        } catch (err) {
          console.warn('[dispatcher.journalAck]', err);
        }
      };
      // Count the failed attempt; at maxFailedAttempts drop (ack) the rumor.
      const giveUpIfPoison = async (rumor: ApplicationRumor): Promise<void> => {
        if (!journal?.recordFailure) return;
        let attempts: number;
        try {
          attempts = await journal.recordFailure(ctx.groupId, rumor.id);
        } catch (err) {
          console.warn('[dispatcher.journalAttempt]', err);
          return;
        }
        if (attempts < maxFailedAttempts) return;
        console.warn('[dispatcher.poisonRumor] dropping a rumor that failed every attempt', {
          groupId: ctx.groupId,
          kind: rumor.kind,
          rumorId: rumor.id,
          attempts,
        });
        seenByGroup.get(ctx.groupId)!.set(rumor.id, true);
        await ack(rumor.id);
      };
      const ackIfCompleted = (rumorId: string): Promise<void> =>
        isCompleted(ctx.groupId, rumorId) ? ack(rumorId) : Promise.resolve();
      // `replayed` is set only by replay(); the group's event emitter passes the
      // message alone, so live deliveries are never marked.
      const listener = ({ message, senderPubkey }: AuthenticatedApplicationMessage, replayed = false): Promise<void> => {
        if (disposed) return Promise.resolve();
        let rumor: ApplicationRumor;
        try {
          rumor = deserializeApplicationData(message) as ApplicationRumor;
        } catch {
          // Malformed application message — discard silently.
          return Promise.resolve();
        }

        if (isSeen(ctx.groupId, rumor.id)) {
          // Duplicate of a rumor already accepted (e.g. a live redelivery of a
          // replayed journal entry, which re-journals it). Not handled again.
          // Acked on the queue — never before the original's handlers
          // finished, since both share the same journal key — and only when
          // they completed: a failed original's entry is kept for replay.
          const id = rumor.id;
          tail = tail.then(() => ackIfCompleted(id));
          return tail;
        }

        // Build the authenticated sender DIRECTLY from the library-supplied
        // senderPubkey — AFTER deserialize but STRICTLY BEFORE markSeen and
        // fan-out. The library already guarantees senderPubkey === rumor.pubkey
        // for every authenticatedApplicationMessage delivery (a mismatch would
        // instead surface via the library's own 'unauthenticatedMessage' event
        // and never reach this listener at all — see the diagnostic wiring
        // below). The choke-point comparison below is kept as defense-in-depth
        // only; it must still fire before markSeen so a mismatched rumor's id
        // never poisons the per-group dedup LRU and a later legitimate
        // redelivery of the same id is not silently swallowed (AC-XCUT-1).
        const sender: AuthenticatedSender = { pubkey: senderPubkey, authenticity: 'mls' };

        if (sender.pubkey !== rumor.pubkey) {
          console.warn('[dispatcher.unauthenticatedMessage]', {
            groupId: ctx.groupId,
            kind: rumor.kind,
            rumorId: rumor.id,
            claimedPubkey: rumor.pubkey,
            authenticatedPubkey: sender.pubkey,
          });
          return Promise.resolve();
        }

        // EventEmitter ignores returned promises. Own the queue here so an
        // open/create finishes persisting before its dependent vote/edit runs.
        // Check dedup again inside the queue for overlapping history/live events.
        tail = tail.then(async () => {
          // Not yet started when disposed: NOT acked — replays next subscription.
          if (disposed) return;
          if (isSeen(ctx.groupId, rumor.id)) {
            await ackIfCompleted(rumor.id);
            return;
          }
          // Each rumor is attempted once per dispatcher (dedup); failures are
          // isolated and later messages still run.
          markSeen(ctx.groupId, rumor.id);
          let cutShort = false;
          let failed = false;
          const matching = handlers.filter((h) => h.kind === rumor.kind);
          for (const handler of matching) {
            if (disposed) {
              cutShort = true;
              break;
            }
            try {
              await handler.handle(rumor, ctx, sender, { replayed });
            } catch (err) {
              failed = true;
              console.warn(`[dispatcher.${rumor.kind}]`, err);
            }
          }
          // Write-ahead journal, ack-on-success (bug:
          // journal-ack-before-durable-side-effects): the entry is dropped only
          // when every matching handler completed. A handler that threw (its
          // durable side effect failed) or a fan-out cut short by disposal
          // leaves the entry journaled; the next subscription replays it and
          // the idempotent handlers converge.
          // Poison guard: a failed attempt is counted once on the journal row
          // (not per handler); at maxFailedAttempts the rumor is dropped so a
          // deterministic failure does not replay for 30 days. A failed count
          // write never blocks handling — the entry is just kept.
          if (failed) {
            await giveUpIfPoison(rumor);
            return;
          }
          if (cutShort) return;
          seenByGroup.get(ctx.groupId)!.set(rumor.id, true); // markSeen created it
          await ack(rumor.id);
        });
        return tail;
      };

      // AC-OBS-1: diagnostic-only — logs every rumor the library itself
      // dropped for failing MLS sender authentication (or undeserializable
      // ts-mls payload). Distinct from, and never a substitute for, the
      // app-side choke-point warn above: this fires for drops the message
      // listener never even sees (the library withholds the message
      // entirely), the choke-point warn fires for the (expected-unreachable,
      // defense-in-depth) case where a mismatched sender somehow still
      // reached this listener.
      const unauthenticatedListener = (info: UnauthenticatedMessageInfo): void => {
        console.warn('[marmot.unauthenticatedMessage]', {
          senderPubkey: info.senderPubkey,
          claimedPubkey: info.claimedPubkey,
          reason: info.reason,
          event: info.event,
        });
      };

      group.on('authenticatedApplicationMessage', listener);
      group.on('unauthenticatedMessage', unauthenticatedListener);
      const unsubscribe: DispatcherSubscription = () => {
        disposed = true;
        group.off('authenticatedApplicationMessage', listener);
        group.off('unauthenticatedMessage', unauthenticatedListener);
      };
      unsubscribe.drain = () => tail;
      unsubscribe.replay = (entries) => {
        // listener() itself is a no-op once disposed.
        capByGroup.set(ctx.groupId, Math.max(capByGroup.get(ctx.groupId) ?? LRU_CAP, LRU_CAP + entries.length));
        for (const entry of entries) {
          void listener({ message: entry.data, senderPubkey: entry.senderPubkey } as AuthenticatedApplicationMessage, true);
        }
        return tail;
      };
      unsubscribe.enqueueMaintenance = (task) => {
        tail = tail.then(async () => {
          if (disposed) return;
          try {
            await task(() => disposed);
          } catch (err) {
            console.warn('[dispatcher.maintenance]', err);
          }
        });
        return tail;
      };
      return unsubscribe;
    },
  };
}
