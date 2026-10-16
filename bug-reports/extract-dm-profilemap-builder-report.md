# Extract the DM profileMap builder; tidy feedback-mode gating in ContactChat

Source: BACKLOG.json finding `extract-dm-profilemap-builder-tidy-feedback` (2026-06-15). This is a
pure refactor. No user-facing behaviour changes.

## Verified against current code

- The two-entry (self + one peer) `MemberProfile` map is still built in exactly two DM surfaces:
  `app/pages/feedback.tsx` (`FeedbackPage`) and `app/pages/contacts.tsx` (`ContactDetailView`). The
  self entry was the same in both: nickname `ownProfile.nickname || truncateNpub(pubkeyToNpub(self))`,
  avatar `ownProfile.avatar`, `updatedAt: new Date().toISOString()`. Only these two pages render
  `<ContactChat>`. No third DM surface has appeared.
- `app/pages/groups.tsx` also adds an own-profile entry, but it is a group map with different
  semantics (it adds the entry only when a nickname is set and has no npub fallback). It is out of
  scope and was left alone.
- `ContactChat` checked `source === 'feedback'` / `!== 'feedback'` four times. The finding counted
  three; a fourth, `allowMessageActions`, was added later by the block-contact epic.

## Change

1. `buildDmProfileMap({ selfHex, selfProfile, peerHex, peerNickname, peerAvatar, peerUpdatedAt? })`
   is now in `app/src/lib/contacts.ts`. That module already owns contact and peer data and imports
   `nostrKeys`. Both pages call it, so the self-profile literal exists in one place only.
   - Self entry: same fallback, avatar and build-time `updatedAt` as before.
   - Peer entry: the caller resolves the nickname. Contacts passes `contact.nickname || fallbackName`;
     feedback passes `MAINTAINER_DISPLAY_NAME`. `peerUpdatedAt` defaults to the build time, which is
     the old feedback behaviour. Contacts passes `contact.updatedAt ?? contact.lastSeenAt`.
   - The entries are inserted in the same order as before, so if `selfHex === peerHex` the peer entry
     still wins.
2. `ContactChat` now sets `const isFeedback = source === 'feedback'` once. All four send-path gates are
   still separate, explicit checks:
   - the text marker tags
   - `onReact`
   - `allowImageAttachments`, which also drives ChatBox's paste and drop guards
   - `allowMessageActions`

   The `sendMessage` dependency list now uses `isFeedback` instead of `source`. No `FeedbackChat`
   wrapper was added, as the finding asked.
3. A comment in `attachmentsFeatureToggle.test.ts` quoted the old gate expression and was updated.

## Deviation

- On the feedback page, the self and peer `updatedAt` values used to come from two separate
  `new Date()` calls. They now share one timestamp taken when the map is built. The two values were
  already equal or less than a millisecond apart, and nothing depends on the difference.

## Verification

- New `app/tests/unit/buildDmProfileMap.test.ts` has 6 tests:
  - the exact map shape
  - the fallback to the truncated npub when the own nickname is empty
  - peer `updatedAt` when omitted (build time) and when provided, with self always at build time
  - the peer nickname passed through unchanged
  - `self === peer` collapsing to the peer entry
- Unit suite: 251 files, 5595 passed, 1 skipped. The baseline was 250 files, 5589 passed, 1 skipped.
- `tsc --noEmit` is clean.
- e2e was not run (dev role). The full gate belongs to the lead.
- Behaviour docs: no change, because this is a pure refactor.
