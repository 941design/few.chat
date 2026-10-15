# Small UI / count / codec bugs (six findings)

Source: BACKLOG.json findings promoted 2026-10-15 (triage-verified against current code):

1. `profile-page-add-group-success-confirmation` — the Add-to-Group success/error Alerts are inside the
   `addableGroups.length > 0` gate (app/pages/profile.tsx ~:817-822); after the invite the contact is a
   pending member, the list empties and the whole block (incl. the success Alert) unmounts in the same
   render → confirmation unreachable in the common single-group case. Fix: render the confirmation
   outside the gate (copy already exists in i18n).
2. `create-group-enabled-before-client-ready` — create-group-btn (app/pages/groups.tsx ~:1209-1213) is
   enabled before MarmotContext `ready` (in scope ~:1097); early submit → createGroup returns null →
   generic error. Fix: disable the button (and/or modal submit) until ready.
3. `one-time-migration-clear-stale-unread` — DirectMessageNotificationsWatcher (~:24-30) /
   initDirectMessageCounts prune with isAllowedDmSender, which blocked (archived) peers pass, so their
   unread counters keep counting (unreadStore.ts ~:642). Fix: exclude archived/blocked contacts from the
   unread counters at startup (counters only, never history); idempotent.
4. `stale-foreign-group-invite-expiry-count` — invite-expiry counters for groups not in the current
   list (backup-restore residue) count toward the groups badge with no clear path
   (unreadStore.ts ~:482-499, notificationCounts.ts ~:79-90). Fix: prune keys for absent groups on
   groups-list load, guarded against transient not-ready states (never prune while groups are loading).
5. `decodecard-accepts-signed-name-len-0` — decodeCard (app/src/lib/contactCard.ts ~:595) accepts a
   signed card with name_len=0, which encodeCard never emits (LWW empty-name clobber path). Decision
   (technical, restores encoder/decoder symmetry; no user-visible change since no client emits it):
   reject it as malformed.
6. `gate-incoming-calls-with-block-deny` — IncomingCallWatcher.tsx ~:149-158 gates on isAllowedDmSender
   only; a blocked peer can ring. Fix: compose isBlockedPeer for 1:1 calls (mirror the DM composite).
   Group calls are OUT of scope (owner product question Q8). Calls are feature-flagged off
   (features.ts CALLS_ENABLED=false) — unit-test the gate; no e2e possible.

## Constraints
i18n (no hardcoded strings; en+de), docs/design-rationales.md rules for UI, behaviour docs updated where
user-visible behaviour changes (badge counts, button state, confirmation).
