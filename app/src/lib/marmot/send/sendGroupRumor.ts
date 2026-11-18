/**
 * sendGroupRumor — the one way the app sends an application rumor into a group
 * (seam `SendGroupRumor`, AC-SEND-1; D6, D13).
 *
 * The app builds the rumor itself, because the optimistic row needs the final id before the
 * send: `id = getEventHash(rumor)` (nostr-tools), `pubkey` = the OWN account (never taken from
 * a caller or a message), `created_at` in seconds. The library re-derives the id on receive and
 * binds `rumor.pubkey` to the MLS sender, so the id the optimistic row carries is the id the
 * sink echo carries (own-row reconciliation by `rumor.id`).
 *
 * `group.send({type:'application', rumor})` is called EXACTLY ONCE per prepared send and is
 * never retried automatically: a proposal staged on the group is queued by the library and delivered
 * after the next commit (AC-SEND-2), and a failure is surfaced by the row tracker (failed/retry).
 *
 * RETRY RULE (S6): a retry MUST re-send the identical stored rumor (same id, same `created_at`): use
 * `sender.retry(group, rumorId)`, never `sendGroupRumor` with the same content again. Peers dedupe by
 * rumor id, so a retry of a send that did reach the group (a lost ack, a `publish-failed` the library still
 * publishes later) is harmless, while a rebuilt rumor would carry a new id and show as a second message.
 *
 * Own-intent matching: `group.send` returns no intent id and `intentFailed` names only an intent id, so
 * when the group exposes `pendingIntents()` the helper reads it around the send, binds the one new
 * application intent (or queued rumor) to the row (`tracker.bindIntent`), and only that intent's failure fails
 * the row. Ambiguous (several new intents from concurrent sends) or unobservable (already confirmed and
 * deleted, no `pendingIntents`) binds nothing: that row is then failed by `send()` rejecting, the
 * unconfirmed timer or a branch switch, never by another send's intent.
 *
 * Unconfirmed timer: started once the group is `synced()` (AC-PIPE-15: before the first post-load sync a
 * resolved `send()` only recorded an `awaiting-sync` intent, nothing is published), so an offline
 * start never fails a row for the time the sync takes. `synced()` rejecting (fenced, disposed, not a
 * member) fails the row.
 *
 * The own-row tracker is REQUIRED: every send is registered before `group.send` and resolved /
 * rejected into it, so no send can silently escape the failure detection (D6).
 */
import { getEventHash } from 'nostr-tools/pure';
import type { Rumor } from '@941design/nostr-events/event';
import { hasEditMarkerTag } from '@/src/lib/messageEdits/rumor';
import type { OwnRowTracker } from './ownRowTracker';

/** The slice of `MarmotGroup` the helper uses. */
export interface SendableGroup {
  readonly id: string;
  send: (intent: { readonly type: 'application'; readonly rumor: Rumor }) => Promise<unknown>;
  /** When present, the unconfirmed timer starts only once this resolves, and a rejection fails the row. */
  synced?: () => Promise<void>;
  /**
   * The durable outbound intents: the row's own library intent is identified through a diff around the send (see
   * the module doc). The library's `MarmotGroup` always provides it; a group object without it (a test double, a
   * wrapper) degrades trigger (b) to inert, announced once with a warning.
   */
  pendingIntents: () => Promise<ReadonlyArray<{ readonly intentId: string; readonly state: string; readonly kind: string }>>;
}

/** What `sendGroupRumor` resolves with: the canonical rumor id and whatever `group.send` resolved with. */
interface SendGroupRumorResult {
  id: string;
  result: unknown;
}

/** A built, tracked, not yet sent rumor. */
interface PreparedGroupRumor {
  /** `getEventHash(rumor)`: the id of the optimistic row. */
  readonly id: string;
  readonly rumor: Rumor;
  /** Sends the rumor: `group.send` is called once however often this is called (later calls return the first promise). */
  send: () => Promise<SendGroupRumorResult>;
}

interface GroupRumorSenderOptions {
  /** Lowercase hex pubkey of the OWN account: the rumor's `pubkey`. */
  ownPubkey: string;
  tracker: OwnRowTracker;
  /** Seconds since epoch; default `Math.floor(Date.now() / 1000)`. */
  nowSeconds?: () => number;
}

export interface GroupRumorSender {
  /** Builds the canonical rumor and registers the optimistic row with the tracker. Does not send. */
  prepare: (group: SendableGroup, kind: number, content: string, tags: string[][], options?: { createdAt?: number }) => PreparedGroupRumor;
  /** `prepare` + `send` (seam `SendGroupRumor`). */
  sendGroupRumor: (group: SendableGroup, kind: number, content: string, tags: string[][], options?: { createdAt?: number }) => Promise<SendGroupRumorResult>;
  /**
   * Retry of a `failed` row: re-sends the IDENTICAL stored rumor (same id) through `group.send` and returns
   * the row to `sending`. Rejects (without sending) for a row that is not `failed`. Never rebuilds the rumor.
   */
  retry: (group: SendableGroup, rumorId: string) => Promise<SendGroupRumorResult>;
  /** The group was left / purged: forgets its tracked rows and the sender's per-group bookkeeping. */
  forgetGroup: (groupId: string) => void;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** App rumor kinds that are SIGNALS folded into an aggregate (kind registry: reaction 7, delete 5, poll 10/11/12). */
const SIGNAL_KINDS: ReadonlySet<number> = new Set([5, 7, 10, 11, 12]);

/**
 * Whether the rumor is an own optimistic SIGNAL a recompute must re-apply while it is `sending`: a reaction,
 * a delete, a poll create/vote/close, or an edit-marked kind-9 replacement. A plain kind-9 chat message (or an
 * image message) is a row, not a signal: it is never carried over a recompute.
 */
export function isSignalRumor(rumor: Pick<Rumor, 'kind' | 'tags'>): boolean {
  return SIGNAL_KINDS.has(rumor.kind) || (rumor.kind === 9 && hasEditMarkerTag(rumor.tags));
}

/** Pure: the canonical unsigned rumor for `ownPubkey`, id = `getEventHash`. */
export function buildGroupRumor(ownPubkey: string, kind: number, content: string, tags: readonly (readonly string[])[], createdAt: number): Rumor {
  if (!HEX64.test(ownPubkey)) throw new TypeError('buildGroupRumor: ownPubkey must be 64 lowercase hex chars');
  if (!Number.isInteger(kind) || kind < 0 || kind > 65535) throw new TypeError('buildGroupRumor: kind must be an integer in 0..65535');
  if (typeof content !== 'string') throw new TypeError('buildGroupRumor: content must be a string');
  if (!Array.isArray(tags) || tags.some((t) => !Array.isArray(t) || t.some((v) => typeof v !== 'string'))) {
    throw new TypeError('buildGroupRumor: tags must be string[][]');
  }
  if (!Number.isInteger(createdAt) || createdAt < 0) throw new TypeError('buildGroupRumor: createdAt must be a non-negative integer');
  const unsigned = { pubkey: ownPubkey, created_at: createdAt, kind, tags: tags.map((t) => [...t]), content };
  return { ...unsigned, id: getEventHash(unsigned) };
}

export function createGroupRumorSender(options: GroupRumorSenderOptions): GroupRumorSender {
  if (!options || typeof options.ownPubkey !== 'string' || !HEX64.test(options.ownPubkey)) {
    throw new TypeError('createGroupRumorSender: ownPubkey (64 lowercase hex chars) is required');
  }
  const tracker = options.tracker;
  for (const method of ['register', 'attemptOf', 'sendResolved', 'sendRejected', 'bindIntent', 'retry', 'forgetGroup'] as const) {
    if (!tracker || typeof tracker[method] !== 'function') throw new TypeError(`createGroupRumorSender: tracker.${method} is required`);
  }
  const { ownPubkey } = options;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  /** Intent ids already bound to a row, per group (bounded): a new intent is attributed only once. */
  const claimed = new Map<string, Set<string>>();
  const MAX_CLAIMED = 1000;
  const claim = (groupId: string, intentId: string) => {
    let set = claimed.get(groupId);
    if (!set) claimed.set(groupId, (set = new Set()));
    set.add(intentId);
    if (set.size > MAX_CLAIMED) set.delete(set.values().next().value as string);
  };

  type IntentView = { intentId: string; state: string };
  let warnedNoPendingIntents = false;
  const applicationIntents = async (group: SendableGroup): Promise<IntentView[] | undefined> => {
    if (typeof group.pendingIntents !== 'function') {
      if (!warnedNoPendingIntents) {
        warnedNoPendingIntents = true;
        console.warn('[sendGroupRumor] group has no pendingIntents(): intentFailed cannot be matched to own sends (trigger b inert); rows fail through send() rejection, the unconfirmed timer or a branch switch only');
      }
      return undefined;
    }
    try {
      return (await group.pendingIntents()).filter((i) => i.kind === 'application');
    } catch {
      return undefined;
    }
  };
  /** The one application intent that appeared since `before` and is not bound to another row; undefined when none or ambiguous. */
  const ownIntent = async (group: SendableGroup, before: Promise<IntentView[] | undefined>): Promise<IntentView | undefined> => {
    const [b, after] = await Promise.all([before, applicationIntents(group)]);
    if (!b || !after) return undefined;
    const known = new Set(b.map((i) => i.intentId));
    const taken = claimed.get(group.id);
    const fresh = after.filter((i) => !known.has(i.intentId) && !taken?.has(i.intentId));
    return fresh.length === 1 ? fresh[0] : undefined;
  };

  /** Sends `rumor` once and reports into the tracker. Shared by `prepare().send()` and `retry`. */
  const dispatch = async (group: SendableGroup, rumor: Rumor): Promise<SendGroupRumorResult> => {
    // Issued before `send` writes its record, so the diff afterwards isolates this send's intent.
    const before = applicationIntents(group);
    // Results of THIS attempt only: a retry bumps the row's generation, and an older attempt that settles
    // late (a first send rejecting after a branch switch + retry) must not touch the retried row.
    const attempt = tracker.attemptOf(group.id, rumor.id);
    let result: unknown;
    try {
      result = await group.send({ type: 'application', rumor });
    } catch (err) {
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
      // `send-rejected` of a rumor the library still holds queued (AC-INVITE-3: the commit it waited for went
      // terminal, "the rumor stays queued"): it goes out after the next confirmed commit, the row stays sending.
      const intent = code === 'send-rejected' ? await ownIntent(group, before) : undefined;
      if (intent?.state === 'queued') {
        claim(group.id, intent.intentId);
        tracker.bindIntent(group.id, rumor.id, intent.intentId, attempt);
      } else {
        tracker.sendRejected(group.id, rumor.id, attempt);
      }
      throw err;
    }
    const intent = await ownIntent(group, before);
    if (intent) {
      claim(group.id, intent.intentId);
      tracker.bindIntent(group.id, rumor.id, intent.intentId, attempt);
    }
    if (typeof group.synced === 'function') {
      // Detached: `send()` resolves now, the timer starts when the group has synced (may never, offline).
      group.synced().then(
        () => tracker.sendResolved(group.id, rumor.id, attempt),
        () => tracker.sendRejected(group.id, rumor.id, attempt),
      );
    } else {
      tracker.sendResolved(group.id, rumor.id, attempt);
    }
    return { id: rumor.id, result };
  };

  const assertGroup = (group: SendableGroup) => {
    if (!group || typeof group.id !== 'string' || typeof group.send !== 'function') throw new TypeError('sendGroupRumor: group must have id and send');
  };

  const prepare: GroupRumorSender['prepare'] = (group, kind, content, tags, options) => {
    assertGroup(group);
    let createdAt = options?.createdAt ?? nowSeconds();
    let rumor = buildGroupRumor(ownPubkey, kind, content, tags, createdAt);
    // Same content in the same second is the same id: a second send would collapse into the first row.
    // Bump created_at until the id is not tracked (a distinct message must have a distinct id). RESIDUAL: this
    // guards TRACKED rows only; a row the tracker already pruned / forgotten (or one of an earlier session) is
    // not seen, so the same content sent again in the same second as such a row can still collide with it.
    while (tracker.statusOf(group.id, rumor.id) !== undefined) {
      if (options?.createdAt !== undefined) throw new Error('sendGroupRumor: rumor with fixed timestamp is already tracked');
      rumor = buildGroupRumor(ownPubkey, kind, content, tags, ++createdAt);
    }
    tracker.register(group.id, rumor.id, { rumor, signal: isSignalRumor(rumor) });
    let started: Promise<SendGroupRumorResult> | undefined;
    return {
      id: rumor.id,
      rumor,
      send() {
        started ??= dispatch(group, rumor);
        return started;
      },
    };
  };

  return {
    prepare,
    sendGroupRumor: (group, kind, content, tags, options) => prepare(group, kind, content, tags, options).send(),
    retry: async (group, rumorId) => {
      assertGroup(group);
      const rumor = tracker.retry(group.id, rumorId);
      if (!rumor) throw new Error(`sendGroupRumor.retry: row ${rumorId} is not failed or is unknown`);
      return dispatch(group, rumor);
    },
    forgetGroup: (groupId) => {
      claimed.delete(groupId);
      tracker.forgetGroup(groupId);
    },
  };
}
