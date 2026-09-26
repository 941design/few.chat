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

export interface RumorHandler<TKind extends number = number> {
  kind: TKind;
  handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender): Promise<void> | void;
}

export interface DispatcherSubscription {
  (): void;
  /** Wait for work accepted before this call. After disposal, queued work is
   * skipped and the running handler finishes. Await before reassigning storage. */
  drain(): Promise<void>;
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

export function createDispatcher(handlers: RumorHandler[]): Dispatcher {
  // Per-group LRU: Map<groupId, Set<rumorId>>
  // Set preserves insertion order; we evict from the front when size > LRU_CAP.
  const seenByGroup = new Map<string, Set<string>>();

  function isSeen(groupId: string, rumorId: string): boolean {
    return seenByGroup.get(groupId)?.has(rumorId) ?? false;
  }

  function markSeen(groupId: string, rumorId: string): void {
    let set = seenByGroup.get(groupId);
    if (!set) {
      set = new Set<string>();
      seenByGroup.set(groupId, set);
    }
    set.add(rumorId);
    // Evict oldest entries if the cap is exceeded.
    if (set.size > LRU_CAP) {
      const toEvict = set.size - LRU_CAP;
      const iter = set.values();
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
      const listener = ({ message, senderPubkey }: AuthenticatedApplicationMessage): Promise<void> => {
        if (disposed) return Promise.resolve();
        let rumor: ApplicationRumor;
        try {
          rumor = deserializeApplicationData(message) as ApplicationRumor;
        } catch {
          // Malformed application message — discard silently.
          return Promise.resolve();
        }

        if (isSeen(ctx.groupId, rumor.id)) {
          return Promise.resolve();
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
          if (disposed || isSeen(ctx.groupId, rumor.id)) return;
          // At-most-once attempts: do not replay partial side effects when one
          // handler fails. Failures are isolated; later messages still run.
          markSeen(ctx.groupId, rumor.id);
          const matching = handlers.filter((h) => h.kind === rumor.kind);
          for (const handler of matching) {
            if (disposed) return;
            try {
              await handler.handle(rumor, ctx, sender);
            } catch (err) {
              console.warn(`[dispatcher.${rumor.kind}]`, err);
            }
          }
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
      return unsubscribe;
    },
  };
}
