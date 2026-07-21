/**
 * receive.ts — Inbound dispatch for the DM profile-exchange channel (epic:
 * direct-contact-profile-exchange, story 04, the security core).
 *
 * Two dispatch arms, `handleProfileRequest` and `handleProfileAnnounce`, each
 * reached EXCLUSIVELY via `directMessages.ts#unwrapAndOpen` — never
 * `welcomeSubscription.ts#unwrapGiftWrap` (AC-PROF-5, spec.md §4.2). This
 * module does not itself call `unwrapAndOpen`: it takes the already
 * strict-unwrapped, authenticated rumor plus a `senderHex` the caller (story
 * 05's watcher) derives from that same authenticated `rumor.pubkey`. Every
 * function below re-derives and re-asserts the authenticated sender from
 * `rumor.pubkey` itself and DROPS SILENTLY on any mismatch with the supplied
 * `senderHex` — defense in depth: even if a future caller ever wired an
 * unauthenticated `senderHex` in by mistake, a forged binding still cannot
 * reach a gate, a cache write, or a schedule mutation (AC-PROF-5's hard
 * requirement, verified by a forged-wrap unit test in receive.test.ts that
 * constructs a real NIP-59 wrap whose sealed rumor claims a different pubkey
 * than the seal's authenticated signer).
 *
 * ## The disclosure gate (spec.md §3.3/§3.5, AC-PROF-3/4/4b)
 *
 * Both arms share ONE predicate, {@link passesDisclosureGate}:
 * `isAllowedDmSender(...)` (walledGarden.ts, pure — does NOT consult
 * `archivedAt`) AND an active, non-archived contact already on file in
 * `contacts.ts`'s store (a SEPARATE explicit layer on top, because
 * `knownPeers` is append-only, ADR-005). A stranger, or an archived
 * contact, fails the gate in every direction — no answer, no accepted
 * announce, no contact-list mutation, no schedule mutation — and archiving/
 * unarchiving flips the outcome live (AC-PROF-4b) because the check reads
 * live storage on every call rather than caching a snapshot.
 *
 * ## The neutralized write + LWW + schedule wiring (AC-PROF-4/6/10)
 *
 * The announce arm never calls `contactCache.ts#writeContactEntry` (which
 * unconditionally injects a new contact via `rememberContact`) — it calls
 * the neutralized `writeContactEntryNeutralized` this story adds alongside
 * it, then routes the schedule side effect off that write's `{lwwWon,
 * avatarNonNull}` via {@link decideScheduleAction}: a completing write
 * (`scheduler.ts#isCompletingAnnounce`) clears the schedule; an LWW-losing
 * or idempotent-repeat write touches nothing; the `mark-incomplete` branch
 * is wired for scheduler-contract completeness (AC-PROF-11a) though
 * currently unreachable via THIS story's own call site, since
 * `kinds.ts#parseProfileAnnounce` already classifies every null/absent
 * avatar as malformed before this arm ever constructs a write payload —
 * see that function's doc for the full explanation.
 *
 * ## Rate-limiting (AC-PROF-13)
 *
 * The request arm keeps an in-memory, per-authenticated-sender cooldown
 * (>= the 1h floor). Not persisted — a page reload resets it, which mirrors
 * this feature's existing tolerance for multi-tab/no-lock duplication
 * (spec.md §5).
 */

import type NDK from '@nostr-dev-kit/ndk';
import type { UnsignedRumor } from '@/src/lib/directMessages';
import type { Group, UserProfile } from '@/src/types';
import {
  DM_PROFILE_REQUEST_KIND,
  DM_PROFILE_ANNOUNCE_KIND,
  parseProfileRequest,
  parseProfileAnnounce,
} from '@/src/lib/dmProfile/kinds';
import { sendProfileAnnounce, type ProfileSendKeys } from '@/src/lib/dmProfile/send';
import {
  deleteSchedule,
  loadSchedule,
  saveSchedule,
  markAnsweredIncomplete,
  isCompletingAnnounce,
} from '@/src/lib/dmProfile/scheduler';
import { writeContactEntryNeutralized } from '@/src/lib/contactCache';
import { readStoredContacts } from '@/src/lib/contacts';
import { isAllowedDmSender } from '@/src/lib/walledGarden';
import { createLogger } from '@/src/lib/logger';

const logger = createLogger('dm-profile-receive');

/** >= the 1h floor (AC-PROF-13). In-memory only — see file header doc. */
export const RATE_LIMIT_COOLDOWN_SECONDS = 3600;

function defaultNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Disclosure gate (spec.md §3.3/§3.5) ─────────────────────────────────────

/** The live state `isAllowedDmSender` needs, supplied by the caller (story 05's watcher) — this module never reads it from a React context or singleton. */
export type DisclosureGateContext = {
  groups: ReadonlyArray<Group>;
  knownPeers: ReadonlySet<string>;
  ownPubkeyHex: string;
};

function isActiveNonArchivedContact(pubkeyHex: string): boolean {
  const lower = pubkeyHex.toLowerCase();
  const stored = readStoredContacts();
  const match = Object.entries(stored).find(([key]) => key.toLowerCase() === lower);
  if (!match) return false;
  const [, contact] = match;
  return !contact.archivedAt;
}

/**
 * The single §3.3/§3.5 predicate shared by both dispatch arms:
 * `isAllowedDmSender` AND an active, non-archived contact already present
 * in `contacts.ts`'s store. Exported so a test can independently exercise
 * each failing half (allowed-but-archived; active-but-not-allowed).
 */
export function passesDisclosureGate(senderHex: string, ctx: DisclosureGateContext): boolean {
  if (!isAllowedDmSender(senderHex, ctx.groups, ctx.knownPeers, ctx.ownPubkeyHex)) return false;
  return isActiveNonArchivedContact(senderHex);
}

// ── Request arm (AC-PROF-3, AC-PROF-12, AC-PROF-13) ─────────────────────────

export type ProfileRequestHandlerContext = DisclosureGateContext & {
  ndk: NDK;
  keys: ProfileSendKeys;
  /** The caller's current local profile, BEFORE ensureAvatar backfill — sendProfileAnnounce runs that itself. */
  localProfile: UserProfile;
};

const lastAnsweredAtBySender = new Map<string, number>();

function withinCooldown(senderHex: string, nowSec: number): boolean {
  const last = lastAnsweredAtBySender.get(senderHex);
  return last !== undefined && nowSec - last < RATE_LIMIT_COOLDOWN_SECONDS;
}

/**
 * Handle an inbound, already strict-unwrapped `profile-request` rumor.
 *
 * Answers ONLY when: `senderHex` matches the authenticated `rumor.pubkey`
 * (defense in depth, see file header); `rumor.kind` is
 * `DM_PROFILE_REQUEST_KIND`; the content parses (`parseProfileRequest`);
 * the disclosure gate passes (AC-PROF-3); and the per-sender cooldown has
 * elapsed (AC-PROF-13). On all of the above, calls
 * `send.ts#sendProfileAnnounce` addressed to the AUTHENTICATED sender
 * (never a rumor-claimed identity) and records the cooldown timestamp
 * UNLESS the result is `'deferred-nameless'` (AC-PROF-12 — a nameless
 * owner's non-answer must not consume the cooldown, so the very next
 * request after a name is set can still be answered promptly).
 *
 * `nowSec` is an injectable clock (defaults to real time) so tests can
 * assert the cooldown boundary deterministically.
 */
export async function handleProfileRequest(
  rumor: UnsignedRumor,
  senderHex: string,
  ctx: ProfileRequestHandlerContext,
  nowSec: number = defaultNowSec(),
): Promise<void> {
  const authenticatedSenderHex = rumor.pubkey.toLowerCase();
  if (senderHex.toLowerCase() !== authenticatedSenderHex) {
    logger.info('dm-profile:sender-mismatch-dropped', { arm: 'request' });
    return;
  }
  if (rumor.kind !== DM_PROFILE_REQUEST_KIND) return;

  const parsed = parseProfileRequest(rumor.content);
  if (!parsed.ok) return;

  if (!passesDisclosureGate(authenticatedSenderHex, ctx)) return; // AC-PROF-3 / AC-PROF-4b

  if (withinCooldown(authenticatedSenderHex, nowSec)) return; // AC-PROF-13

  const result = await sendProfileAnnounce({
    ndk: ctx.ndk,
    recipientPubkeyHex: authenticatedSenderHex,
    keys: ctx.keys,
    localProfile: ctx.localProfile,
  });

  if (result.result !== 'deferred-nameless') {
    lastAnsweredAtBySender.set(authenticatedSenderHex, nowSec);
  }
}

/** Test-only reset of the in-memory rate-limit map, mirroring this repo's `_reset*ForTests` convention. */
export function _resetProfileRequestRateLimitForTests(): void {
  lastAnsweredAtBySender.clear();
}

// ── Announce arm (AC-PROF-4, AC-PROF-4b, AC-PROF-5, AC-PROF-6, AC-PROF-10) ──

export type ProfileAnnounceHandlerContext = DisclosureGateContext;

/**
 * Pure routing predicate factored out of {@link handleProfileAnnounce} so it
 * is unit-testable without the parser/gate/storage stack: `'clear'` iff
 * `scheduler.ts#isCompletingAnnounce({lwwWon, avatarNonNull})`; else
 * `'mark-incomplete'` iff the write landed (`lwwWon`) but left the avatar
 * empty (AC-PROF-11a); else `'none'` (an LWW-losing or idempotent-repeat
 * write, AC-PROF-10).
 */
export function decideScheduleAction(writeResult: {
  lwwWon: boolean;
  avatarNonNull: boolean;
}): 'clear' | 'mark-incomplete' | 'none' {
  if (isCompletingAnnounce({ lwwWon: writeResult.lwwWon, avatarNonNull: writeResult.avatarNonNull })) {
    return 'clear';
  }
  if (writeResult.lwwWon && !writeResult.avatarNonNull) {
    return 'mark-incomplete';
  }
  return 'none';
}

/**
 * Handle an inbound, already strict-unwrapped `profile-announce` rumor.
 *
 * Same senderHex-vs-rumor.pubkey defense-in-depth drop as
 * {@link handleProfileRequest}. Drops on wrong `rumor.kind` or a
 * `parseProfileAnnounce` failure — INCLUDING a malformed/null/absent avatar
 * (AC-PROF-6a) — before ever evaluating the gate or touching storage. On
 * gate pass (AC-PROF-4/4b), writes via
 * `contactCache.ts#writeContactEntryNeutralized` keyed under the
 * AUTHENTICATED sender (never a rumor-claimed identity), then applies
 * {@link decideScheduleAction} to the write result: `'clear'` deletes the
 * schedule; `'mark-incomplete'` loads the existing schedule (if any),
 * transitions it via `scheduler.ts#markAnsweredIncomplete`, and saves it
 * back; `'none'` touches no schedule.
 *
 * Returns `true` iff the contact cache was actually updated (the announce won
 * LWW and stored new nickname/avatar) — the caller uses this to drive the live
 * contacts change-signal (epic: contacts-live-updates) only when a displayed
 * value really changed. Every drop/no-win path returns `false`.
 */
export async function handleProfileAnnounce(
  rumor: UnsignedRumor,
  senderHex: string,
  ctx: ProfileAnnounceHandlerContext,
): Promise<boolean> {
  const authenticatedSenderHex = rumor.pubkey.toLowerCase();
  if (senderHex.toLowerCase() !== authenticatedSenderHex) {
    logger.info('dm-profile:sender-mismatch-dropped', { arm: 'announce' });
    return false;
  }
  if (rumor.kind !== DM_PROFILE_ANNOUNCE_KIND) return false;

  const parsed = parseProfileAnnounce(rumor.content);
  if (!parsed.ok) return false; // AC-PROF-6a: malformed (incl. avatar null/absent) — never stored, schedule untouched

  if (!passesDisclosureGate(authenticatedSenderHex, ctx)) return false; // AC-PROF-4 / AC-PROF-4b

  const writeResult = writeContactEntryNeutralized(authenticatedSenderHex, {
    nickname: parsed.value.nickname,
    avatar: parsed.value.avatar,
    updatedAt: parsed.value.updatedAt,
  });

  const action = decideScheduleAction(writeResult);
  if (action === 'clear') {
    await deleteSchedule(authenticatedSenderHex);
  } else if (action === 'mark-incomplete') {
    const existingSchedule = await loadSchedule(authenticatedSenderHex);
    if (existingSchedule) {
      await saveSchedule(markAnsweredIncomplete(existingSchedule));
    }
  }
  return writeResult.lwwWon;
}
