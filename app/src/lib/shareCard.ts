/**
 * shareCard.ts — pure card-production + cache-invalidation helpers for the
 * "Share contact card" surface (epic: contact-card-exchange, story S6;
 * extended by epic: contact-pairing-code, story S2, RD-2).
 *
 * This is deliberately a thin, React-free layer sitting between the codec
 * seam (`@/src/lib/contactCard`) and its callers (profile.tsx). It exists so:
 *
 *   1. The signed-card cache's staleness rule (rebuild iff the nickname, the
 *      active signer mode, the active identity's pubkey, or — since S2 — the
 *      active pairing nonce changed since the last build — VQ-S6-001,
 *      VQ-S6-006, AC-NONCE-7) is a plain, jsdom-free-testable pure function
 *      instead of logic buried in a React effect/callback. The pubkeyHex
 *      check guards a mid-session identity restore that lands on an
 *      unchanged (nickname, signerMode) pair — see `ShareCardCacheKey`.
 *   2. The exact production path callers use can be exercised by
 *      adapter-mode unit tests (local-key / NIP-07-stub / NIP-46-stub)
 *      without importing any page or React context.
 *
 * `getOwnShareCard` is the orchestration entry point profile.tsx calls. It
 * owns the actual signer selection
 * (`activeEventSignerOverride.current ?? createPrivateKeySigner(privateKeyHex)`,
 * the existing precedent — see IncomingCallWatcher.tsx) and passes it in via
 * `getSignEvent`, so this module never sees a private key and never imports
 * `signerAdapter` itself. `NpubQrModal.tsx` never imports this module either —
 * it only ever receives the resulting `shareUrl` string as a prop.
 *
 * Since story S2, `getOwnShareCard` always produces a v2 pairing card
 * (`encodeCardV2`, via `buildOwnShareCardV2`) — every shared card carries an
 * issuer-minted nonce+expiry so a scanner can reciprocate (S3/S4). The
 * active nonce is resolved from `@/src/lib/pairing/nonceStore` (RD-2's
 * mint-or-reuse lifecycle); architecture.md's module map explicitly
 * consolidates "issuer nonce store" and "share lifecycle" as one cohesive
 * concern for this story, so this file importing its sibling nonce module is
 * expected, not a boundary violation. `buildOwnShareCard` (the v1 identity-only
 * builder) currently has NO production caller — the Share surface emits v2
 * pairing cards exclusively (`getOwnShareCard` → `buildOwnShareCardV2`) — and is
 * retained only as preexisting exported API (and for its own unit coverage); see
 * its function-level doc for the full rationale.
 */

import type { EventSigner } from 'applesauce-core';
import { encodeCard, encodeCardV2, buildShareUrl, SignerPubkeyMismatchError } from '@/src/lib/contactCard';
import type { SignerMode } from '@/src/context/NostrIdentityContext';
import { getOrMintActiveNonce, type StoredNonce } from '@/src/lib/pairing/nonceStore';

// ── Cache key/entry ──────────────────────────────────────────────────────

export type ShareCardCacheKey = {
  nickname: string;
  signerMode: SignerMode;
  /**
   * The active identity's pubkey at the time of build. Without this, a
   * mid-session identity restore (`replaceIdentity` swaps identity via
   * `setIdentity()` with no page reload — see NostrIdentityContext.tsx) that
   * lands on the same (nickname, signerMode) — e.g. two local-signer
   * identities that both have an empty nickname, the common default — would
   * be indistinguishable from the prior identity's key and produce a cache
   * HIT that serves the PREVIOUS identity's already-signed card (wrong
   * pubkey, stale signature) instead of rebuilding for the new one.
   */
  pubkeyHex: string;
  /**
   * The active pairing nonce (RD-2, `nonceStore.getOrMintActiveNonce`) this
   * card was built for — the 4th dimension, added by story S2. Without this,
   * a nonce rotation (reload after the prior nonce expired, or the active
   * nonce expiring mid-session) with `nickname`/`signerMode`/`pubkeyHex`
   * unchanged would be indistinguishable from a repeat open and produce a
   * cache HIT that serves a card carrying a stale, no-longer-active nonce
   * (AC-NONCE-7).
   */
  nonceHex: string;
};

export type ShareCardCacheEntry = {
  key: ShareCardCacheKey;
  shareUrl: string;
};

/**
 * True when `cached` is missing or stale relative to `key` — i.e. the
 * nickname, the active signer mode, the active identity's pubkeyHex, or the
 * active pairing nonce differs from what the cache was built with. A repeat
 * call with an unchanged key returns false, which is what keeps a repeat
 * share-modal open from re-invoking a (possibly remote, NIP-46) signer
 * (VQ-S6-001). A nickname edit or a signer-mode switch (e.g. local -> NIP-46
 * mid-session) correctly invalidates the cache (VQ-S6-006). A mid-session
 * identity restore (`replaceIdentity`, which swaps identity in place with no
 * page reload) that lands on the same (nickname, signerMode) — e.g. two
 * local-signer identities that both default to an empty nickname — is
 * caught by the pubkeyHex comparison instead, which is what prevents a
 * stale, wrong-identity signed card from being served on cache HIT. A nonce
 * rotation (reload, or the active nonce expiring mid-session) with the other
 * three dimensions unchanged is caught by the nonceHex comparison, which is
 * what prevents a stale-nonce card from being served on cache HIT
 * (AC-NONCE-7).
 */
export function shouldRebuildShareCard(
  cached: ShareCardCacheEntry | null,
  key: ShareCardCacheKey,
): boolean {
  if (!cached) return true;
  return (
    cached.key.nickname !== key.nickname ||
    cached.key.signerMode !== key.signerMode ||
    cached.key.pubkeyHex !== key.pubkeyHex ||
    cached.key.nonceHex !== key.nonceHex
  );
}

// ── Share eligibility ────────────────────────────────────────────────────

/**
 * True iff `nickname` is a shareable display name — i.e. non-empty after
 * trimming surrounding whitespace.
 *
 * Product rule: a contact card may only be shared once the user has actually
 * set a name. The Share action must never emit a bare-npub / unsigned card
 * (encodeCard's AC-CARD-6 graceful degradation is a codec-level concern for
 * the decode/import side, not something the Share surface produces). A
 * whitespace-only nickname counts as unset. This is the single source of
 * truth for that rule, shared by `getOwnShareCard`'s hard guard and the
 * Profile page's disabled Share button.
 */
export function hasShareableName(nickname: string): boolean {
  return nickname.trim().length > 0;
}

// ── Card production ──────────────────────────────────────────────────────

/**
 * Build a v1 (identity-only) contact card and wrap it in the shareable
 * onboarding URL. Adds no encoding logic of its own; it wraps
 * `encodeCard(...).then(buildShareUrl)`.
 *
 * NOTE: as of the contact-pairing-code epic, the Share surface produces v2
 * pairing cards exclusively (`getOwnShareCard` → `buildOwnShareCardV2`), so
 * this v1 builder currently has NO production caller — it is retained only as
 * a codec-adjacent utility (and for its own unit coverage of the v1 wrap).
 * Do not route the Share flow back through it: the Share surface is required
 * to emit a signed pairing card (see the `hasShareableName` hard guard in
 * `getOwnShareCard`).
 */
export async function buildOwnShareCard(
  pubkeyHex: string,
  profile: { nickname: string; createdAt: number },
  signEvent: EventSigner['signEvent'],
): Promise<string> {
  const payload = await encodeCard(pubkeyHex, profile, signEvent);
  return buildShareUrl(payload);
}

/**
 * v2 analogue of `buildOwnShareCard` (story S2, RD-2): builds and signs a
 * pairing card carrying `nonceHex`/`expiresAt` (`encodeCardV2` — always
 * signed, no AC-CARD-6 unsigned degradation, matching every real caller
 * already gating on `hasShareableName`) and wraps it in the shareable
 * onboarding URL. This is what `getOwnShareCard` calls on a cache MISS.
 */
export async function buildOwnShareCardV2(
  pubkeyHex: string,
  profile: { nickname: string; createdAt: number },
  nonceHex: string,
  expiresAt: number,
  signEvent: EventSigner['signEvent'],
): Promise<{ shareUrl: string; cardB64Url: string }> {
  const encoded = await encodeCardV2(pubkeyHex, profile, nonceHex, expiresAt, signEvent);
  return { shareUrl: buildShareUrl(encoded.cardB64Url), cardB64Url: encoded.cardB64Url };
}

// ── Cache-driven orchestration ───────────────────────────────────────────

export type GetOwnShareCardParams = {
  pubkeyHex: string;
  nickname: string;
  signerMode: SignerMode;
  /** The caller's current cache entry (or null on a cold start). */
  cache: ShareCardCacheEntry | null;
  /**
   * Lazily resolves the signer's `signEvent` function. Only invoked on a
   * cache MISS — a cache hit never calls this, which is what guarantees no
   * remote NIP-46 round trip happens on a repeat share-modal open with an
   * unchanged nickname/signerMode/pubkeyHex/nonceHex.
   */
  getSignEvent: () => Promise<EventSigner['signEvent']>;
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  now?: () => number;
  /**
   * Resolves the issuer's current active pairing nonce (RD-2). Defaults to
   * `nonceStore.getOrMintActiveNonce` — production callers (profile.tsx)
   * never need to pass this; it exists so tests can control the exact
   * mint/reuse/expiry behavior without importing `fake-indexeddb`.
   * Resolved on EVERY call (cache hit or miss) because the cache-key
   * comparison needs to know the current nonce either way — on a real
   * session this is a cheap in-memory read except when it actually mints.
   */
  getActiveNonce?: (nowSec: number) => Promise<StoredNonce>;
};

export type GetOwnShareCardResult = {
  /** True iff the card was freshly (re)signed on this call. */
  rebuilt: boolean;
  shareUrl: string;
  /** The cache entry to persist for the next call. */
  cache: ShareCardCacheEntry;
};

/**
 * The single orchestration entry point profile.tsx calls when the user opens
 * the share-card modal: returns the cached share URL unchanged when the
 * (nickname, signerMode, pubkeyHex, nonceHex) key hasn't moved, otherwise
 * resolves a signer and rebuilds a v2 pairing card. Pure aside from
 * `getSignEvent`/`now`/`getActiveNonce`, all injected (the latter two with
 * production-real defaults), so it is fully testable without React or a
 * real signer.
 */
export async function getOwnShareCard(params: GetOwnShareCardParams): Promise<GetOwnShareCardResult> {
  // Product invariant: sharing requires a name. Refuse before touching the
  // cache, the nonce store, or a (possibly remote) signer so an
  // empty/whitespace-only nickname can never produce or serve a bare-npub
  // card from the Share action. The Profile UI disables the Share button on
  // the same `hasShareableName` rule; this is the non-bypassable backstop.
  if (!hasShareableName(params.nickname)) {
    throw new Error('shareCard: refusing to share a contact card without a name');
  }

  const now = params.now ?? (() => Math.floor(Date.now() / 1000));
  const nowSec = now();
  const resolveActiveNonce = params.getActiveNonce ?? ((n: number) => getOrMintActiveNonce(n));
  const activeNonce = await resolveActiveNonce(nowSec);

  const key: ShareCardCacheKey = {
    nickname: params.nickname,
    signerMode: params.signerMode,
    pubkeyHex: params.pubkeyHex,
    nonceHex: activeNonce.nonce,
  };
  const cached = params.cache;

  if (!shouldRebuildShareCard(cached, key)) {
    return { rebuilt: false, shareUrl: cached!.shareUrl, cache: cached! };
  }

  const signEvent = await params.getSignEvent();
  const { shareUrl } = await buildOwnShareCardV2(
    params.pubkeyHex,
    { nickname: params.nickname, createdAt: nowSec },
    activeNonce.nonce,
    activeNonce.expiresAt,
    signEvent,
  );
  const cache: ShareCardCacheEntry = { key, shareUrl };
  return { rebuilt: true, shareUrl, cache };
}

/**
 * The message to show when building the share card failed. A signer that holds
 * a different identity than the local profile (typed error, never message
 * text) gets its own actionable message; every other failure keeps the
 * generic one.
 */
export function resolveShareCardError(
  err: unknown,
  messages: { generic: string; signerMismatch: string },
): string {
  return err instanceof SignerPubkeyMismatchError ? messages.signerMismatch : messages.generic;
}
