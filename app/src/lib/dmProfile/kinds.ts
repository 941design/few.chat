/**
 * kinds.ts — DM profile-exchange message codec + kind constants.
 *
 * Epic: direct-contact-profile-exchange | Story 01 (codec)
 *
 * Pure module. NO React / NDK / idb / localStorage import surface — every
 * other module in this feature (scheduler, send, receive) depends only on
 * this file's typed exports (`ProfileRequestPayload` / `ProfileAnnouncePayload`
 * + the encode/parse functions), never on each other's internals, per
 * architecture.md's "Codec → send/receive" seam.
 *
 * Mirrors `app/src/lib/pairing/pairingAck.ts`'s `PAIRING_ACK_KIND` +
 * `PAIRING_ACK_SENTINEL_KINDS` module-load throw-on-collision pattern
 * (pairingAck.ts:61-81) for the same reason: fail loudly at import time, not
 * only in a test, if these constants are ever edited to collide with another
 * in-repo kind sentinel.
 *
 * ## Kind numbers (spec.md §4, "Resolved Decisions")
 *
 * `DM_PROFILE_REQUEST_KIND = 21061`, `DM_PROFILE_ANNOUNCE_KIND = 21062`.
 * Confirmed via repo-wide grep immediately before landing (2026-07-12):
 * `grep -rn "21061|21062" app/src app/tests` returned zero hits prior to this
 * story. Confirmed distinct from every other in-repo kind sentinel this
 * codebase checks or defines — see `DM_PROFILE_SENTINEL_KINDS` below for the
 * full mandatory pre-land list (AC-STRUCT-1).
 *
 * ## Naming (AC-STRUCT-2)
 *
 * Named `DM_PROFILE_REQUEST_KIND` / `DM_PROFILE_ANNOUNCE_KIND` — deliberately
 * NOT `PROFILE_REQUEST_KIND`, which `app/src/lib/marmot/profileRequestSync.ts`
 * already exports with value `30` for the MLS group relay-on-behalf
 * mechanism, a different transport (MLS application rumor vs NIP-59 gift-wrap
 * inner rumor). No numeric or namespace collision exists between the two
 * modules' dispatch tables, but reusing the constant name would be a
 * duplicate-export hazard and would muddy the pre-land grep — hence the `DM_`
 * prefix.
 */

// ── Kind sentinels (AC-STRUCT-1) ────────────────────────────────────────────

/** The new DM profile-exchange rumor kind for a profile-request. */
export const DM_PROFILE_REQUEST_KIND = 21061 as const;

/** The new DM profile-exchange rumor kind for a profile-announce. */
export const DM_PROFILE_ANNOUNCE_KIND = 21062 as const;

/**
 * The full mandatory pre-land kind list (spec.md §4 / "Resolved Decisions" /
 * AC-STRUCT-1) that `DM_PROFILE_REQUEST_KIND` and `DM_PROFILE_ANNOUNCE_KIND`
 * must never collide with:
 *
 * - `444` — Welcome (MLS)
 * - `5` — delete signal
 * - `7` — reaction
 * - `9` — `CHAT_MESSAGE_KIND` (chatPersistence.ts, differently-scoped from the
 *   `14` below)
 * - `13` — seal (NIP-59)
 * - `14` — `CHAT_MESSAGE_KIND` (directMessages.ts)
 * - `21059` — `JOIN_REQUEST_KIND` / `JOIN_REQUEST_RUMOR_KIND` (Welcome /
 *   join-request), also `CALL_GIFT_WRAP_KIND`
 * - `21060` — `PAIRING_ACK_KIND` (pairingAck.ts)
 * - `20602` — `CARD_SIG_KIND_V2`
 * - `25050`–`25055` — call-signaling inner kinds (callSignaling.ts /
 *   IncomingCallWatcher.tsx)
 * - `10` — `POLL_OPEN_KIND` (pollSync.ts)
 * - `11` — `POLL_VOTE_KIND` (pollSync.ts)
 * - `12` — `POLL_CLOSE_KIND` (pollSync.ts)
 * - `30078` — `BACKUP_EVENT_KIND` (relayBackup.ts)
 * - `30051` — `RELAY_LIST_KIND` (relayBackup.ts)
 * - `30` — `PROFILE_REQUEST_KIND` (marmot/profileRequestSync.ts — a different
 *   transport; see the naming note above)
 * - `0` — `PROFILE_RUMOR_KIND` (marmot/profileSync.ts — the MLS group
 *   application-rumor namespace; explicitly forbidden by spec.md §4)
 *
 * Not unit-tested by repo precedent (`pairingAck.ts`'s equivalent assertion
 * isn't either — untestable except by source mutation + re-import); the
 * throw below plus the pre-land grep cited in the module doc are the
 * defense. See `app/tests/unit/dmProfile/kinds.test.ts` for a test that at
 * least asserts the two constants' literal values and that they are absent
 * from an independently-typed copy of this list.
 */
const DM_PROFILE_SENTINEL_KINDS = [
  444, 5, 7, 9, 13, 14, 21059, 21060, 20602,
  25050, 25051, 25052, 25053, 25054, 25055,
  10, 11, 12, // POLL_OPEN_KIND / POLL_VOTE_KIND / POLL_CLOSE_KIND
  30078, // BACKUP_EVENT_KIND
  30051, // RELAY_LIST_KIND
  30, // PROFILE_REQUEST_KIND (marmot/profileRequestSync.ts)
  0, // PROFILE_RUMOR_KIND (marmot/profileSync.ts)
] as const;

if (
  (DM_PROFILE_SENTINEL_KINDS as readonly number[]).includes(DM_PROFILE_REQUEST_KIND) ||
  (DM_PROFILE_SENTINEL_KINDS as readonly number[]).includes(DM_PROFILE_ANNOUNCE_KIND)
) {
  // Defense in depth: fail loudly at module load time (not just in a test) if
  // either constant is ever edited to collide with a reserved sentinel kind.
  throw new Error(
    'dmProfile/kinds: DM_PROFILE_REQUEST_KIND or DM_PROFILE_ANNOUNCE_KIND collides with a reserved sentinel kind',
  );
}

// ── Shared parse-result shape ───────────────────────────────────────────────

/**
 * The exhaustive vocabulary of malformed-parse reasons either parser can
 * return. Exported (rather than left as a bare `string`) so story 04's
 * receive-path dispatch gets a compile-checked, exhaustive-switchable
 * vocabulary at this seam instead of an open string (gate-remediation
 * finding, sev 2).
 */
export type ProfileParseReason =
  | 'invalid-json'
  | 'not-an-object'
  | 'wrong-type'
  | 'invalid-since'
  | 'invalid-nickname'
  | 'nickname-too-long'
  | 'invalid-updatedAt'
  | 'avatar-missing'
  | 'avatar-imageUrl-invalid'
  | 'avatar-imageUrl-too-long'
  | 'avatar-imageUrl-invalid-scheme';

/**
 * Discriminated-union result for both parsers below. Never throws — callers
 * (send.ts, receive.ts) branch on `ok` rather than catching an exception.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: ProfileParseReason };

// ── Shared wire-value validators (gate-remediation, sev 5/2/3) ─────────────

/**
 * Strict ISO-8601 UTC timestamp check, applied to both `ProfileRequestPayload
 * .since` and `ProfileAnnouncePayload.updatedAt`.
 *
 * Both fields feed a lexicographic ISO-8601 string compare downstream
 * (AC-PROF-10's LWW in `contactCache.ts`, story 04). A loosely-validated
 * `updatedAt` — e.g. `Number.isNaN(Date.parse(x))` alone, which accepts many
 * non-ISO strings including bare numbers and non-padded dates — would let a
 * gate-passing sender submit a string that sorts after every real timestamp
 * (`"zzzz"` lexicographically dominates any `"2026-…"` string) and win LWW
 * forever, pinning a stale/empty avatar and silently blocking all further
 * legitimate announces from that peer.
 *
 * Three layers, all required:
 *   1. Shape: exactly the `Date.prototype.toISOString()` output shape
 *      (`YYYY-MM-DDTHH:mm:ss.sssZ`) — the same shape this module's own
 *      `encodeProfileAnnounce` always emits, so every sender's `updatedAt`
 *      compares on equal footing (mixed offset/precision ISO-8601 variants
 *      are technically valid ISO-8601 but would silently break the
 *      lexicographic-ordering assumption AC-PROF-10 depends on).
 *   2. `Date.parse` sanity check — rejects shape-valid-but-nonsensical
 *      calendar values (`"2026-13-99T25:99:99.000Z"` parses to `NaN`).
 *   3. Round-trip check — rejects values `Date.parse` silently renormalizes
 *      to a different instant (e.g. `"2026-02-30…"` parses as if it were
 *      March 2, so re-serializing it would not equal the input).
 */
const ISO_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isStrictIsoUtcTimestamp(value: string): boolean {
  if (!ISO_UTC_TIMESTAMP_RE.test(value)) {
    return false;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return false;
  }
  return new Date(ms).toISOString() === value;
}

/**
 * Nickname byte cap on the untrusted parse path, mirroring — not importing,
 * to keep this module's cross-module dependency footprint at zero per
 * architecture.md's pure-core rule — `contactCard.ts#MAX_NAME_BYTES` /
 * `config/profile.ts#NICKNAME_MAX_BYTES` (32 UTF-8 bytes), the same cap
 * already enforced on a LOCAL profile's nickname at save time
 * (`ProfileContext.tsx#capNickname`). Reusing the identical number — rather
 * than inventing a second, competing limit — means a gate-passing peer's
 * announced nickname can never exceed what our own save path would ever
 * have allowed that peer to set for themselves.
 */
const NICKNAME_MAX_BYTES = 32;

/**
 * `avatar.imageUrl` length cap on the untrusted parse path. No existing
 * numeric precedent to mirror (unlike nickname); picked as a generous bound
 * for a URL string (gate-remediation, sev 2) — large enough for any real
 * blossom/CDN URL, small enough to reject a pathological multi-megabyte
 * string a gate-passing peer could otherwise get persisted into
 * `contactCache.ts`.
 */
export const AVATAR_IMAGE_URL_MAX_LENGTH = 512;

/**
 * `avatar.imageUrl` scheme allow-list (gate-remediation, sev 3).
 *
 * Decision: ADD a scheme guard here, rather than delegating to the render
 * path. At the time, the MLS group profile-sync mechanism
 * (`marmot/profileSync.ts#payloadToMemberProfile`) accepted
 * `payload.avatar.imageUrl` from the wire with NO scheme validation; it now
 * shares this module's `avatarImageUrlProblem` predicate (bug
 * untrusted-group-input-hardening). The render path (`ProfileSummary.tsx`: `<img
 * src={profile.avatar.imageUrl}>`, `AvatarBrowserModal.tsx`) does no
 * sanitization either — there is no existing sanitizing chokepoint to
 * delegate to. Rather than repeat that gap in a brand-new codec module,
 * this parser accepts only `https://` absolute URLs or the app's own
 * protocol-relative blossom shape (`//host/path`, matching
 * `config/profile.ts#AVATAR_BROWSER_CONFIG.endpointBaseUrl =
 * '//few.chat/assets'`) and rejects everything else (`data:`, `javascript:`,
 * `http://`, bare relative paths, etc.) before the value can ever reach
 * `contactCache.ts` or an `<img src>`.
 */
const AVATAR_IMAGE_URL_SCHEME_RE = /^(?:https:\/\/|\/\/)\S+$/;

/** Why an untrusted `avatar.imageUrl` value is rejected, or `null` if allowed. */
export type AvatarImageUrlProblem = 'invalid' | 'too-long' | 'invalid-scheme';

/**
 * The single avatar-URL rule set for every untrusted profile path — the 1:1
 * profile-announce codec below AND the MLS group profile sync
 * (`marmot/profileSync.ts#payloadToMemberProfile`). Checks, in order: a
 * non-empty string, at most `AVATAR_IMAGE_URL_MAX_LENGTH` characters, and the
 * `https://` / `//` scheme allow-list with no whitespace.
 */
export function avatarImageUrlProblem(value: unknown): AvatarImageUrlProblem | null {
  if (typeof value !== 'string' || value.length === 0) return 'invalid';
  if (value.length > AVATAR_IMAGE_URL_MAX_LENGTH) return 'too-long';
  if (!AVATAR_IMAGE_URL_SCHEME_RE.test(value)) return 'invalid-scheme';
  return null;
}

/** Boolean form of `avatarImageUrlProblem`. */
export function isAllowedAvatarImageUrl(value: unknown): value is string {
  return avatarImageUrlProblem(value) === null;
}

/**
 * Re-validate a STORED avatar on read (bug: stored-group-avatars-not-resanitized):
 * rows persisted before the avatar-URL check (member profiles, contact cache)
 * may still carry an unsafe URL. Returns `{ imageUrl }` when it passes the same
 * rules as the wire paths, otherwise `null` (no avatar). Never throws.
 */
export function sanitizeStoredAvatar(value: unknown): { imageUrl: string } | null {
  const imageUrl = (value as { imageUrl?: unknown } | null | undefined)?.imageUrl;
  return isAllowedAvatarImageUrl(imageUrl) ? { imageUrl } : null;
}

// ── profile-request wire shape (AC-STRUCT-1 seam contract) ─────────────────

/**
 * The `profile-request` rumor content shape (spec.md §4). Requesting a peer's
 * profile requires no local nickname/avatar (AC-PROF-12) — this type and
 * `encodeProfileRequest` never reference the caller's own profile.
 */
export type ProfileRequestPayload = {
  type: 'profile-request';
  /** ISO-8601 timestamp: "only answer if your profile is newer than this". */
  since?: string;
};

/**
 * Serialize a profile-request payload for the rumor `content` field.
 * `since`, when provided, must be a strict ISO-8601 UTC timestamp (see
 * `isStrictIsoUtcTimestamp`) — anything else throws, since that is a caller
 * bug, not a retryable condition.
 */
export function encodeProfileRequest(input?: { since?: string }): string {
  const since = input?.since;
  if (since !== undefined && (typeof since !== 'string' || !isStrictIsoUtcTimestamp(since))) {
    throw new Error('dmProfile/kinds: encodeProfileRequest since must be a strict ISO-8601 UTC timestamp when provided');
  }
  const payload: ProfileRequestPayload =
    since !== undefined ? { type: 'profile-request', since } : { type: 'profile-request' };
  return JSON.stringify(payload);
}

/**
 * Parse + validate a profile-request rumor's `content` string.
 *
 * Rejects: invalid JSON, non-object content, a `type` other than
 * `'profile-request'`, and a `since` that is present but not a strict
 * ISO-8601 UTC timestamp (`isStrictIsoUtcTimestamp` — gate-remediation sev 5:
 * `since` feeds the same downstream comparisons `updatedAt` does). Always
 * returns a freshly-constructed literal object on success (never the raw
 * parsed value) so that extra/unexpected keys on the wire — including a
 * prototype-pollution attempt such as an own `__proto__` key — are silently
 * dropped rather than propagated to the caller (VQ-01-006).
 */
export function parseProfileRequest(content: string): ParseResult<ProfileRequestPayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'profile-request') {
    return { ok: false, reason: 'wrong-type' };
  }
  if (obj.since !== undefined && (typeof obj.since !== 'string' || !isStrictIsoUtcTimestamp(obj.since))) {
    return { ok: false, reason: 'invalid-since' };
  }
  const value: ProfileRequestPayload =
    typeof obj.since === 'string' ? { type: 'profile-request', since: obj.since } : { type: 'profile-request' };
  return { ok: true, value };
}

// ── profile-announce wire shape (AC-PROF-6a seam contract) ──────────────────

/**
 * The `profile-announce` rumor content shape (spec.md §4). `avatar` is never
 * null in this type by construction — `parseProfileAnnounce` classifies
 * `avatar: null`, an absent `avatar` key, or an absent `avatar.imageUrl` as a
 * distinct malformed result (see below) and never returns a `ParseResult`
 * with `ok: true` for such a payload, so a value of this type handed to a
 * caller always has a real avatar.
 */
export type ProfileAnnouncePayload = {
  type: 'profile-announce';
  nickname: string;
  avatar: { imageUrl: string };
  /** ISO-8601 timestamp, stamped at serialization (answer) time — never the profile's last-edit time (spec.md §4, REVIEW B2). */
  updatedAt: string;
};

/**
 * Serialize a profile-announce payload for the rumor `content` field.
 *
 * `updatedAt` is stamped here, at call time (`new Date().toISOString()`),
 * mirroring `profileSync.ts#buildPayloadJson`'s answer-time precedent — the
 * caller (send.ts) never passes its own `updatedAt`, so a stale profile-edit
 * timestamp can never masquerade as the announce's `updatedAt`.
 *
 * Refuses to serialize (throws synchronously, before any rumor is
 * constructed) when `nickname` is empty/non-string, or `avatar` is
 * null/absent/not-an-object, or `avatar.imageUrl` is empty/non-string
 * (AC-PROF-6a's encoder half). `avatar`'s parameter type intentionally
 * widens to include `null`/`undefined` — narrower than the exported
 * `ProfileAnnouncePayload['avatar']` type — precisely so this runtime guard
 * is reachable or testable even from a caller that has bypassed static
 * typing (e.g. a value threaded through `JSON.parse` upstream); the
 * documented public contract for a well-typed caller is `{ imageUrl: string }`.
 */
export function encodeProfileAnnounce(input: {
  nickname: string;
  avatar: { imageUrl: string } | null | undefined;
}): string {
  if (typeof input.nickname !== 'string' || input.nickname.length === 0) {
    throw new Error('dmProfile/kinds: encodeProfileAnnounce nickname must be a non-empty string');
  }
  if (new TextEncoder().encode(input.nickname).length > NICKNAME_MAX_BYTES) {
    throw new Error(`dmProfile/kinds: encodeProfileAnnounce nickname exceeds ${NICKNAME_MAX_BYTES} UTF-8 bytes`);
  }
  if (input.avatar == null || typeof input.avatar !== 'object') {
    throw new Error('dmProfile/kinds: encodeProfileAnnounce refuses to serialize a null/absent avatar');
  }
  const imageUrl = (input.avatar as { imageUrl?: unknown }).imageUrl;
  const problem = avatarImageUrlProblem(imageUrl);
  if (problem === 'invalid') {
    throw new Error('dmProfile/kinds: encodeProfileAnnounce refuses to serialize an avatar with a missing imageUrl');
  }
  if (problem === 'too-long') {
    throw new Error(`dmProfile/kinds: encodeProfileAnnounce avatar.imageUrl exceeds ${AVATAR_IMAGE_URL_MAX_LENGTH} characters`);
  }
  if (problem === 'invalid-scheme') {
    throw new Error('dmProfile/kinds: encodeProfileAnnounce refuses an avatar.imageUrl outside the https:// / // scheme allow-list');
  }
  const payload: ProfileAnnouncePayload = {
    type: 'profile-announce',
    nickname: input.nickname,
    // avatarImageUrlProblem returned null, so imageUrl is a non-empty string.
    avatar: { imageUrl: imageUrl as string },
    updatedAt: new Date().toISOString(),
  };
  return JSON.stringify(payload);
}

/**
 * Parse + validate a profile-announce rumor's `content` string.
 *
 * Classifies as malformed (`ok: false`), never as a usable value: invalid
 * JSON, non-object content, a `type` other than `'profile-announce'`, an
 * empty/non-string/over-length `nickname`, an `updatedAt` that is not a
 * strict ISO-8601 UTC timestamp (`isStrictIsoUtcTimestamp` —
 * gate-remediation sev 5: a loosely-validated `updatedAt` such as `"zzzz"`
 * would sort after every real timestamp and win every future LWW compare in
 * `contactCache.ts`, AC-PROF-10, permanently pinning a stale/empty avatar),
 * and — AC-PROF-6a's central requirement — `avatar: null`, an absent
 * `avatar` key, or an `avatar` object whose `imageUrl` is empty/non-string/
 * over-length/outside the `https://` or `//` scheme allow-list. The
 * malformed result's `reason` distinguishes `'avatar-missing'` (null or
 * absent avatar) from `'avatar-imageUrl-invalid'` / `'avatar-imageUrl-too-
 * long'` / `'avatar-imageUrl-invalid-scheme'` (avatar present but its
 * imageUrl fails a specific check) for caller diagnostics, but all are
 * equally `ok: false` — none is ever treated as a "never announced" signal
 * the receive path could confuse with an actual empty-avatar contact state
 * (§3.1 REVIEW G1/G2).
 *
 * Like `parseProfileRequest`, always returns a freshly-constructed literal
 * object on success — never the raw parsed value — so extra/unexpected keys
 * on the wire (including prototype-pollution attempts) are dropped rather
 * than propagated.
 */
export function parseProfileAnnounce(content: string): ParseResult<ProfileAnnouncePayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'profile-announce') {
    return { ok: false, reason: 'wrong-type' };
  }
  if (typeof obj.nickname !== 'string' || obj.nickname.length === 0) {
    return { ok: false, reason: 'invalid-nickname' };
  }
  if (new TextEncoder().encode(obj.nickname).length > NICKNAME_MAX_BYTES) {
    return { ok: false, reason: 'nickname-too-long' };
  }
  if (typeof obj.updatedAt !== 'string' || !isStrictIsoUtcTimestamp(obj.updatedAt)) {
    return { ok: false, reason: 'invalid-updatedAt' };
  }
  // AC-PROF-6a: avatar:null / absent avatar is a distinct malformed outcome,
  // never a value the receive path could hand to contactCache.ts's write
  // function, and never confused with a legitimate "no avatar yet" state.
  if (obj.avatar == null || typeof obj.avatar !== 'object' || Array.isArray(obj.avatar)) {
    return { ok: false, reason: 'avatar-missing' };
  }
  const imageUrl = (obj.avatar as Record<string, unknown>).imageUrl;
  const problem = avatarImageUrlProblem(imageUrl);
  if (problem !== null) {
    return { ok: false, reason: `avatar-imageUrl-${problem}` };
  }
  const value: ProfileAnnouncePayload = {
    type: 'profile-announce',
    nickname: obj.nickname,
    // avatarImageUrlProblem returned null, so imageUrl is a non-empty string.
    avatar: { imageUrl: imageUrl as string },
    updatedAt: obj.updatedAt,
  };
  return { ok: true, value };
}
