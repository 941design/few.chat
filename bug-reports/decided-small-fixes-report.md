# Decided small fixes: blank leave name, persisted backup dirty mark, account-switch cross-tab notice, share-card signer-mismatch error

Source: four BACKLOG.json findings whose product question was decided on 2026-10-17 by Fable on the
owner's delegation (bug-reports/product-decisions-fable-2026-10-17.md, items 1, 2, 4, 5):
- `leave-announcement-blank-name-when-profile-unknown`
- `backup-dirty-mark-lost-on-early-reload`
- `cross-tab-account-switch-notice`
- `share-contact-card-permanently-fails-when`

## 1. Blank name in the "left the group" announcement
Actual: with the leaver's profile unknown (or nickname ''), the row reads " left the group".
`profileMap[pk]?.nickname` can be '' and `??` passes it through (ChatBox.tsx ~:559-561).
Expected: blank/whitespace nickname is treated as absent, so the row falls back to the truncated
npub exactly like the sibling announcements and MemberList. No new copy.
Also: groups-leave-intent AC-MEMBERS-2 (app/tests/e2e/groups-leave-intent.spec.ts ~:198-204) must
wait for profile propagation before asserting the name (retrying toBeVisible, no reload polling).

## 2. Backup dirty mark lost on early reload
Actual: markBackupDirty before the identity loads stores the mark in in-memory pendingDirty
(BackupContext.tsx ~:67-90); a reload in that window loses it.
Expected: an unsent dirty mark is persisted in localStorage (key `few-backup-dirty`), set by every
markBackupDirty path, cleared only after a successful publish, and replayed when the scheduler
activates. Privacy unchanged (only the timing of an already-allowed, self-encrypted publish).
docs/behavior/backup-and-recovery.md updated accordingly.

## 3. Account switch / wipe sends no cross-tab notice
Actual: clearing all local data on an account switch (storage wipe path) posts nothing; another open
tab keeps serving the old account's reactions and other cached state.
Expected: the wipe posts an account-changed event on the existing crossTab channel; receiving tabs
reload so they come up on the current account's (or empty) state.

## 4. Share contact card dead end on signer/identity mismatch
Actual: with a NIP-46/NIP-07 signer whose pubkey differs from the local identity, encodeCard's guard
throws and settings.tsx handleOpenShareCard shows the generic retry-implying shareCardError forever.
Expected: this case shows a distinct actionable error:
- en: "Your signer holds a different identity than this profile. Reconnect a signer for this identity or switch back to the local key."
- de: "Dein Signierer gehört zu einer anderen Identität als dieses Profil. Verbinde einen Signierer für diese Identität oder wechsle zurück zum lokalen Schlüssel."
Connect-time rejection of a mismatched signer is NOT in scope (owner question).

## Impact
Low-medium UX/integrity defects; each independently small.
