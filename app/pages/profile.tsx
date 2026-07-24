import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import NextLink from 'next/link';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Badge,
  Box,
  Button,
  Divider,
  HStack,
  Heading,
  Image,
  Input,
  Select,
  Text,
  VStack,
  useDisclosure,
} from '@chakra-ui/react';
import { useCopy } from '@/src/context/LanguageContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useProfile } from '@/src/context/ProfileContext';
import AvatarBrowserModal from '@/src/components/AvatarBrowserModal';
import ShareContactCard from '@/src/components/contacts/ShareContactCard';
import { hasShareableName } from '@/src/lib/shareCard';
import { addableGroupsForContact, eligibleGroupsForContact, getContact, listContacts } from '@/src/lib/contacts';
import BlockContactButton from '@/src/components/contacts/BlockContactButton';
import { ConfirmButton } from '@/src/components/UserCard';
import { confirmPendingContact } from '@/src/components/contacts/PendingConfirmationPrompt';
import { clearPendingContact } from '@/src/lib/unreadStore';
import { pubkeyToNpub, truncateNpub } from '@/src/lib/nostrKeys';
import { markPendingDirectInvite, clearPendingDirectInvite } from '@/src/lib/marmot/pendingDirectInviteStorage';
import { drainPendingIntents, type PendingIntentSendContext } from '@/src/lib/pairing/pendingIntent';
import { capNickname, NICKNAME_MAX_BYTES } from '@/src/config/profile';
import { utf8ByteLength } from '@/src/lib/contactCard';
import { sendProfileAnnounce, type ProfileSendKeys } from '@/src/lib/dmProfile/send';
import type { ContactListItem } from '@/src/lib/contacts';
import type { ProfileAvatar, UserProfile } from '@/src/types';
import type NDK from '@nostr-dev-kit/ndk';

// ── Push trigger: announce-on-change fan-out (epic:
// direct-contact-profile-exchange, story 06; AC-PROF-11b) ──────────────────
//
// The 1:1 analog of `MarmotContext#publishProfileUpdate`'s group fan-out
// (exploration.json's `profile_model.group_fanout_template`): on a
// nickname/avatar edit, ADDITIONALLY fan a `profile-announce` gift wrap to
// every active, non-archived contact (archived contacts get NOTHING — Q7/
// AC-PROF-4b), staggered like `ProfileHealWatcher.tsx#planDueSweep`'s bulk
// sweep so a large contact list doesn't stampede a relay with N simultaneous
// wraps (spec.md §3.6/§5). This is purely additive alongside the existing
// group broadcast — `publishProfileUpdate` itself is never touched.
//
// Split into two pure/testable pieces (mirrors `ProfileHealWatcher.tsx`'s
// own `planDueSweep` / `advanceAfterFire` split — no jsdom/renderHook
// precedent in this repo, so page-level logic worth testing directly is
// extracted as an exported, dependency-injectable function instead):
//   - `planProfileAnnounceFanout` — PURE. Audience + stagger schedule.
//   - `executeProfileAnnounceFanout` — fires (or schedules) the actual
//     `send.ts#sendProfileAnnounce` calls, with `sendAnnounce`/
//     `scheduleDelay` injectable so tests can assert exact call behavior
//     without a real network/timers.

/** A contact snapshot as seen by the fan-out planner — mirrors `ContactSnapshot` (scheduler.ts/ProfileHealWatcher.tsx) but scoped to this module. */
export type ProfileAnnounceContactSnapshot = {
  pubkeyHex: string;
  archived: boolean;
};

/** One planned fan-out send: the (lowercased) recipient plus its dispatch-time stagger delay. */
export type ProfileAnnounceFanoutEntry = {
  pubkeyHex: string;
  /** Milliseconds to wait before firing. 0 when the audience is <= PROFILE_EDIT_FANOUT_STAGGER_THRESHOLD. */
  delayMs: number;
};

/**
 * When a nickname/avatar edit's fan-out audience exceeds this many active
 * contacts, sends are spread across `PROFILE_EDIT_FANOUT_STAGGER_WINDOW_MS`
 * instead of firing in the same tick (spec.md §3.6: "staggered/jittered like
 * the sweep to avoid a burst"). Mirrors
 * `ProfileHealWatcher.tsx#BULK_SWEEP_STAGGER_THRESHOLD`'s value — kept as an
 * independent constant (not imported) so this module has no dependency edge
 * on the watcher component, consistent with architecture.md's module
 * boundaries.
 */
export const PROFILE_EDIT_FANOUT_STAGGER_THRESHOLD = 5;

/** The window a large fan-out's sends are spread evenly across. Mirrors `ProfileHealWatcher.tsx#BULK_SWEEP_STAGGER_WINDOW_MS`'s value (independent constant — see above). */
export const PROFILE_EDIT_FANOUT_STAGGER_WINDOW_MS = 30_000;

/**
 * PURE. Computes the announce-on-change fan-out audience + stagger plan.
 *
 * Audience = active, non-archived contacts ONLY (archived/hidden contacts
 * are excluded entirely — Q7/AC-PROF-4b — this function's own filter, not a
 * downstream one, so the exclusion is directly assertable at this
 * boundary). Every `pubkeyHex` is case-folded (architecture.md's
 * case-folding rule) so a mixed-case snapshot entry can never produce a
 * second, distinct recipient for the same contact.
 */
export function planProfileAnnounceFanout(
  contacts: ProfileAnnounceContactSnapshot[],
): ProfileAnnounceFanoutEntry[] {
  const active = contacts.filter((c) => !c.archived).map((c) => c.pubkeyHex.toLowerCase());

  if (active.length > PROFILE_EDIT_FANOUT_STAGGER_THRESHOLD) {
    return active.map((pubkeyHex, index) => ({
      pubkeyHex,
      delayMs: Math.round((index / active.length) * PROFILE_EDIT_FANOUT_STAGGER_WINDOW_MS),
    }));
  }
  return active.map((pubkeyHex) => ({ pubkeyHex, delayMs: 0 }));
}

export type ExecuteProfileAnnounceFanoutParams = {
  ndk: NDK;
  keys: ProfileSendKeys;
  /** The profile as of THIS edit (pre-`ensureAvatar` — `sendProfileAnnounce` backfills). */
  localProfile: UserProfile;
  plan: ProfileAnnounceFanoutEntry[];
  /** Injectable for tests — defaults to `send.ts#sendProfileAnnounce` (the S03 privacy chokepoint). Never re-implemented. */
  sendAnnounce?: typeof sendProfileAnnounce;
  /** Injectable for tests — defaults to the real `setTimeout`. */
  scheduleDelay?: (fire: () => void, delayMs: number) => void;
};

/**
 * Fires (or schedules) one `sendProfileAnnounce` gift wrap per plan entry.
 *
 * Synchronous and fire-and-forget by design: every send is either invoked
 * immediately or handed to `scheduleDelay`, never awaited here, so this
 * function itself can never block or slow the profile-save UX. A single
 * recipient's failure is swallowed (mirrors
 * `MarmotContext#publishProfileUpdate`'s per-group swallow) — it is never
 * surfaced to the caller and never stops the remaining sends.
 */
export function executeProfileAnnounceFanout(params: ExecuteProfileAnnounceFanoutParams): void {
  const sendAnnounce = params.sendAnnounce ?? sendProfileAnnounce;
  const scheduleDelay =
    params.scheduleDelay ??
    ((fire: () => void, delayMs: number) => {
      setTimeout(fire, delayMs);
    });

  for (const entry of params.plan) {
    const fire = () => {
      void sendAnnounce({
        ndk: params.ndk,
        recipientPubkeyHex: entry.pubkeyHex,
        keys: params.keys,
        localProfile: params.localProfile,
      }).catch(() => {
        // Per-target failure swallowed — mirrors publishProfileUpdate's group fan-out.
      });
    };
    if (entry.delayMs > 0) {
      scheduleDelay(fire, entry.delayMs);
    } else {
      fire();
    }
  }
}

/**
 * PURE. AC-SEND-10 (S8-remediation) — decides whether the "last broadcast
 * nickname" marker (`broadcastProfile`'s `lastBroadcastNickname` ref) should
 * advance after one interactive broadcast attempt.
 *
 * The marker exists so a blur that didn't change the nickname text doesn't
 * re-broadcast to every group. The bug this guards against: advancing the
 * marker unconditionally (BEFORE the send, or after a send that merely
 * *attempted* but did not confirm delivery) permanently suppresses a
 * same-text retry once a locked/absent signer recovers, because a later
 * blur with the identical text is compared against a marker that already
 * claims that text was sent. Only a CONFIRMED-successful send (at least one
 * group actually received the meta-event — see
 * `MarmotContext#publishProfileUpdate`'s return value) may advance the
 * marker; any other outcome (signer failure, every per-group send failing,
 * an unexpected rejection) must leave the previous marker value untouched
 * so the next same-text blur re-attempts the broadcast.
 */
export function nextBroadcastMarker(
  previousMarker: string | null,
  attemptedNickname: string,
  sendConfirmed: boolean,
): string | null {
  return sendConfirmed ? attemptedNickname : previousMarker;
}

function AvatarDisplay({ avatar, displayName, size }: { avatar: ProfileAvatar | null; displayName: string; size: string }) {
  return (
    <Box
      w={size}
      h={size}
      borderRadius="full"
      overflow="hidden"
      bg="surfaceMutedBg"
      display="flex"
      alignItems="center"
      justifyContent="center"
      borderWidth="1px"
      borderColor="borderSubtle"
      flexShrink={0}
    >
      {avatar ? (
        <Image src={avatar.imageUrl} alt={displayName} w="100%" h="100%" objectFit="cover" />
      ) : (
        <Text fontWeight="bold" color="textMuted" fontSize="3xl">
          {displayName.slice(0, 1).toUpperCase()}
        </Text>
      )}
    </Box>
  );
}

function OwnProfileSection() {
  const copy = useCopy();
  const router = useRouter();
  const { backedUp, pubkeyHex, privateKeyHex } = useNostrIdentity();
  const { profile: savedProfile, hydrated, saveProfile } = useProfile();
  const { publishProfileUpdate } = useMarmot();
  const avatarDisclosure = useDisclosure();
  const [profile, setProfile] = useState<UserProfile>({ nickname: '', avatar: null });
  // True when the last keystroke/paste was clamped to the byte cap, so we can
  // surface a translated "limit reached" notice.
  const [nicknameCapped, setNicknameCapped] = useState(false);

  // --- Pairing name-setup redirect (epic: contact-pairing-code, story S4,
  // RD-7/AC-SCAN-5) ---
  // `/add.tsx` sends a nameless scanner here with `?pairing=1` after already
  // durably persisting the pending intent — this flag only drives the
  // contextual prompt below, never the drain trigger itself (a name set on
  // ANY visit to this page must fire a held echo, not just one that arrived
  // via this query flag).
  const pairingNameSetupFlag = router.query.pairing === '1';

  // AC-SCAN-6/7: the moment `hasShareableName` flips from false to true,
  // attempt every persisted pending pairing intent once (drainPendingIntents
  // silently drops any that are past their own window — AC-SCAN-7 — and
  // leaves anything still nameless untouched). Edge-triggered on the
  // false->true transition of the chokepoint's own output (`savedProfile`,
  // from `useProfile().saveProfile`) so this never re-fires on every
  // subsequent keystroke once a name is already set.
  const prevHasShareableNameRef = useRef(hasShareableName(savedProfile.nickname));
  useEffect(() => {
    const hasNameNow = hasShareableName(savedProfile.nickname);
    const justBecameShareable = !prevHasShareableNameRef.current && hasNameNow;
    prevHasShareableNameRef.current = hasNameNow;
    if (!justBecameShareable || !pubkeyHex || !privateKeyHex) return;

    const ownPubkeyHex = pubkeyHex;
    const ownPrivateKeyHex = privateKeyHex;
    const ctx: PendingIntentSendContext = {
      ownPubkeyHex,
      ownPrivateKeyHex,
      ownProfile: { nickname: savedProfile.nickname, createdAt: Math.floor(Date.now() / 1000) },
      resolveSendDeps: async () => {
        const [{ connectNdk }, { activeEventSignerOverride, createPrivateKeySigner }] = await Promise.all([
          import('@/src/lib/ndkClient'),
          import('@/src/lib/marmot/signerAdapter'),
        ]);
        const ndk = await connectNdk(ownPrivateKeyHex);
        const signer = activeEventSignerOverride.current ?? createPrivateKeySigner(ownPrivateKeyHex);
        return { ndk, signEvent: signer.signEvent };
      },
    };
    void drainPendingIntents(ctx).catch(() => {
      // drainPendingIntents already never throws (each intent's own send
      // failure is caught and reported as 'queued-for-retry' internally) —
      // this catch only guards against a truly unexpected rejection so a
      // held intent's failure can never surface as an uncaught profile-page
      // error.
    });
  }, [savedProfile.nickname, pubkeyHex, privateKeyHex]);

  // Tracks the nickname value as of the last broadcast so a blur that didn't
  // change the text doesn't re-broadcast a profile-update to every group.
  const lastBroadcastNickname = useRef<string | null>(null);

  useEffect(() => {
    setProfile(savedProfile);
  }, [savedProfile]);

  // Seed the broadcast baseline once from the hydrated profile: the persisted
  // nickname is assumed already broadcast, so it isn't re-sent on first blur.
  useEffect(() => {
    if (hydrated && lastBroadcastNickname.current === null) {
      lastBroadcastNickname.current = savedProfile.nickname;
    }
  }, [hydrated, savedProfile.nickname]);

  // Push trigger: announce-on-change (epic: direct-contact-profile-exchange,
  // story 06; AC-PROF-11b). Additive alongside `publishProfileUpdate`'s group
  // fan-out below — fans a 1:1 profile-announce to every active,
  // non-archived contact. Reads the LIVE contact list at call time (never a
  // cached/stale snapshot) so a contact archived since the last render is
  // still excluded. Entirely fire-and-forget: any setup failure (e.g. NDK
  // connect) is swallowed here so it can never surface as a profile-save
  // error — the nickname/avatar edit itself already succeeded via
  // `saveProfile` before `broadcastProfile` is ever called.
  //
  // AC-SEND-10 (S8-remediation) determination: this fan-out carries NO
  // pre-send "already announced" baseline/marker of its own (unlike
  // `broadcastProfile`'s `lastBroadcastNickname` ref for the group path) — it
  // unconditionally recomputes `plan` from the live contact list and fires
  // on every call. There is nothing here that gets set BEFORE a send and
  // then wrongly suppresses a later retry, so the arch_violation this story
  // fixes does not apply to this function and it is left untouched.
  const fanOutProfileAnnounceOnChange = useCallback(
    (next: UserProfile) => {
      if (!pubkeyHex || !privateKeyHex) return;
      const ownPubkeyHex = pubkeyHex;
      const ownPrivateKeyHex = privateKeyHex;
      void (async () => {
        try {
          const contactItems = listContacts(ownPubkeyHex, { includeArchived: true });
          const plan = planProfileAnnounceFanout(
            contactItems.map((c) => ({ pubkeyHex: c.pubkeyHex, archived: c.isArchived })),
          );
          if (plan.length === 0) return;
          const { connectNdk } = await import('@/src/lib/ndkClient');
          const ndk = await connectNdk(ownPrivateKeyHex);
          executeProfileAnnounceFanout({
            ndk,
            keys: { ownPubkeyHex, ownPrivateKeyHex },
            localProfile: next,
            plan,
          });
        } catch {
          // Fan-out setup failures must never surface as a profile-save error.
        }
      })();
    },
    [pubkeyHex, privateKeyHex],
  );

  const broadcastProfile = useCallback(
    (next: UserProfile) => {
      // AC-SEND-10 (S8-remediation): the marker advances ONLY after
      // `publishProfileUpdate` confirms at least one group actually received
      // the meta-event (see `nextBroadcastMarker` above for why). Previously
      // the marker was set BEFORE the (fire-and-forget) send, so a
      // locked/absent-signer failure still advanced it — a same-text blur
      // after signer recovery was then permanently suppressed until the text
      // changed again. `publishProfileUpdate` itself never throws (its
      // per-group sends are individually try/caught), but `.catch` is kept
      // as defense-in-depth: an unexpected rejection must never advance the
      // marker either.
      //
      // S8R-2: the marker advances ASYNCHRONOUSLY, in the `.then` below,
      // after `publishProfileUpdate` resolves — not synchronously before the
      // send. This briefly reopens the same-text dedup window: a rapid
      // identical re-blur fired while a send is still in flight isn't
      // suppressed, and two different-text broadcasts resolving out of order
      // can leave the marker holding an older-but-still-confirmed-sent
      // nickname. This is intentionally tolerated, not a bug to close with
      // an in-flight tracking Set: the marker only ever holds
      // confirmed-sent values (see `nextBroadcastMarker`), so it can never
      // suppress an UNsent update — the retry-eligibility invariant that
      // actually matters is preserved. The only cost is an occasional
      // redundant re-broadcast of content that was already sent, and that is
      // neutralized downstream by S7's receiver-side one-shot + LWW handling.
      const attemptedNickname = next.nickname;
      void publishProfileUpdate(next)
        .then((sendConfirmed) => {
          lastBroadcastNickname.current = nextBroadcastMarker(
            lastBroadcastNickname.current,
            attemptedNickname,
            sendConfirmed,
          );
        })
        .catch(() => {
          // Never advance the marker on an unexpected rejection.
        });
      fanOutProfileAnnounceOnChange(next);
    },
    [publishProfileUpdate, fanOutProfileAnnounceOnChange],
  );

  // Nickname is stored locally on every keystroke, but only broadcast when the
  // text field is left (blur) and the value actually changed.
  const handleNicknameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { value: nickname, capped } = capNickname(event.target.value);
      setNicknameCapped(capped);
      const next = { ...profile, nickname };
      setProfile(next);
      saveProfile(next);
    },
    [profile, saveProfile],
  );

  const handleNicknameBlur = useCallback(() => {
    if (profile.nickname !== lastBroadcastNickname.current) {
      broadcastProfile(profile);
    }
  }, [profile, broadcastProfile]);

  // Avatar is a selection: persist locally and broadcast immediately. A profile
  // always has an avatar — there is no "remove" path, only "replace".
  function handleAvatarSelect(avatar: ProfileAvatar) {
    const next = { ...profile, avatar };
    setProfile(next);
    saveProfile(next);
    broadcastProfile(next);
    avatarDisclosure.onClose();
  }

  return (
    <>
      <VStack spacing={6} align="stretch">
        {/* Pairing name-setup prompt (epic: contact-pairing-code, story S4, RD-7) —
            shown only while a nameless scanner is still nameless after arriving
            here via /add.tsx's ?pairing=1 redirect. The held echo already fires
            automatically the moment a name is saved (effect above); this is
            purely explanatory copy. */}
        {pairingNameSetupFlag && !hasShareableName(savedProfile.nickname) && (
          <Alert status="info" borderRadius="md" data-testid="profile-pairing-name-setup-prompt">
            <AlertIcon />
            <AlertDescription fontSize="sm">{copy.profile.pairingNameSetupPrompt}</AlertDescription>
          </Alert>
        )}

        {/* Nickname + Avatar */}
        <Box>
          <VStack spacing={5} align="stretch">
            <Box>
              <Heading as="h2" size="md" mb={3}>
                {copy.settings.nicknameHeading}
              </Heading>
              <Input
                value={profile.nickname}
                onChange={handleNicknameChange}
                onBlur={handleNicknameBlur}
                bg="surfaceBg"
                data-testid="profile-nickname-input"
              />
              <HStack justify="flex-end" mt={2}>
                <Text
                  fontSize="xs"
                  color={nicknameCapped ? 'red.400' : 'textMuted'}
                  data-testid="profile-nickname-bytecount"
                >
                  {utf8ByteLength(profile.nickname)}/{NICKNAME_MAX_BYTES}
                </Text>
              </HStack>
              {nicknameCapped && (
                <Text fontSize="xs" color="red.400" mt={1} data-testid="profile-nickname-limit">
                  {copy.settings.nicknameLimit(NICKNAME_MAX_BYTES)}
                </Text>
              )}
            </Box>

            <Box>
              <Heading as="h2" size="md" mb={3}>
                {copy.settings.avatarHeading}
              </Heading>
              <HStack
                align={{ base: 'stretch', md: 'center' }}
                spacing={4}
                flexDirection={{ base: 'column', md: 'row' }}
              >
                <Box
                  w={{ base: '100%', md: '140px' }}
                  minW={{ md: '140px' }}
                  p={3}
                  borderWidth="1px"
                  borderRadius="xl"
                  borderColor="borderSubtle"
                  bg="surfaceMutedBg"
                >
                  {/* A profile always carries an avatar (seeded on hydration),
                      so the image is the only state. The empty box only shows
                      for the brief pre-hydration frame before the saved
                      profile loads. */}
                  {profile.avatar ? (
                    <Image
                      src={profile.avatar.imageUrl}
                      alt={copy.settings.selectedAvatarAlt}
                      w="100%"
                      aspectRatio={1}
                      objectFit="contain"
                      bg="white"
                      borderRadius="lg"
                    />
                  ) : (
                    <Box aspectRatio={1} borderRadius="lg" bg="surfaceBg" />
                  )}
                </Box>

                <VStack align="stretch" spacing={3} flex={1}>
                  <HStack spacing={3} flexWrap="wrap">
                    <Button onClick={avatarDisclosure.onOpen} data-testid="choose-avatar-btn">
                      {copy.settings.changeAvatar}
                    </Button>
                  </HStack>
                </VStack>
              </HStack>
            </Box>
          </VStack>
        </Box>

        <Divider />

        {/* Share contact card — the same surface the contacts page mounts at
            the top of its list; see ShareContactCard for the cache/signer
            rationale. */}
        <ShareContactCard />

        {/* Backup hint — shown when the identity seed phrase hasn't been backed up */}
        {!backedUp && (
          <>
            <Divider />
            <Alert status="warning" borderRadius="md" data-testid="profile-backup-hint">
              <AlertIcon />
              <AlertDescription fontSize="sm">
                {copy.profile.backupNeededHint}{' '}
                <NextLink href="/settings" passHref legacyBehavior>
                  <Text as="a" fontWeight="semibold" textDecoration="underline" display="inline">
                    {copy.layout.nav.settings}
                  </Text>
                </NextLink>
              </AlertDescription>
            </Alert>
          </>
        )}
      </VStack>

      <AvatarBrowserModal
        isOpen={avatarDisclosure.isOpen}
        onClose={avatarDisclosure.onClose}
        onSelect={handleAvatarSelect}
        initialAvatar={profile.avatar}
      />
    </>
  );
}

export type ProfileAddToGroupMarkerDeps = {
  markPendingDirectInvite: (groupId: string, pubkey: string) => Promise<void>;
  clearPendingDirectInvite: (groupId: string, pubkey: string) => Promise<void>;
};

/**
 * Wraps the profile-page direct-invite call with pending-direct-invite
 * marker bookkeeping (epic: invite-rescind-and-member-removal S8 — the
 * profile.tsx mirror of InviteMemberModal.tsx's submitInviteWithMarker,
 * S7). Ordering guarantee (AC-MARKER-1): the marker write is fully
 * awaited BEFORE inviteByNpub is ever called, so the marker exists at the
 * exact moment inviteByNpub could be invoked. Both the write
 * (AC-MARKER-2) and the failure-path clear (AC-MARKER-3) are best-effort:
 * a thrown/rejected marker op is caught, logged via console.warn, and
 * never blocks or rethrows. The marker is cleared only when
 * inviteByNpub resolves {ok:false} — a successful invite deliberately
 * keeps its marker so the UI can keep offering "Cancel Invite".
 *
 * inviteByNpub itself is never modified by this wrapper — approveJoinRequestImpl
 * calls inviteByNpub directly via a different call path (MarmotContext.tsx:515)
 * and must never pick up a marker write (AC-MARKER-4), which is exactly why this
 * bookkeeping lives in a wrapper here rather than inside inviteByNpub.
 */
export async function addToGroupWithMarker(
  pubkeyHex: string,
  groupId: string,
  inviteByNpub: (groupId: string, npub: string) => Promise<{ ok: boolean; error?: string }>,
  markerDeps: ProfileAddToGroupMarkerDeps,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await markerDeps.markPendingDirectInvite(groupId, pubkeyHex);
  } catch (err) {
    console.warn('[ProfilePage] pending-invite marker write failed (non-blocking):', err);
  }

  const result = await inviteByNpub(groupId, pubkeyToNpub(pubkeyHex));

  if (!result.ok) {
    try {
      await markerDeps.clearPendingDirectInvite(groupId, pubkeyHex);
    } catch (err) {
      console.warn('[ProfilePage] pending-invite marker clear failed (non-blocking):', err);
    }
  }

  return result;
}

/**
 * Code-level guard behind the profile page's "Add to group" action (epic:
 * pending-contact-profile-gate, AC-PEND-6). Returns `true` only for a contact
 * that may actually be invited to a group; `false` otherwise. This is the
 * enforcement that backs the disabled Add-to-group button on a pending
 * contact's profile — a bypassed click still cannot invite an unconfirmed
 * contact, because `handleAddToGroup` early-returns when this is `false`.
 *
 * A contact is not addable when:
 *   - it is null (no contact record), or
 *   - it is archived (blocked) — already gated by the blocked branch, but
 *     enforced here too so the guard is complete on its own, or
 *   - it is pending confirmation (unconfirmed) — the case this epic adds.
 *
 * Pure and synchronous; takes only the two boolean-bearing fields so it is
 * trivially unit-testable without a full `ContactListItem` (repo convention:
 * tests/unit only, no jsdom/renderHook — mirrors `planProfileAnnounceFanout`).
 */
export function canAddContactToGroup(
  contact: Pick<ContactListItem, 'isArchived' | 'isPendingConfirmation'> | null,
): boolean {
  if (!contact) return false;
  if (contact.isArchived) return false;
  if (contact.isPendingConfirmation) return false;
  return true;
}

export default function ProfilePage() {
  const router = useRouter();
  const copy = useCopy();
  const { pubkeyHex: ownPubkeyHex } = useNostrIdentity();
  const { groups, inviteByNpub, getGroup, groupDataVersion } = useMarmot();
  const [version, setVersion] = useState(0);
  // const [npubCopied, setNpubCopied] = useState(false); // npub display hidden — see handleCopyNpub/JSX below
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [addToGroupStatus, setAddToGroupStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [adminGroupIds, setAdminGroupIds] = useState<Set<string>>(new Set());

  const pubkeyHex = typeof router.query.pubkey === 'string' ? router.query.pubkey : null;
  const isOwnProfile = !pubkeyHex || pubkeyHex === ownPubkeyHex;

  // Resolve admin groups only when viewing another user's profile
  useEffect(() => {
    if (isOwnProfile || !pubkeyHex || !ownPubkeyHex) {
      setAdminGroupIds(new Set());
      return;
    }
    let cancelled = false;
    const candidates = eligibleGroupsForContact(groups, pubkeyHex);
    void Promise.all(
      candidates.map(async (group) => {
        const mlsGroup = await getGroup(group.id).catch(() => null);
        const admins = mlsGroup?.groupData?.adminPubkeys ?? [];
        const isAdmin = admins.some((pk) => pk.toLowerCase() === ownPubkeyHex.toLowerCase());
        return isAdmin ? group.id : null;
      }),
    ).then((ids) => {
      if (cancelled) return;
      setAdminGroupIds(new Set(ids.filter((id): id is string => id !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [groups, pubkeyHex, ownPubkeyHex, getGroup, groupDataVersion, isOwnProfile]);

  const contact: ContactListItem | null = useMemo(() => {
    if (isOwnProfile || !pubkeyHex || !ownPubkeyHex) return null;
    return getContact(pubkeyHex, ownPubkeyHex, { includeArchived: true });
  }, [pubkeyHex, ownPubkeyHex, version, isOwnProfile]);

  if (isOwnProfile) {
    return (
      <>
        <Head>
          <title>{`${copy.profile.pageTitle} - ${copy.appName}`}</title>
        </Head>
        <Box data-testid="profile-page">
          <Heading as="h1" size="xl" mb={2}>
            {copy.profile.ownHeading}
          </Heading>
          <Text color="textMuted" mb={6}>
            {copy.profile.ownDescription}
          </Text>
          <OwnProfileSection />
        </Box>
      </>
    );
  }

  const npub = pubkeyToNpub(pubkeyHex!);
  const displayName = contact?.nickname || truncateNpub(npub);
  const avatar = contact?.avatar ?? null;
  // A blocked (archived) contact's profile is a management-only view: the
  // Send message / Add to group actions are hidden (Send message would only
  // route into the now-redirecting detail page), the identity is visually
  // de-emphasised, and Unblock is promoted to the primary call to action.
  const isBlocked = !!contact?.isArchived;
  // A pending (unconfirmed) contact's profile mirrors the contacts overview's
  // inline gate (epic: pending-contact-profile-gate): Confirm + Reject replace
  // the plain Block button, and Send message / Add to group stay VISIBLE but
  // DISABLED (a preview of what Confirm unlocks — unlike the blocked branch,
  // which hides them). Blocked wins over pending (pending-contact-confirmation
  // DD-9), so this is only true when NOT blocked.
  const isPending = !isBlocked && !!contact?.isPendingConfirmation;

  const addableGroups = addableGroupsForContact(groups, pubkeyHex!, adminGroupIds);
  const effectiveGroupId = selectedGroupId || addableGroups[0]?.id || '';

  // function handleCopyNpub() {
  //   navigator.clipboard.writeText(npub).catch(() => {});
  //   setNpubCopied(true);
  //   setTimeout(() => setNpubCopied(false), 2000);
  // }

  async function handleAddToGroup() {
    if (!effectiveGroupId || !pubkeyHex) return;
    // Code-level enforcement (AC-PEND-6): never invite a pending/unconfirmed
    // (or blocked) contact to a group, even if the disabled button were
    // bypassed. The UI already disables the control while pending; this is the
    // guarantee behind it.
    if (!canAddContactToGroup(contact)) return;
    setAddToGroupStatus('loading');
    try {
      const result = await addToGroupWithMarker(pubkeyHex, effectiveGroupId, inviteByNpub, {
        markPendingDirectInvite,
        clearPendingDirectInvite,
      });
      if (result.ok) {
        setAddToGroupStatus('success');
        setSelectedGroupId('');
      } else {
        setAddToGroupStatus('error');
      }
    } catch {
      setAddToGroupStatus('error');
    }
  }

  // Confirm a pending contact directly from their profile (AC-PEND-5). Reuses
  // the shared confirm+reconcile bundle (confirmContact + clearPendingContact +
  // DM-count reconcile), then bumps `version` so the `contact` memo re-derives
  // and this branch flips to the confirmed (normal) layout in place — no
  // navigation, mirroring the contacts-overview inline confirm.
  async function handleConfirmPending() {
    if (!pubkeyHex || !ownPubkeyHex) return;
    await confirmPendingContact(pubkeyHex, ownPubkeyHex);
    setVersion((v) => v + 1);
  }

  return (
    <>
      <Head>
        <title>{`${displayName} - ${copy.profile.pageTitle} - ${copy.appName}`}</title>
      </Head>
      <Box data-testid="profile-page">
        <Button variant="ghost" size="sm" mb={4} onClick={() => router.back()}>
          ← {copy.profile.backLabel}
        </Button>

        <VStack align="start" spacing={6}>
          <HStack spacing={4} align="center" opacity={isBlocked ? 0.6 : 1}>
            <AvatarDisplay avatar={avatar} displayName={displayName} size="80px" />
            <VStack align="start" spacing={1}>
              <HStack spacing={2} align="center">
                <Heading as="h1" size="lg">
                  {displayName}
                </Heading>
                {isBlocked && (
                  <Badge colorScheme="neutral" data-testid="profile-blocked-badge">
                    {copy.contacts.hiddenBadge}
                  </Badge>
                )}
              </HStack>
            </VStack>
          </HStack>

          {isBlocked && (
            <Alert status="info" borderRadius="md" data-testid="profile-blocked-notice">
              <AlertIcon />
              <AlertDescription fontSize="sm">{copy.profile.blockedNotice}</AlertDescription>
            </Alert>
          )}

          {/* Pending (unconfirmed) contact: explanatory notice mirroring the
              overview's confirm prompt, reusing the existing pending-confirm
              copy — no new i18n keys (epic: pending-contact-profile-gate). */}
          {isPending && (
            <Alert
              status="info"
              borderRadius="md"
              flexDirection="column"
              alignItems="flex-start"
              gap={1}
              data-testid="profile-pending-notice"
            >
              <HStack>
                <AlertIcon />
                <Text fontWeight="semibold">{copy.contacts.pendingConfirmHeading}</Text>
              </HStack>
              <AlertDescription fontSize="sm">
                {copy.contacts.pendingConfirmBody(displayName)}
              </AlertDescription>
            </Alert>
          )}

          {/* npub display hidden on contact profile — see handleCopyNpub/npubCopied above
          <HStack spacing={3} align="center" flexWrap="wrap">
            <Code fontSize="xs" userSelect="all" data-testid="profile-npub">
              {truncateNpub(npub)}
            </Code>
            <Button size="xs" variant="outline" onClick={handleCopyNpub}>
              {npubCopied ? copy.profile.copiedNpub : copy.profile.copyNpub}
            </Button>
          </HStack>
          */}

          {!isBlocked && (
            <Button
              colorScheme="brand"
              onClick={() => router.push(`/contacts?id=${pubkeyHex}`)}
              isDisabled={isPending}
              data-testid="profile-send-dm"
            >
              {copy.profile.sendDm}
            </Button>
          )}

          {!isBlocked && contact && addableGroups.length > 0 && (
            <Box w="100%" maxW="sm" data-testid="profile-add-to-group">
              <Text fontWeight="medium" mb={2}>
                {copy.profile.addToGroupLabel}
              </Text>
              {addToGroupStatus === 'success' && (
                <Alert status="success" borderRadius="md" mb={3} data-testid="profile-add-to-group-success">
                  <AlertIcon />
                  <AlertDescription>{copy.profile.addToGroupSuccess}</AlertDescription>
                </Alert>
              )}
              {addToGroupStatus === 'error' && (
                <Alert status="error" borderRadius="md" mb={3} data-testid="profile-add-to-group-error">
                  <AlertIcon />
                  <AlertDescription>{copy.profile.addToGroupError}</AlertDescription>
                </Alert>
              )}
              <HStack spacing={3} align="stretch">
                <Select
                  value={effectiveGroupId}
                  onChange={(e) => {
                    setSelectedGroupId(e.target.value);
                    setAddToGroupStatus('idle');
                  }}
                  aria-label={copy.profile.addToGroupSelect}
                  data-testid="profile-add-to-group-select"
                  bg="surfaceBg"
                  isDisabled={isPending}
                >
                  {addableGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </Select>
                <Button
                  colorScheme="brand"
                  flexShrink={0}
                  onClick={() => void handleAddToGroup()}
                  isLoading={addToGroupStatus === 'loading'}
                  isDisabled={!effectiveGroupId || isPending}
                  data-testid="profile-add-to-group-btn"
                >
                  {copy.profile.addToGroupBtn}
                </Button>
              </HStack>
            </Box>
          )}

          {/* Pending: the standalone Block button is REPLACED by the Confirm +
              Reject pair (AC-PEND-1/AC-PEND-4) — the same inline actions the
              contacts overview shows. Reject IS the block flow relabelled, so
              no separate Block button is offered while pending. */}
          {contact && isPending ? (
            <HStack spacing={3} align="center" flexWrap="wrap" data-testid="profile-pending-actions">
              <ConfirmButton
                size="md"
                onClick={() => void handleConfirmPending()}
                data-testid="profile-pending-confirm"
              >
                {copy.contacts.pendingConfirmButton}
              </ConfirmButton>
              <BlockContactButton
                peerPubkeyHex={contact.pubkeyHex}
                isArchived={false}
                label={copy.contacts.pendingRejectButton}
                danger
                onChanged={() => {
                  // Reject-is-block: clear the pending-contact bell entry so no
                  // stranded contribution remains in the badge total, then bump
                  // version so the profile re-derives (the block itself flips
                  // this branch to the blocked layout).
                  clearPendingContact(contact.pubkeyHex);
                  setVersion((v) => v + 1);
                }}
                testId="profile-pending-reject"
              />
            </HStack>
          ) : contact ? (
            <BlockContactButton
              peerPubkeyHex={contact.pubkeyHex}
              isArchived={contact.isArchived}
              prominent={isBlocked}
              danger
              onChanged={() => setVersion((v) => v + 1)}
            />
          ) : null}
        </VStack>
      </Box>
    </>
  );
}
