/**
 * Welcome subscription — subscribes to kind 1059 (NIP-59 gift-wrapped Welcome messages)
 * addressed to the local user's pubkey.
 *
 * On receiving a gift wrap, unwraps the NIP-59 envelope to extract the inner kind 444
 * Welcome rumor, then passes it to MarmotClient.joinGroupFromWelcome().
 * On success, persists the group to overlay storage and notifies the caller.
 *
 * Also handles kind 21059 (join request) rumors after unwrapping — dispatches to
 * the join request handler for nonce validation, dedup, and persistence.
 */

import type { Group } from '@/src/types';
import { DEFAULT_RELAYS, STORAGE_KEYS } from '@/src/types';
import { saveGroup } from './groupStorage';
import type { EventSigner } from 'applesauce-core';
import { verifyEvent, getEventHash } from 'nostr-tools/pure';
import {
  getGroupMembers,
  getWelcome,
  getWelcomeKeyPackageRefs,
  readWelcomeMarmotGroupData,
  readWelcomeGroupInfo,
} from '@internet-privacy/marmot-ts';
import { bytesToHex, hexToBytes } from '@/src/lib/nostrKeys';
import { createRumor } from 'nostr-tools/nip59';
import { sealAndWrap } from '@/src/lib/directMessages';
import { EpochResolver } from './epochResolver';
import { handleJoinRequest, JOIN_REQUEST_KIND } from './joinRequestHandler';
import type { JoinRequestReceivedCallback } from './joinRequestHandler';
import {
  enqueuePendingInvitation,
  removePendingInvitation,
  countPendingInvitations,
  listPendingInvitations,
} from '@/src/lib/pendingInvitations';
import type { PendingInvitation } from '@/src/lib/pendingInvitations';
import {
  loadUnexpiredOutboundJoinRequestsForAdmin,
  deleteOutboundJoinRequest,
} from './outboundJoinRequests';
import type { OutboundJoinRequestRecord } from './outboundJoinRequests';
import { handlePairingAck } from '@/src/lib/pairing/pairingAck';
import { incrementPendingContact } from '@/src/lib/unreadStore';
import { createLogger } from '@/src/lib/logger';
import { isPendingMemberImpl, cancelPendingInvitationImpl, type Deps as CancelInvitationDeps } from './cancelInvitationImpl';

const logger = createLogger('welcomeSubscription');

/** NIP-59 seal kind — matches directMessages.ts's SEAL_KIND constant. */
const SEAL_KIND = 13;

// ── Decline DM channel (S5, creates_seam) ───────────────────────────────────
//
// INVITE_DECLINE_KIND is a fresh app-level inner rumor kind for the B→A
// gift-wrapped decline DM. Exported so S6's receive-side branch imports this
// SAME constant rather than redefining its own copy.
//
// Verified distinct from every existing `*_KIND` sentinel this codebase
// checks or defines (repo-wide grep for `_KIND` immediately before
// assignment): 444 (Welcome), 5 (delete signal), 7 (reaction), 9
// (CHAT_MESSAGE_KIND, chatPersistence.ts), 13 (seal), 14 (CHAT_MESSAGE_KIND,
// directMessages.ts), 21059 (JOIN_REQUEST_KIND / CALL_GIFT_WRAP_KIND), 21060
// (PAIRING_ACK_KIND), 21061/21062 (DM_PROFILE_REQUEST_KIND /
// DM_PROFILE_ANNOUNCE_KIND), 20602 (CARD_SIG_KIND_V2), 25050-25055
// (call-signaling), 10/11/12 (POLL_*_KIND), 30 (PROFILE_REQUEST_KIND,
// marmot/profileRequestSync.ts), 30051 (RELAY_LIST_KIND), 30078
// (BACKUP_EVENT_KIND), 0 (PROFILE_RUMOR_KIND). Mirrors pairingAck.ts /
// dmProfile/kinds.ts's module-load throw-on-collision pattern: fail loudly
// at import time, not only in a test, if this constant is ever edited to
// collide with a reserved sentinel.
export const INVITE_DECLINE_KIND = 21063 as const;

const INVITE_DECLINE_SENTINEL_KINDS = [
  444, 5, 7, 9, 13, 14, 21059, 21060, 21061, 21062, 20602,
  25050, 25051, 25052, 25053, 25054, 25055,
  10, 11, 12, // POLL_OPEN_KIND / POLL_VOTE_KIND / POLL_CLOSE_KIND
  30078, // BACKUP_EVENT_KIND
  30051, // RELAY_LIST_KIND
  30, // PROFILE_REQUEST_KIND (marmot/profileRequestSync.ts)
  0, // PROFILE_RUMOR_KIND (marmot/profileSync.ts)
] as const;

if ((INVITE_DECLINE_SENTINEL_KINDS as readonly number[]).includes(INVITE_DECLINE_KIND)) {
  throw new Error('welcomeSubscription: INVITE_DECLINE_KIND collides with a reserved sentinel kind');
}

/**
 * The seam contract (stories.json#seams[1], consumed by S6). The EXACT and
 * ONLY shape of a decline gift wrap's inner rumor plaintext content
 * (AC-DECLINE-13) — no nickname, avatar, or other profile metadata.
 */
export type DeclineGiftWrapPayload = {
  /** MLS group id (hex) — the group the declined invitation was for. */
  groupId: string;
  /** The declining invitee's own pubkey (hex). */
  pubkey: string;
};

/** Explicit key/transport params for sending a decline gift wrap — never a module-level singleton. */
export type DeclineSendKeys = {
  ndk: import('@nostr-dev-kit/ndk').default;
  selfPubkeyHex: string;
  selfPrivateKeyHex: string;
};

// ── Decline DM channel — A-side receive (S6, decline-a) ─────────────────────
//
// Dependencies the receive-side dispatch branch needs to tree-gate, Remove,
// post the `declined` announcement, and clear the pending-direct-invite
// marker. Extends cancelInvitationImpl.ts's `Deps` (the SAME Remove
// machinery, ADR-010) with the two extra capabilities that machinery doesn't
// own: posting into an ARBITRARY group by id (this is a background listener,
// not scoped to one open group's UI), and clearing the marker (owned by
// pendingDirectInviteStorage.ts, consumed here only via injection per
// architecture.md's boundary rule — never imported directly).
export type DeclineReceiveDeps = CancelInvitationDeps & {
  /** Posts `content` as an application rumor into `groupId`. */
  sendAnnouncement: (groupId: string, content: string) => Promise<void>;
  /** Clears the pending-direct-invite marker for (groupId, pubkey). */
  clearPendingDirectInvite: (groupId: string, pubkey: string) => Promise<void>;
};

// ── Per-group historical-sync gate (S6, DD-10/AC-DECLINE-12) ────────────────
//
// subscribeToWelcomes' single kind-1059 subscription and each group's
// subscribeToGroupMessages historical-sync fetch are independent async flows
// that can complete in either order at app start. sendApplicationRumor (the
// Remove+post below) is only epoch-safe once a group's local MLS epoch is
// caught up (see subscribeToGroupMessages' onHistorySynced comment) — so a
// decline referencing a not-yet-synced group must defer until that SPECIFIC
// group's sync completes. This is a bounded, per-groupId waiter list: each
// entry is drained and removed the moment its group syncs (never more than
// one entry per groupId, and it never grows across restarts — it lives only
// for this session), NOT a new persistent/unbounded queue. A crash/restart
// before a group ever syncs falls back to the gift wrap's own unmarked-seen
// reprocessing (DD-7 guarantee #3) — see subscribeToWelcomes' decline branch.
const historySyncedGroupIds = new Set<string>();
const historySyncWaiters = new Map<string, Array<() => void>>();

function markGroupHistorySynced(groupId: string): void {
  historySyncedGroupIds.add(groupId);
  const waiters = historySyncWaiters.get(groupId);
  if (!waiters) return;
  historySyncWaiters.delete(groupId);
  for (const resolveWaiter of waiters) {
    try {
      resolveWaiter();
    } catch (err) {
      console.debug('[welcomeSubscription] history-sync waiter callback failed:', err);
    }
  }
}

/**
 * Resolves once `groupId`'s historical kind-445 sync has completed —
 * immediately if it already has by the time this is called. Used ONLY by the
 * decline receive path (AC-DECLINE-12).
 */
function waitForGroupHistorySync(groupId: string): Promise<void> {
  if (historySyncedGroupIds.has(groupId)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = historySyncWaiters.get(groupId) ?? [];
    list.push(resolve);
    historySyncWaiters.set(groupId, list);
  });
}

// ── Per-(groupId,pubkey) serialization for decline processing (S6, DD-7) ────
//
// Two GENUINELY DISTINCT decline gift wraps for the SAME invitee/group (e.g.
// B double-clicking Decline, producing two distinct-id wraps) can arrive and
// begin dispatch concurrently. A naive check-then-act (both check
// isPendingMemberImpl, see "still pending" because neither's Remove has
// committed yet, then both call cancelPendingInvitationImpl) could open a
// double-Remove/double-post window — the same class of bug
// pendingDirectInviteStorage.ts's consumePendingDirectInviteMarker closes for
// the accept-producer path (S3 gate-remediation). This mirrors that exact
// per-key promise-chain pattern: a second call for the same key awaits the
// first call's FULL completion (tree-gate through marker-clear) before
// running its own tree-gate check, which by then correctly observes
// "no longer pending" and no-ops.
/**
 * Gate-remediation (post-review): the mark-gift-wrap-seen decision keys on
 * TERMINAL vs RETRYABLE, never on "was anything applied":
 *
 *   - 'applied'           — the Remove committed (the `declined` post is
 *                            best-effort and may or may not have landed —
 *                            see FIX A below). Mark seen.
 *   - 'terminal-noop'     — the tree-gate says this wrap can NEVER have an
 *                            effect (B not pending; A doesn't hold the
 *                            group at all). Mark seen — reprocessing this
 *                            SAME wrap again would reach the identical
 *                            verdict forever, and — worse — leaving it
 *                            unmarked lets it reactivate against a LATER,
 *                            unrelated re-invite of the same pubkey to the
 *                            same group (see the re-invite-reactivation
 *                            regression test).
 *   - 'retryable-failure' — the load-bearing MLS Remove commit itself threw.
 *                            Do NOT mark seen — B is still pending, so a
 *                            reprocess on next start can still succeed.
 */
type DeclineOutcome = 'applied' | 'terminal-noop' | 'retryable-failure';

const declineProcessingChains = new Map<string, Promise<DeclineOutcome>>();

async function runSerializedDeclineProcessing(
  key: string,
  fn: () => Promise<DeclineOutcome>,
): Promise<DeclineOutcome> {
  const prior = declineProcessingChains.get(key) ?? Promise.resolve<DeclineOutcome>('retryable-failure');
  const run: Promise<DeclineOutcome> = prior.catch((): DeclineOutcome => 'retryable-failure').then(fn);
  declineProcessingChains.set(key, run);
  try {
    return await run;
  } finally {
    if (declineProcessingChains.get(key) === run) {
      declineProcessingChains.delete(key);
    }
  }
}

/**
 * Applies an authenticated decline (AC-DECLINE-9/10/12): tree-gates on group
 * existence and pending membership, defers until the referenced group's
 * historical sync completes ONLY when there is something worth waiting for,
 * then — on a pending match — runs DD-7's Remove+post (reusing
 * cancelPendingInvitationImpl) followed by the marker-clear.
 *
 * Returns a {@link DeclineOutcome} so the caller can mark the gift wrap seen
 * on the correct TERMINAL-vs-RETRYABLE distinction (see the type doc above)
 * rather than on whether a Remove specifically happened:
 *
 *   - 'applied': the Remove committed. The `declined` announcement itself is
 *     BEST-EFFORT — exactly like `invited` (S2) and `accepted` (S3), both
 *     already fire-and-forget — so a failed post does NOT downgrade this to
 *     retryable: the Remove is the durable, load-bearing action, and once it
 *     has committed B is no longer pending, so a reprocess of this wrap
 *     could never re-attempt the post anyway (the tree-gate below would
 *     immediately terminal-no-op it). `cancelPendingInvitationImpl`'s
 *     `announcementError` field is logged, never treated as a reason to
 *     withhold mark-seen.
 *   - 'terminal-noop': tree-gate says B is not (or never was) a pending
 *     member of `groupId`, OR A does not currently hold `groupId` at all.
 *     Definitive either way — this SPECIFIC gift wrap will never have an
 *     effect, however many times it is reprocessed.
 *   - 'retryable-failure': the MLS Remove commit itself threw. Leave
 *     everything for reprocessing on next start — do not clear the marker,
 *     do not mark seen (B is still genuinely pending, so a retry can still
 *     succeed). This is the ONLY outcome that withholds mark-seen.
 *
 * `pubkeyLower` MUST be the AUTHENTICATED seal pubkey (unwrapResult.pubkey),
 * lowercased — never the decline payload's self-claimed `pubkey` field,
 * which this function never reads at all (mirrors the Welcome/join-request
 * branches' senderPubkey-only trust discipline).
 */
async function applyDecline(
  groupId: string,
  pubkeyLower: string,
  deps: DeclineReceiveDeps,
): Promise<DeclineOutcome> {
  // FIX C: guard group existence BEFORE deferring on historical sync.
  // waitForGroupHistorySync(groupId) only ever resolves via
  // markGroupHistorySynced(groupId), which subscribeToGroupMessages calls
  // ONLY for a group this client actually subscribes to (i.e. A holds it).
  // Awaiting the sync gate unconditionally — for a groupId A never joined,
  // already left, or that is simply attacker-supplied garbage — would park
  // this call (and its runSerializedDeclineProcessing chain entry) on a
  // waiter that NEVER fires, permanently leaking one Map entry per distinct
  // bogus groupId (attacker-amplifiable). Checking existence first, and only
  // deferring when there is something worth waiting for, closes this.
  const mlsGroupPreCheck = await deps.getGroup(groupId);
  if (!mlsGroupPreCheck) {
    // A does not currently hold this group at all — never joined it, or
    // already left/was removed. Terminal: no defer, no waiter created.
    return 'terminal-noop';
  }

  // AC-DECLINE-12 (DD-10): sendApplicationRumor is only epoch-safe once this
  // group's local MLS epoch is caught up with historical commits. Deferred
  // only now that the pre-check above has confirmed A actually holds the
  // group (so this WILL eventually resolve via markGroupHistorySynced).
  await waitForGroupHistorySync(groupId);

  // AC-DECLINE-9 (DD-4): re-checked HERE (not cached from dispatch time) —
  // this call may have just resumed after the history-sync await above, or
  // after a sibling decline for the same key finished its own Remove via the
  // serialization wrapper this function is always called through.
  const isPending = await isPendingMemberImpl(deps, groupId, pubkeyLower);
  if (!isPending) return 'terminal-noop'; // tree-gate says: never has an effect

  const result = await cancelPendingInvitationImpl(
    deps,
    groupId,
    pubkeyLower,
    (content) => deps.sendAnnouncement(groupId, content),
    'declined',
  );

  if (!result.ok) {
    // Remove failed outright (e.g. the MLS commit threw) — RETRYABLE: leave
    // everything for reprocessing on next start; do not clear the marker or
    // mark seen.
    return 'retryable-failure';
  }

  // FIX A: the Remove committed — that is the durable, load-bearing action.
  // The `declined` post is best-effort (like invited/accepted); a failed
  // post is logged but never downgrades this outcome to retryable — B is no
  // longer pending either way, so reprocessing this wrap could never retry
  // the post (the tree-gate above would immediately terminal-no-op it).
  if (result.announcementError) {
    logger.warn('dm:decline-announcement-failed', { reason: result.announcementError });
  }

  // (3) clear the pending-direct-invite marker for this invitee/group.
  try {
    await deps.clearPendingDirectInvite(groupId, pubkeyLower);
  } catch (err) {
    console.debug('[welcomeSubscription] decline marker-clear failed:', err);
  }

  return 'applied';
}

export type WelcomeReceivedCallback = (group: Group) => void | Promise<void>;

/** The unsigned inner rumor extracted from a NIP-59 gift wrap. */
export type UnwrappedRumor = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

/**
 * Result of an authenticated gift-wrap unwrap (S3 seam contract, consumed
 * directly by S4's auto-accept correlation — see
 * specs/epic-group-invite-link-onboarding/architecture.md "Seams").
 */
export interface AuthenticatedUnwrapResult {
  /**
   * The seal's pubkey — the ONLY trustworthy sender identity. ALWAYS
   * populated from the seal layer, regardless of `authenticated`; it is
   * NEVER the raw, self-claimed `rumor.pubkey` field. Callers MUST use this
   * field (not `rumor.pubkey`) for any trust decision.
   */
  pubkey: string;
  /**
   * True iff the seal's schnorr signature verifies AND `rumor.pubkey ===
   * seal.pubkey`. A value of `false` MUST NOT satisfy any trust decision —
   * in particular it must never be treated as a correlation match for
   * auto-accept (S4's AC-AUTO-4).
   */
  authenticated: boolean;
  /** The unsigned inner rumor as decrypted (NIP-59 rumors are never signed). */
  rumor: UnwrappedRumor;
}

/**
 * Unwrap a NIP-59 gift wrap event and authenticate its sender.
 *
 * Gift wrap (kind 1059) → decrypt → Seal (kind 13) → decrypt → Rumor (kind 444 / 21059)
 *
 * NIP-59 rumors are themselves UNSIGNED (no `sig` — see AC-AUTH-5); the seal
 * is what authenticates. This function therefore, matching `unwrapAndOpen`
 * (`directMessages.ts:230-274`):
 *   1. Decrypts the outer gift wrap using its ephemeral pubkey as counterparty.
 *   2. Verifies the seal's schnorr signature (`verifyEvent`) BEFORE trusting
 *      `seal.pubkey` as an identity (AC-AUTH-1).
 *   3. Decrypts the seal using `seal.pubkey` as counterparty to recover the rumor.
 *   4. Compares `rumor.pubkey === seal.pubkey` (AC-AUTH-2) — binding the
 *      rumor's self-claimed sender to the authenticated seal sender.
 *   5. Validates `rumor.id` against the canonical NIP-01 hash of
 *      (pubkey, created_at, kind, tags, content) — the same check
 *      `unwrapAndOpen` performs at `directMessages.ts:265-274`. Without this,
 *      a forged/tampered `id` would flow into `PendingInvitation.id`, the
 *      dedup key used by `enqueuePendingInvitation`/`removePendingInvitation`.
 *
 * Unlike `unwrapAndOpen`, a message that decrypts successfully but fails
 * step 2, step 4, or step 5 does NOT throw (AC-AUTH-3): it returns normally
 * with `authenticated: false` so the caller can degrade gracefully (a
 * Welcome falls back to the uncorrelated/pending path; a join request is
 * dropped).
 * Decryption/parse failures — a gift wrap not meant for this handler at all,
 * e.g. an ordinary DM sharing the same kind-1059 `#p` filter — still
 * propagate as a thrown error, unchanged from before.
 */
export async function unwrapGiftWrap(
  giftWrapEvent: { pubkey: string; content: string },
  signer: EventSigner,
): Promise<AuthenticatedUnwrapResult> {
  if (!signer.nip44?.decrypt) {
    throw new Error('Signer does not support NIP-44 decryption');
  }

  // Two-layer NIP-59 decryption. Each layer uses a different counterparty key:
  //   Layer 1: gift wrap pubkey is a random ephemeral key (prevents sender identification)
  //   Layer 2: seal pubkey is the sender's real key (proves authorship to recipient)
  // nip44.decrypt(theirPubkey, ciphertext) derives a shared secret from our
  // privkey + their pubkey, so each layer decrypts against a different shared secret.
  const sealJson = await signer.nip44.decrypt(giftWrapEvent.pubkey, giftWrapEvent.content);
  const seal = JSON.parse(sealJson);

  // AC-AUTH-1: verify the seal's schnorr signature BEFORE trusting seal.pubkey
  // for anything (as an ECDH counterparty below, or as a sender identity).
  // Also require kind===13 (matching unwrapAndOpen's explicit seal-kind
  // check) so a validly-signed event of a DIFFERENT kind cannot be replayed
  // here as a seal. verifyEvent recomputes the canonical NIP-01 hash and
  // checks the schnorr signature against seal.pubkey; it never throws — a
  // malformed/unsigned seal simply fails verification (returns false), which
  // is exactly the "no sig yet" shape the pre-AC-AUTH-0 hand-rolled seal
  // produced.
  const sealSignatureValid =
    typeof seal?.pubkey === 'string' && seal?.kind === SEAL_KIND && verifyEvent(seal);
  const sealPubkey = typeof seal?.pubkey === 'string' ? seal.pubkey : '';

  const emptyRumor: UnwrappedRumor = { id: '', pubkey: '', created_at: 0, kind: 0, tags: [], content: '', sig: '' };

  // Layer 2 decrypts using seal.pubkey as the ECDH counterparty. Because
  // NIP-44 authenticates via the shared secret, this can itself throw (e.g.
  // "invalid MAC") for an incoherent/malformed seal whose `pubkey` field
  // does not match whatever key actually produced `seal.content` — a shape
  // that AC-AUTH-1 has ALREADY rejected above (such a seal cannot carry a
  // valid signature over a pubkey that didn't sign it). Once layer 1 has
  // decrypted successfully (this message IS addressed to us at the gift-wrap
  // layer), AC-AUTH-3 requires we never throw past this point — a broken or
  // adversarial seal degrades to `authenticated: false`, never a thrown
  // error, so the caller's dispatch logic (kind-based routing) always runs.
  let parsed: { id?: unknown; pubkey?: unknown; created_at?: unknown; kind?: unknown; tags?: unknown; content?: unknown; sig?: unknown };
  try {
    const rumorJson = await signer.nip44.decrypt(seal.pubkey, seal.content);
    parsed = JSON.parse(rumorJson);
  } catch (err) {
    logger.info('dm:unwrap-seal-decrypt-failed', { reason: err instanceof Error ? err.message : 'unknown' });
    return { pubkey: sealPubkey, authenticated: false, rumor: emptyRumor };
  }

  const rumor: UnwrappedRumor = {
    id: typeof parsed.id === 'string' ? parsed.id : '',
    pubkey: typeof parsed.pubkey === 'string' ? parsed.pubkey : '',
    created_at: typeof parsed.created_at === 'number' ? parsed.created_at : 0,
    kind: typeof parsed.kind === 'number' ? parsed.kind : 0,
    tags: Array.isArray(parsed.tags) ? (parsed.tags as string[][]) : [],
    content: typeof parsed.content === 'string' ? parsed.content : '',
    sig: typeof parsed.sig === 'string' ? parsed.sig : '',
  };

  // AC-AUTH-2: the rumor's self-claimed sender must match the authenticated
  // seal sender. Without this, an attacker could seal a rumor claiming
  // pubkey:alice while signing the seal with their own (different) key.
  const senderBound = rumor.pubkey === sealPubkey;

  // Step 5 (matching unwrapAndOpen, directMessages.ts:265-274): the rumor's
  // own `id` must be the canonical NIP-01 hash of its (pubkey, created_at,
  // kind, tags, content). Unlike verifyEvent, nostr-tools' getEventHash DOES
  // throw for a malformed event (e.g. `pubkey` not matching the 64-hex-char
  // shape, which the typeof coercions above don't guarantee) — AC-AUTH-3
  // requires this function never throw past the initial gift-wrap decrypt,
  // so a throw here is caught and treated as a failed check, same fail-closed
  // shape as sealSignatureValid above. This matters because `rumor.id` flows
  // into `PendingInvitation.id`, the dedup key
  // `enqueuePendingInvitation`/`removePendingInvitation` key off — a forged
  // id could not forge sender identity (that's steps 2/4), but could still
  // corrupt dedup bookkeeping.
  let rumorIdValid: boolean;
  try {
    rumorIdValid = rumor.id === getEventHash(rumor);
  } catch {
    rumorIdValid = false;
  }

  return {
    // Always the seal's pubkey (AC-SEC-3) — never rumor.pubkey, which is
    // attacker-controllable independent of whether the seal itself verifies.
    pubkey: sealPubkey,
    authenticated: sealSignatureValid && senderBound && rumorIdValid,
    rumor,
  };
}

// ---------------------------------------------------------------------------
// Shared join core (S4, AC-AUTO-2 / AC-AUTO-5)
//
// Both the manual-accept path (acceptPendingInvitation, below) and the
// auto-accept path (inside subscribeToWelcomes's event handler) route
// through this single function to actually join the MLS group and persist
// the overlay Group record — so knownPeers population and every other
// downstream effect are IDENTICAL regardless of which path triggered the
// join. Each caller owns its OWN bookkeeping cleanup afterward (the pending-
// invitation queue for manual accept; the outbound-record store for auto-
// accept) — those are different stores with different semantics, so they
// are deliberately NOT folded into this shared core. What IS shared, and
// matters for AC-AUTO-2's "no second click, matching a manual accept"
// guarantee, is the MLS join + Group-persist sequence itself.
// ---------------------------------------------------------------------------

/**
 * Joins the MLS group from a decrypted Welcome rumor and persists the
 * resulting overlay `Group` record. Does NOT touch any pending-invitation
 * queue or outbound-record store — callers handle their own cleanup, which
 * lets a never-enqueued Welcome (auto-accept) join directly without an
 * enqueue-then-immediately-dequeue detour (AC-AUTO-2).
 *
 * Throws on MLS failure — callers are responsible for translating that into
 * their own fallback behavior.
 */
async function joinGroupFromWelcomeCore(
  welcomeRumor: unknown,
  marmotClient: import('@internet-privacy/marmot-ts').MarmotClient,
): Promise<Group> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { group: mlsGroup } = await marmotClient.joinGroupFromWelcome({ welcomeRumor: welcomeRumor as any });

  const groupData = mlsGroup.groupData;
  const groupName = groupData?.name ?? 'Unnamed Group';
  const groupRelays = mlsGroup.relays ?? [...DEFAULT_RELAYS];

  const joinedGroup: Group = {
    id: mlsGroup.idStr,
    name: groupName,
    createdAt: Date.now(),
    memberPubkeys: getGroupMembers(mlsGroup.state),
    relays: groupRelays,
  };

  await saveGroup(joinedGroup);
  return joinedGroup;
}

// ---------------------------------------------------------------------------
// Auto-accept correlation (S4)
// ---------------------------------------------------------------------------

/**
 * Reads the Welcome's pre-join Marmot group data (name, description, admin
 * pubkeys) WITHOUT joining. Mirrors the key-package matching loop
 * `MarmotClient.readInviteGroupInfo` uses internally, but calls
 * `readWelcomeMarmotGroupData` directly (rather than `readWelcomeGroupInfo`)
 * so the decoded Marmot Group Data extension is actually populated; the
 * client's own `readInviteGroupInfo` convenience method returns a
 * `GroupInfo` whose `extensions` array is unconditionally empty in the
 * current marmot-ts release, which would make disambiguation (and, for
 * inline invitation cards, the preview) always fail.
 *
 * Returns `null` on ANY failure (no local key package matches this
 * Welcome's recipient slots, the extension is absent, or the Welcome cannot
 * be decoded) — never throws. A `null` result degrades disambiguation to
 * "cannot determine" so callers correctly treat it as zero matches
 * (AC-AUTO-4a: zero-or-multiple matches => uncorrelated => AC-AUTO-3; and
 * AC-DATA-2: an undecodable Welcome renders without group data), never as a
 * false match.
 *
 * Side-effect verdict (confirmed by marmot-protocol domain review): this
 * function, and the marmot-ts calls it makes (`getWelcome`,
 * `getWelcomeKeyPackageRefs`, `readWelcomeMarmotGroupData`), are SIDE-EFFECT-
 * FREE for a pre-join read. The key-package "burn" (`keyPackages.markUsed`)
 * and MLS state adoption (`groups.adoptClientState`) live ONLY in
 * `MarmotClient.joinGroupFromWelcome` (the actual join path) and are not
 * reachable from here. Underneath, `readWelcomeMarmotGroupData` bottoms out
 * in ts-mls's `joinGroup`, which is a pure function that returns a fresh
 * `ClientState` without mutating its inputs or touching persistent storage.
 * So calling this repeatedly — including for a Welcome the local key package
 * owner never actually joins — is safe and does not consume anything. Do not
 * re-litigate this without re-checking `joinGroupFromWelcome`'s call graph
 * first. Efficiency caveat: each call re-derives a full `ClientState` just to
 * read the extension, which is heavier than ideal though cryptographically
 * inert.
 */
export async function readPreJoinGroupData(
  welcomeRumor: UnwrappedRumor,
  marmotClient: import('@internet-privacy/marmot-ts').MarmotClient,
): Promise<{ name: string; description: string; adminPubkeys: string[]; groupId: string } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const welcome = getWelcome(welcomeRumor as any);
    const refs = getWelcomeKeyPackageRefs(welcome);
    for (const ref of refs) {
      const stored = await marmotClient.keyPackages.get(ref);
      if (!stored?.privatePackage) continue;
      try {
        const ciphersuiteImpl = await marmotClient.cryptoProvider.getCiphersuiteImpl(
          stored.publicPackage.cipherSuite,
        );
        const groupData = await readWelcomeMarmotGroupData({
          welcome,
          keyPackage: stored,
          ciphersuiteImpl,
        });
        if (groupData) {
          // AC-DECLINE-1: surface the MLS groupId. readWelcomeMarmotGroupData
          // is a convenience wrapper over readWelcomeGroupInfo that extracts
          // ONLY the MarmotGroupData extension, discarding groupContext —
          // call readWelcomeGroupInfo directly (same welcome/keyPackage/
          // ciphersuite that just matched above) to recover groupContext.groupId.
          // Side-effect-free per this function's doc comment — both calls
          // bottom out in pure ts-mls derivations.
          let groupId = '';
          try {
            const groupInfo = await readWelcomeGroupInfo({ welcome, keyPackage: stored, ciphersuiteImpl });
            groupId = bytesToHex(groupInfo.groupContext.groupId);
          } catch {
            // Matched for MarmotGroupData above but groupContext read failed —
            // degrade to '' rather than failing the whole pre-join read (name/
            // description/adminPubkeys are still valid and useful on their own).
          }
          return {
            name: groupData.name,
            description: groupData.description,
            adminPubkeys: groupData.adminPubkeys,
            groupId,
          };
        }
      } catch {
        // This key package doesn't match this Welcome's secrets — try the
        // next candidate ref (mirrors readInviteGroupInfo's own loop).
      }
    }
    return null;
  } catch (err) {
    logger.warn('dm:pre-join-group-data-read-failed', {
      reason: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/**
 * Convenience wrapper over {@link readPreJoinGroupData} for the AC-AUTO-4a
 * disambiguation call site, which only needs the group name. See
 * {@link readPreJoinGroupData}'s doc comment for the full side-effect-free
 * rationale and failure semantics — both apply here unchanged.
 */
export async function readPreJoinGroupName(
  welcomeRumor: UnwrappedRumor,
  marmotClient: import('@internet-privacy/marmot-ts').MarmotClient,
): Promise<string | null> {
  return (await readPreJoinGroupData(welcomeRumor, marmotClient))?.name ?? null;
}

/**
 * Resolves the SINGLE outbound-join-request record a correlated Welcome
 * should auto-accept and consume, or `null` if the Welcome is uncorrelated
 * (AC-AUTO-3's fallback path applies).
 *
 * Fail-closed at every step:
 *   - `unwrapResult.authenticated !== true` => null (AC-AUTO-4: a Welcome
 *     whose raw rumor.pubkey happens to match a record but whose seal
 *     authentication failed, or whose authenticated pubkey differs, is
 *     NEVER a correlation match — this is the ADR-002 guarantee).
 *   - Zero unexpired records for this admin => null (nothing to correlate).
 *   - Otherwise (one OR more unexpired records for this admin), the GROUP
 *     is always checked when the Welcome's pre-join group name is readable
 *     (AC-AUTO-4a, Amendment 1). There is NO single-candidate shortcut: a
 *     lone record whose stored `groupName` does not match the Welcome's
 *     actual group MUST NOT auto-accept — the prior shortcut here (return
 *     the sole candidate unconditionally) let an unrelated same-admin
 *     Welcome silently consume a record for a group the user never
 *     requested, which is the bug this amendment closes.
 *       - Group name readable: filter candidates to those whose stored
 *         `groupName` equals the Welcome's group name. Exactly one match
 *         => that record. Zero or multiple matches => null (never guess),
 *         even when there was only one candidate to begin with.
 *       - Group name NOT readable (null): fall back to admin-only match —
 *         exactly one unexpired candidate => that record; more than one
 *         candidate => null (cannot disambiguate => pending).
 */
async function resolveAutoAcceptRecord(
  unwrapResult: AuthenticatedUnwrapResult,
  welcomeRumor: UnwrappedRumor,
  marmotClient: import('@internet-privacy/marmot-ts').MarmotClient,
): Promise<OutboundJoinRequestRecord | null> {
  if (!unwrapResult.authenticated) return null;

  let candidates: OutboundJoinRequestRecord[];
  try {
    candidates = await loadUnexpiredOutboundJoinRequestsForAdmin(unwrapResult.pubkey);
  } catch {
    return null;
  }

  if (candidates.length === 0) return null;

  // AC-AUTO-4a (Amendment 1): the group check ALWAYS runs when the group
  // name is readable — including when there is only one candidate. No
  // single-candidate shortcut: a lone record for the wrong group must go
  // to pending and survive, not be silently consumed.
  const groupName = await readPreJoinGroupName(welcomeRumor, marmotClient);
  if (groupName !== null) {
    const nameMatches = candidates.filter((c) => c.groupName === groupName);
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }

  // Group name unreadable — fall back to admin-only match: exactly one
  // unexpired candidate for this admin auto-accepts; more than one is
  // ambiguous (cannot disambiguate without the group name) => uncorrelated.
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Start subscribing to kind 1059 events for the given pubkey.
 * Returns an unsubscribe function.
 */
export async function subscribeToWelcomes(
  pubkeyHex: string,
  marmotClient: import('@internet-privacy/marmot-ts').MarmotClient,
  ndk: import('@nostr-dev-kit/ndk').default,
  signer: EventSigner,
  onGroupJoined: WelcomeReceivedCallback,
  onJoinRequestReceived?: JoinRequestReceivedCallback,
  groupMemberPubkeys?: (groupId: string) => string[],
  ownPrivateKeyHex?: string,
  onPairingAckReceived?: (result: { senderPubkeyHex: string }) => void,
  // S6 (decline-a): omitted (rather than throwing) when the composition root
  // hasn't wired the Remove/announce capability — the decline branch below
  // then authenticates and drops without side effects, exactly like the
  // join-request branch's `onJoinRequestReceived && groupMemberPubkeys` guard.
  declineDeps?: DeclineReceiveDeps,
): Promise<() => void> {
  // Subscribe to kind 1059, NOT kind 444. marmot-ts wraps the kind 444 Welcome
  // rumor in a NIP-59 gift wrap (kind 1059) before publishing. The inner rumor
  // is only accessible after two layers of NIP-44 decryption (see unwrapGiftWrap).
  const sub = ndk.subscribe(
    {
      kinds: [1059 as import('@nostr-dev-kit/ndk').NDKKind],
      '#p': [pubkeyHex],
    },
    { closeOnEose: false }
  );

  // Track successfully processed gift wrap IDs in localStorage so that
  // Welcome events are not re-processed on page reload. Without this guard,
  // joinGroupFromWelcome would run again for the same Welcome (still on the
  // relay), overwriting the MLS state back to the Welcome epoch and making
  // any commits ingested since then (e.g. "add member C") undecryptable.
  const SEEN_KEY = STORAGE_KEYS.processedGiftWraps;

  // Small shared helper for the decline branch's two mark-seen call sites
  // (a terminal no-op with no groupId to key on, and the tri-state
  // DeclineOutcome check below) — both need the identical
  // read-check-append-write shape the rest of this handler already repeats
  // inline for Welcome/join-request/pairing-ack.
  function markDeclineGiftWrapSeen(id: string): void {
    try {
      const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[];
      if (!seen.includes(id)) {
        seen.push(id);
        localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
      }
    } catch { /* ignore */ }
  }

  sub.on('event', async (ndkEvent) => {
    const eventId = ndkEvent.id ?? '';
    if (!eventId) return;

    // Skip gift wraps already processed in this or a previous page session
    try {
      const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[];
      if (seen.includes(eventId)) return;
    } catch { /* ignore parse errors */ }

    // Pairing-ack dispatch (S3, additive). Uses directMessages.ts's STRICT
    // unwrapAndOpen internally (AC-SEC-2) — a completely separate unwrap
    // path from unwrapGiftWrap below. Only attempted when the caller passed
    // an ownPrivateKeyHex; existing call sites that omit the new trailing
    // params are unaffected. Any error here is swallowed and falls through
    // to the existing Welcome/join-request path unchanged, so a pairing-ack
    // processing bug can never break the pre-existing flow.
    if (ownPrivateKeyHex) {
      try {
        const pairingResult = await handlePairingAck(
          {
            id: ndkEvent.id,
            pubkey: ndkEvent.pubkey ?? '',
            content: ndkEvent.content ?? '',
            created_at: ndkEvent.created_at,
            kind: ndkEvent.kind,
            tags: ndkEvent.tags,
          },
          ownPrivateKeyHex,
          // epic: direct-contact-profile-exchange, story 06 (AC-PROF-11b) —
          // pass the `ndk` this function already receives as its own param
          // so a fresh admission fires the issuer-side push-trigger announce
          // (handlePairingAck no-ops this when ndk is omitted). No other
          // wiring changes: the subscription filter, dispatch order, and
          // Welcome/join-request fallthrough below are all untouched.
          { ndk },
        );
        if (pairingResult.status !== 'unwrap-failed' && pairingResult.status !== 'wrong-kind') {
          // This WAS a pairing-ack (of some outcome) — mark processed and
          // stop here; it must never fall through to unwrapGiftWrap/Welcome
          // dispatch below.
          try {
            const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[];
            if (!seen.includes(eventId)) {
              seen.push(eventId);
              localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
            }
          } catch { /* ignore */ }
          if (pairingResult.status === 'admitted') {
            // Fresh pending admission → ring the recipient's pending-contact
            // bell exactly once (epic: pending-contact-notification, AC-LIFE-1).
            // Wired here at the dispatch site (which already reads the
            // HandlePairingAckResult) so pairingAck.ts stays free of
            // unread-store imports. `already-admitted` is idempotent by
            // design and must NOT re-ring, so it is deliberately excluded.
            incrementPendingContact(pairingResult.senderPubkeyHex);
          }
          if (pairingResult.status === 'admitted' || pairingResult.status === 'already-admitted') {
            onPairingAckReceived?.({ senderPubkeyHex: pairingResult.senderPubkeyHex });
          }
          return;
        }
        // 'unwrap-failed' or 'wrong-kind' — might still be a real Welcome/
        // join-request; fall through to the existing dispatch below.
      } catch (err) {
        console.debug('[welcomeSubscription] pairing-ack dispatch failed, falling through:', err);
      }
    }

    try {
      // Unwrap NIP-59: gift wrap → seal → rumor (kind 444 / 21059), and
      // authenticate the sender (AC-AUTH-1/2). unwrapResult.pubkey is ALWAYS
      // the seal's pubkey; unwrapResult.authenticated tells us whether that
      // pubkey (and the rumor's claim to be it) actually verified.
      const unwrapResult = await unwrapGiftWrap(
        { pubkey: ndkEvent.pubkey ?? '', content: ndkEvent.content ?? '' },
        signer,
      );
      const welcomeRumor = unwrapResult.rumor;

      // Dispatch kind 21059 join requests to the handler
      if (welcomeRumor.kind === JOIN_REQUEST_KIND) {
        if (!unwrapResult.authenticated) {
          // AC-AUTH-3 / AC-SEC-3: a join request whose seal signature failed
          // to verify, or whose rumor.pubkey doesn't match the authenticated
          // seal.pubkey, is dropped here — it MUST NOT reach handleJoinRequest
          // (and therefore never produces a PendingJoinRequest, never shows
          // up in the admin's row even transiently).
          console.debug('[welcomeSubscription] Dropping join request: seal authentication failed');
          return;
        }
        if (onJoinRequestReceived && groupMemberPubkeys) {
          // Pass the AUTHENTICATED seal pubkey as the request's sender — never
          // the rumor's raw, self-claimed pubkey (AC-SEC-3: the admin's row
          // must show a provably-correct npub, even though the nickname
          // itself is attacker-chosen).
          const request = await handleJoinRequest(
            { pubkey: unwrapResult.pubkey, content: welcomeRumor.content },
            eventId,
            groupMemberPubkeys,
          );
          if (request) {
            // Mark as processed so we don't re-handle on reload
            try {
              const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[];
              seen.push(eventId);
              localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
            } catch { /* ignore */ }
            onJoinRequestReceived(request);
          }
        }
        return;
      }

      // AC-DECLINE-7: INVITE_DECLINE_KIND branch — slotted after the
      // join-request branch above, before the kind-444 guard below, so a
      // decline-kind rumor NEVER falls into either the Welcome or
      // join-request handling.
      if (welcomeRumor.kind === INVITE_DECLINE_KIND) {
        if (!unwrapResult.authenticated) {
          // AC-DECLINE-8: a decline whose seal fails authentication produces
          // ZERO side effects — no Remove, no post, no marker clear. Matches
          // this dispatch's existing convention for a rejected join request
          // (dropped without marking seen).
          console.debug('[welcomeSubscription] Dropping decline: seal authentication failed');
          return;
        }

        let declinePayload: unknown;
        try {
          declinePayload = JSON.parse(welcomeRumor.content);
        } catch {
          console.debug('[welcomeSubscription] Dropping decline: content is not valid JSON');
          return;
        }
        const groupId =
          typeof declinePayload === 'object' &&
          declinePayload !== null &&
          typeof (declinePayload as { groupId?: unknown }).groupId === 'string'
            ? (declinePayload as { groupId: string }).groupId
            : '';
        if (!groupId) {
          // Carry-forward from S5 review, refined per FIX B: an
          // empty/unknown groupId means A does not hold that group at all —
          // clean no-op, never a throw. This is DEFINITIVE (this wrap's
          // content can never resolve to a real group), so — same as any
          // other terminal-no-op verdict below — mark it seen now, rather
          // than leaving it to be redecrypted and reprocessed every app
          // start. Only mark seen when declineDeps is actually wired: with
          // no capability at all, this listener cannot act on ANY decline
          // regardless of groupId, so bookkeeping is withheld exactly like
          // every other branch below when its capability is unwired.
          console.debug('[welcomeSubscription] Dropping decline: empty/missing groupId');
          if (declineDeps) markDeclineGiftWrapSeen(eventId);
          return;
        }

        if (declineDeps) {
          // AC-AUTH/senderPubkey discipline: the declining identity is
          // ALWAYS the authenticated seal pubkey, never the payload's
          // self-claimed `pubkey` field (which applyDecline never reads).
          const pubkeyLower = unwrapResult.pubkey.toLowerCase();
          const chainKey = `${groupId}:${pubkeyLower}`;
          try {
            const outcome = await runSerializedDeclineProcessing(chainKey, () =>
              applyDecline(groupId, pubkeyLower, declineDeps),
            );
            // Gate-remediation (post-review): mark-seen keys on TERMINAL vs
            // RETRYABLE (see DeclineOutcome's doc comment), not on whether a
            // Remove specifically happened. 'applied' and 'terminal-noop'
            // are both definitive for THIS wrap; only 'retryable-failure'
            // (the MLS Remove commit itself threw) withholds mark-seen, so
            // the wrap reprocesses on next start while B is still pending.
            if (outcome !== 'retryable-failure') {
              markDeclineGiftWrapSeen(eventId);
            }
          } catch (err) {
            logger.warn('dm:decline-processing-failed', {
              reason: err instanceof Error ? err.message : 'unknown',
            });
          }
        }
        return;
      }

      if (welcomeRumor.kind !== 444) {
        console.debug('[welcomeSubscription] Unwrapped event is not kind 444, got:', welcomeRumor.kind);
        return;
      }

      // S4 (AC-AUTO-2/3/4/4a/5): branch the auto-accept decision HERE, at the
      // unwrap site, BEFORE enqueuePendingInvitation runs — per the S3->S4
      // seam contract, correlation reads ONLY unwrapResult.pubkey (the
      // authenticated seal pubkey), gated by unwrapResult.authenticated,
      // NEVER welcomeRumor.pubkey (the untrusted, self-claimed field).
      //
      // resolveAutoAcceptRecord fails closed at every step: an unauthenticated
      // Welcome, no matching outbound record, an expired record, or an
      // unresolved AC-AUTO-4a ambiguity (zero/multiple group-name matches)
      // all resolve to `null` here, falling through unchanged to the ORIGINAL
      // enqueue path below (AC-AUTO-3 — exactly today's behavior).
      try {
        const matchedRecord = await resolveAutoAcceptRecord(unwrapResult, welcomeRumor, marmotClient);
        if (matchedRecord) {
          try {
            // Shared join core (AC-AUTO-2): the SAME join-and-persist logic
            // acceptPendingInvitation uses below — no enqueue-then-dequeue
            // detour, so the pending queue never transiently contains this
            // Welcome and knownPeers population matches a manual accept.
            const joinedGroup = await joinGroupFromWelcomeCore(welcomeRumor, marmotClient);

            // AC-AUTO-5: consume ONLY the disambiguated matched record —
            // sibling records for the same admin (a different group) survive.
            await deleteOutboundJoinRequest(matchedRecord.nonce);

            try {
              const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[];
              if (!seen.includes(eventId)) {
                seen.push(eventId);
                localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
              }
            } catch { /* ignore */ }

            logger.info('dm:auto-accept-joined', {
              admin: unwrapResult.pubkey.slice(0, 8),
              group: joinedGroup.name,
            });

            try {
              await (onGroupJoined(joinedGroup) ?? Promise.resolve());
            } catch (err) {
              logger.warn('dm:auto-accept-callback-failed', {
                reason: err instanceof Error ? err.message : 'unknown',
              });
            }
            return;
          } catch (err) {
            // MLS join failed even though correlation matched. Do NOT consume
            // the outbound record (the join never happened) — fall through to
            // the uncorrelated/pending path below so the Welcome isn't
            // silently dropped; the user can still retry via manual Accept.
            logger.warn('dm:auto-accept-join-failed', {
              reason: err instanceof Error ? err.message : 'unknown',
            });
          }
        }
      } catch (err) {
        // Correlation itself must never block the existing pending-invitation
        // fallback (AC-AUTO-3) — any unexpected failure here degrades to
        // "uncorrelated", never to a dropped Welcome.
        logger.warn('dm:auto-accept-correlation-failed', {
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }

      // AC-INVITE-1 (unchanged fallback): enqueue the invitation so the user
      // can explicitly accept or decline it (S2) — this is the AC-AUTO-3
      // uncorrelated path, and remains the ONLY path for every Welcome that
      // did not resolve to a matched outbound record above.
      //
      // AC-AUTH-5 correction: NIP-59 rumors are themselves UNSIGNED — the
      // rumor's own `pubkey` field is merely a self-claim, never proof of
      // authorship. The SEAL is what authenticates (a real schnorr signature,
      // verified inside unwrapGiftWrap). inviterPubkeyHex is therefore always
      // unwrapResult.pubkey (the authenticated seal pubkey), never
      // welcomeRumor.pubkey (AC-AUTH-6 — closes the prior forged-Welcome
      // display-spoofing bug, where the raw rumor.pubkey was recorded as-is).
      //
      // A Welcome that fails authentication (unwrapResult.authenticated ===
      // false) is still enqueued here exactly like any other Welcome — its
      // `authenticated` status is false, so it can never have reached the
      // auto-accept branch above (AC-AUTH-3 / AC-AUTO-4).
      const inviterPubkeyHex = unwrapResult.pubkey;

      // AC-SEC-4: never key a pending invitation by an UNAUTHENTICATED
      // rumor's self-claimed `id`. When unwrapResult.authenticated is false,
      // the S3 rumor-id canonical check did not pass, so welcomeRumor.id is
      // just another attacker-chosen field (like rumor.pubkey above) — an
      // attacker could pick it to collide with an already-enqueued legit
      // invitation's id and have enqueuePendingInvitation's id-based dedup
      // (pendingInvitations.ts) silently swallow/corrupt the real one. The
      // outer gift-wrap `eventId` is a real relay event id (hash-derived,
      // not grindable to an attacker-chosen value) and is always safe to key
      // by. Only an AUTHENTICATED Welcome's welcomeRumor.id is the verified
      // canonical hash, safe to use so uncorrelated-but-legitimate re-invites
      // keep deduping the same way they always have.
      // AC-DECLINE-1/2: surface groupId (pre-join, via readPreJoinGroupData)
      // and persist the ALREADY-COMPUTED seal-authentication result
      // (unwrapResult.authenticated) at enqueue time, so a later decline can
      // send its gift wrap without re-parsing the Welcome and without
      // re-deriving a trust decision this dispatch already made.
      // readPreJoinGroupData never throws (returns null on any failure) —
      // an unresolvable groupId degrades to '' rather than blocking enqueue.
      let declineGroupId = '';
      try {
        const preJoinData = await readPreJoinGroupData(welcomeRumor, marmotClient);
        declineGroupId = preJoinData?.groupId ?? '';
      } catch (err) {
        logger.warn('dm:decline-groupid-read-failed', {
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }

      const invitation: PendingInvitation = {
        id: unwrapResult.authenticated && welcomeRumor.id ? welcomeRumor.id : eventId,
        inviterPubkeyHex,
        receivedAt: Date.now(),
        welcomeEventJson: JSON.stringify(welcomeRumor),
        groupId: declineGroupId,
        authenticated: unwrapResult.authenticated,
      };

      enqueuePendingInvitation(invitation);

      // Mark the gift wrap eventId as processed NOW so that relay resends and
      // page-reload re-subscriptions don't re-enqueue the same Welcome. The
      // invitation remains in the pending queue for the user to accept/decline.
      // On accept, the eventId will be re-added (idempotent).
      try {
        const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]') as string[];
        if (!seen.includes(eventId)) {
          seen.push(eventId);
          localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
        }
      } catch { /* ignore */ }

      logger.info('dm:walled-garden-invite-pending', {
        inviter: inviterPubkeyHex.slice(0, 8),
        queueSize: countPendingInvitations(),
      });
    } catch (err) {
      // Expected: not every kind 1059 is a Welcome for us. The p-tag filter
      // matches any gift wrap addressed to us (e.g. DMs). Decryption will fail
      // for non-Welcome content — that's fine (AC-INVITE-2: invalid Welcomes
      // are dropped silently here).
      console.debug('[welcomeSubscription] Could not process gift wrap event:', err);
    }
  });

  return () => {
    sub.stop();
  };
}

// Module-level, per-group seen-id dedup. Each subscribeToGroupMessages call used
// to start with a FRESH local Set, so when two instances overlap (a rapid
// re-subscribe on groups state change before the old instance's teardown runs)
// the same kind-445 event id could be ingested by both. Sharing the set per
// group makes dedup cross-instance. Bounded LRU (insertion-ordered Set, evict
// oldest past the cap), mirroring applicationRumorDispatcher. Deliberately NEVER
// cleared on unsubscribe — a fresh instance must see the prior instance's
// processed ids. Re-adding a seen id is a harmless no-op, and an evicted-then-
// reseen id costs at most a redundant resolver.ingestEvent, which mlsGroup.ingest
// already treats idempotently by MLS epoch ordering.
const GROUP_SEEN_IDS_CAP = 1000;
const seenIdsByGroup = new Map<string, Set<string>>();

function getGroupSeenIds(groupKey: string): Set<string> {
  let set = seenIdsByGroup.get(groupKey);
  if (!set) {
    set = new Set<string>();
    seenIdsByGroup.set(groupKey, set);
  }
  return set;
}

function markGroupSeen(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > GROUP_SEEN_IDS_CAP) {
    const evictCount = set.size - GROUP_SEEN_IDS_CAP;
    const iter = set.values();
    for (let i = 0; i < evictCount; i++) {
      const oldest = iter.next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }
}

/**
 * Subscribe to kind 445 (encrypted group messages) for a specific group.
 * Returns an unsubscribe function.
 */
export async function subscribeToGroupMessages(
  groupId: string,
  relays: string[],
  mlsGroup: import('@internet-privacy/marmot-ts').MarmotGroup,
  ndk: import('@nostr-dev-kit/ndk').default,
  onMembersChanged?: (members: string[]) => void,
  onHistorySynced?: () => void,
  lifecycle?: { drainApplicationMessages?: () => Promise<void>; signal?: AbortSignal },
): Promise<() => void> {
  // marmot-ts tags kind 445 events with #h using the Nostr group ID
  // (MarmotGroupData.nostrGroupId), NOT the MLS group context ID (idStr).
  const nostrGroupIdBytes = mlsGroup.groupData?.nostrGroupId;
  const nostrGroupIdHex = nostrGroupIdBytes
    ? Array.from(nostrGroupIdBytes).map((b) => b.toString(16).padStart(2, '0')).join('')
    : groupId; // fallback

  const filter = {
    kinds: [445 as import('@nostr-dev-kit/ndk').NDKKind],
    '#h': [nostrGroupIdHex],
  };

  // Track processed event IDs to avoid double-processing between fetch and the
  // live subscription, AND across overlapping subscription instances for the same
  // group (shared module-level set keyed by groupId — see getGroupSeenIds).
  const processedIds = getGroupSeenIds(groupId);

  // EpochResolver wraps mlsGroup.ingest() with fork resolution, rollback,
  // and future-epoch buffering. Application messages are dispatched by the
  // unified dispatcher (applicationRumorDispatcher) via the MarmotGroup
  // 'authenticatedApplicationMessage' event; the resolver's onApplicationMessage callback
  // is a no-op here — EpochResolver still requires the field to maintain its
  // internal interface contract.
  const resolver = new EpochResolver(
    mlsGroup,
    { onMembersChanged },
  );

  let disposed = false;
  let liveSubscription: { stop(): void } | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    resolver.dispose();
    liveSubscription?.stop();
    lifecycle?.signal?.removeEventListener('abort', dispose);
  };
  if (lifecycle?.signal?.aborted) {
    dispose();
    return dispose;
  }
  lifecycle?.signal?.addEventListener('abort', dispose, { once: true });

  // Returns true when this call newly ingested the event (i.e. it was not a
  // duplicate). Used by the historical-sync loop to count net-new ingests
  // accurately even though processedIds is now shared across instances.
  async function ingestNdkEvent(ndkEvent: import('@nostr-dev-kit/ndk').NDKEvent): Promise<boolean> {
    const eventId = ndkEvent.id ?? '';
    if (disposed || !eventId || processedIds.has(eventId)) return false;
    // Mark seen BEFORE ingest so an overlapping subscription instance does not
    // double-ingest this event while it is in flight. If the resolver reports it
    // was only buffered (future-epoch/unreadable), un-mark it below.
    markGroupSeen(processedIds, eventId);

    try {
      const nostrEvent = {
        id: eventId,
        pubkey: ndkEvent.pubkey ?? '',
        created_at: ndkEvent.created_at ?? 0,
        kind: ndkEvent.kind ?? 0,
        tags: ndkEvent.tags ?? [],
        content: ndkEvent.content ?? '',
        sig: ndkEvent.sig ?? '',
      };

      const { buffered } = await resolver.ingestEvent(nostrEvent);
      if (buffered) {
        // The event could not be applied yet and sits in the resolver's
        // future-epoch buffer. If this subscription instance is torn down before
        // the enabling commit/message arrives, dispose() drops the buffer — and
        // a permanently-seen id would stop a fresh instance's historical refetch
        // from re-ingesting it, silently losing the rumor. Un-marking lets the
        // refetch retry. Re-ingesting an already-applied event is idempotent
        // (mlsGroup.ingest dedups by MLS epoch ordering), so this is safe.
        processedIds.delete(eventId);
      }
    } catch (err) {
      console.debug('[welcomeSubscription] Could not ingest group message:', err);
    }
    return true;
  }

  // Build a relay set scoped to this group's relays so that traffic and
  // group activity are not leaked to the full default relay pool.
  try {
    const { NDKRelaySet } = await import('@nostr-dev-kit/ndk');
    if (disposed) return dispose;
    const relaySet = relays.length > 0
      ? NDKRelaySet.fromRelayUrls(relays, ndk)
      : undefined;

    // Anchor for the Phase-2 live sub's `since` filter. Captured BEFORE Phase-1
    // begins so the relay replays any event published between Phase-1 EOSE and
    // Phase-2 WebSocket REQ registration — without it, events landing in that
    // gap are silently dropped. `processedIds` dedups the resulting overlap.
    //
    // The `CLOCK_SKEW_MARGIN_SEC` backdate exists because relays filter `since`
    // against the event's signed `created_at`, not the relay's receipt time. 30s
    // is the chosen window because it covers (a) sub-second JS scheduling jitter
    // that produced the reported 33–60% flake, (b) modest NTP drift between
    // publisher and subscriber clocks, and (c) brief mobile sleep/resume or
    // pre-signed-event lag. `processedIds` absorbs the wider replay window at
    // zero correctness cost — every duplicate is dropped before dispatch.
    const CLOCK_SKEW_MARGIN_SEC = 30;
    const fetchStartedAt = Math.floor(Date.now() / 1000) - CLOCK_SKEW_MARGIN_SEC;

    // Fetch and ingest all existing kind 445 events (historical sync).
    // This ensures commits published before subscription started are processed.
    let historicalCount = 0;
    let historicalIngested = 0;
    let historySyncComplete = false;
    try {
      const { fetchEventsWithTimeout } = await import('@/src/lib/ndkClient');
      const { events: existingEvents, timedOut } = await fetchEventsWithTimeout(ndk, filter, {}, relaySet);
      if (disposed) return dispose;
      if (timedOut) {
        console.warn(`[welcomeSubscription] Historical fetch timed out for group ${groupId.slice(0, 16)} — skipping onHistorySynced to avoid epoch divergence`);
      } else {
        historySyncComplete = true;
      }
      // Sort by created_at to process in chronological order
      const sorted = Array.from(existingEvents).sort(
        (a, b) => (a.created_at ?? 0) - (b.created_at ?? 0)
      );
      historicalCount = sorted.length;
      for (const ev of sorted) {
        if (await ingestNdkEvent(ev)) historicalIngested++;
      }
    } catch (err) {
      console.debug('[welcomeSubscription] Historical fetch failed:', err);
    }
    console.info(`[welcomeSubscription] Historical sync: ${historicalIngested}/${historicalCount} events ingested for group ${groupId.slice(0, 16)}${historySyncComplete ? '' : ' (incomplete)'}`);

    // EventEmitter does not await application listeners. Persist their queued
    // work before exposing readiness or publishing history-dependent profiles.
    try {
      await lifecycle?.drainApplicationMessages?.();
    } catch (error) {
      dispose();
      throw error;
    }
    if (disposed) return dispose;

    // Only fire onHistorySynced when we know ALL historical events were received
    // (EOSE from relays). On timeout the local epoch may lag behind — publishing
    // an application rumor now would risk the MLS epoch divergence the surrounding
    // comment warns about.
    if (historySyncComplete) {
      // S6 (AC-DECLINE-12): unconditional on the caller-supplied onHistorySynced
      // callback below — the decline receive path's deferral gate must resolve
      // even when this subscribeToGroupMessages call omits that callback.
      markGroupHistorySynced(groupId);
    }
    if (onHistorySynced && historySyncComplete) {
      try {
        onHistorySynced();
      } catch (err) {
        console.debug('[welcomeSubscription] onHistorySynced callback failed:', err);
      }
    }

    // NOTE: selfUpdate is intentionally NOT called here — it advances the
    // local MLS epoch, creating a divergent branch. sendApplicationRumor
    // (for profile publish) is safe after historical sync because the local
    // epoch is up-to-date. The onHistorySynced callback handles this.

    // Live subscription for future events, scoped to the group's relays.
    // `since: fetchStartedAt` closes the EOSE→REQ gap (see fetchStartedAt above).
    const liveFilter = { ...filter, since: fetchStartedAt };
    const sub = ndk.subscribe(liveFilter, { closeOnEose: false }, relaySet);
    liveSubscription = sub;
    sub.on('event', (ndkEvent) => void ingestNdkEvent(ndkEvent));
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

/**
 * Accept a pending invitation: parse the stored welcomeEventJson, call
 * joinGroupFromWelcome, persist the group, and remove the entry from the queue.
 *
 * On MLS failure: removes from queue, throws a user-visible error, logs WARN.
 *
 * AC-INVITE-5, AC-OBS-3
 */
export async function acceptPendingInvitation(
  id: string,
  marmotClient: import('@internet-privacy/marmot-ts').MarmotClient,
  onGroupJoined: WelcomeReceivedCallback,
): Promise<void> {
  const list = listPendingInvitations();
  const entry = list.find((inv) => inv.id === id);
  if (!entry) {
    // Already removed (race: double-click or stale state)
    return;
  }

  let parsedWelcome: unknown;
  try {
    parsedWelcome = JSON.parse(entry.welcomeEventJson);
  } catch {
    removePendingInvitation(id);
    logger.warn('dm:walled-garden-invite-stale', { id: id.slice(0, 8), reason: 'json-parse-failed' });
    throw new Error('This invitation is no longer valid');
  }

  let joinedGroup: Group | null = null;
  try {
    // S4: shared join core — the SAME join-and-persist logic the auto-accept
    // path (inside subscribeToWelcomes) calls, so knownPeers population and
    // downstream effects are identical regardless of path.
    joinedGroup = await joinGroupFromWelcomeCore(parsedWelcome, marmotClient);
    removePendingInvitation(id);
    logger.info('dm:walled-garden-invite-accept', { id: id.slice(0, 8) });
  } catch (err) {
    // MLS failure: remove from queue so the user isn't stuck, log WARN, rethrow
    removePendingInvitation(id);
    logger.warn('dm:walled-garden-invite-stale', {
      id: id.slice(0, 8),
      reason: err instanceof Error ? err.message : 'unknown',
    });
    throw new Error('This invitation is no longer valid');
  }

  // Fire the caller's group-joined callback OUTSIDE the try-catch so that a
  // callback failure (e.g. reloadGroups IDB error) does not produce a
  // misleading "invitation invalid" error — the join already succeeded.
  if (joinedGroup) {
    try {
      await (onGroupJoined(joinedGroup) ?? Promise.resolve());
    } catch (err) {
      logger.warn('dm:walled-garden-invite-accept-callback-failed', { id: id.slice(0, 8) });
    }
  }
}

/**
 * Builds and sends the B→A gift-wrapped decline DM (AC-DECLINE-3/13).
 *
 * Privacy invariant (CLAUDE.md, non-negotiable): the inner rumor's plaintext
 * content is a fresh object literal rebuilt from exactly these two named
 * fields — `{ groupId, pubkey }` — never a widened object that could carry
 * nickname/avatar/profile metadata. `sealAndWrap` (`directMessages.ts`)
 * reuses the audited `nostr-tools/nip59` `wrapEvent` helper: the seal (inner
 * envelope) is signed with the caller's REAL private key so A's existing
 * `unwrapGiftWrap` seal-authentication checks can verify sender identity,
 * while the OUTER gift-wrap layer is always signed with a FRESH ephemeral
 * key generated internally by `wrapEvent`/`createWrap` — never B's real
 * identity key (sender hidden from relay operators).
 */
async function sendDeclineGiftWrap(
  groupId: string,
  inviterPubkeyHex: string,
  keys: DeclineSendKeys,
): Promise<void> {
  const payload: DeclineGiftWrapPayload = {
    groupId,
    pubkey: keys.selfPubkeyHex,
  };

  const rumor = createRumor(
    {
      kind: INVITE_DECLINE_KIND,
      content: JSON.stringify(payload),
      tags: [['p', inviterPubkeyHex]],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: keys.selfPubkeyHex,
    },
    hexToBytes(keys.selfPrivateKeyHex),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = await sealAndWrap(rumor as any, inviterPubkeyHex, keys.selfPrivateKeyHex);
  const { NDKEvent } = await import('@nostr-dev-kit/ndk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ndkEvent = new NDKEvent(keys.ndk, wrap as any);
  await ndkEvent.publish();
}

/**
 * Decline a pending invitation.
 *
 * AC-DECLINE-3/4/5/6/13: when `sendKeys` is provided AND the stored entry's
 * `authenticated` flag is `true` AND the entry has a non-empty `groupId`,
 * sends a NIP-59 gift-wrapped `INVITE_DECLINE_KIND` rumor addressed to the
 * inviter with inner content EXACTLY `{ groupId, pubkey: selfHex }`
 * (AC-DECLINE-3/13) — no group-channel publish, no MLS Add, ever occurs on
 * this path (AC-DECLINE-6). An `authenticated: false` entry (or a
 * missing/legacy value, which `pendingInvitations.ts` already normalizes to
 * `false`) skips the send entirely — no publish call is attempted
 * (AC-DECLINE-4). Gate-remediation (severity 2): an entry whose `groupId` is
 * `''` (a degraded pre-join read, or a legacy record) is ALSO skipped for the
 * send — the recipient (the inviter) can only ever classify such a decline
 * as an empty-groupId no-op and mark it seen, so sending it is a pointless
 * publish + decrypt round-trip with no observable effect. Local removal
 * (`removePendingInvitation`) is UNCONDITIONAL — it runs in a `finally`
 * block regardless of whether `sendKeys` was supplied, whether the entry was
 * authenticated, whether `groupId` was present, or whether the send
 * succeeded, failed, or threw (AC-DECLINE-5). A send failure is caught and
 * logged, never rethrown or allowed to block local cleanup.
 *
 * AC-INVITE-6, AC-OBS-3
 */
export async function declinePendingInvitation(id: string, sendKeys?: DeclineSendKeys): Promise<void> {
  try {
    const entry = listPendingInvitations().find((inv) => inv.id === id);
    if (entry && sendKeys && entry.authenticated && entry.groupId) {
      try {
        await sendDeclineGiftWrap(entry.groupId, entry.inviterPubkeyHex, sendKeys);
        logger.info('dm:decline-sent', { id: id.slice(0, 8) });
      } catch (err) {
        // AC-DECLINE-5: a send failure must never block local removal below.
        logger.warn('dm:decline-send-failed', {
          id: id.slice(0, 8),
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
  } finally {
    removePendingInvitation(id);
    logger.info('dm:walled-garden-invite-decline', { id: id.slice(0, 8) });
  }
}
