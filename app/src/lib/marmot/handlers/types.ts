/**
 * handlers/types.ts — the rumor / handler contract types shared by every
 * per-kind handler. Lives with the handlers so the old dispatcher
 * (`applicationRumorDispatcher.ts`, deleted in S22) can go without touching
 * them; that module re-exports these for its remaining legacy users.
 *
 * Types only: no runtime code.
 */

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
