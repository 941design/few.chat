# Pending-contact profile gate

**Status**: pre-implementation

## Problem

A contact that is awaiting the user's explicit confirmation (pending
confirmation — `contact.isPendingConfirmation`) is fully gated on the **contacts
overview** and on the **contact chat**: the overview row shows inline Confirm +
Reject buttons and is not a link, and the chat detail view redirects a pending
contact back to the overview. But the **profile page** (`/profile?pubkey=<hex>`,
reachable from the overview's "view profile" icon) was never taught the pending
state. It only branches on blocked (archived). So an unconfirmed contact's
profile still renders an **active** Send message button, an **active** Add to
group control, and an **active** Block button — letting a user message or
group-invite a contact they have not yet confirmed, straight past the gate every
other surface enforces.

## Solution

Teach the profile page the pending state, mirroring the contacts overview's
inline treatment and the profile page's own existing blocked branch:

1. On a pending contact's profile, show the **Confirm** + **Reject** pair — the
   same actions shown inline on the contacts overview. Confirm runs the existing
   `confirmPendingContact` bundle and re-derives the profile in place; Reject is
   the existing block flow relabelled "Reject".
2. Keep **Send message** and **Add to group** visible but **disabled** while
   pending (a preview of what unlocks on Confirm) — this differs from the blocked
   branch, which hides them.
3. **Replace** the plain Block button with the Confirm + Reject pair for pending
   contacts (Reject already routes through the block flow, so no separate Block
   button is shown while pending).
4. **Enforce in code** that an unconfirmed contact cannot be added to a group:
   `handleAddToGroup` refuses when the contact is pending, so a disabled-button
   bypass still cannot invite a pending contact.

## Scope

### In Scope
- `app/pages/profile.tsx`: the "viewing another user's profile" render branch and
  its `handleAddToGroup` handler.
- A small exported pure guard (`canAddContactToGroup`) for the code-level
  enforcement, unit-tested per repo conventions.

### Out of Scope
- The contacts overview and contact-chat behavior (already gate pending correctly;
  must not be weakened).
- The blocked (archived) branch behavior (unchanged).
- Any new i18n keys — all required copy already exists
  (`contacts.pendingConfirm*` / `pendingReject*`, `profile.sendDm`,
  `profile.addToGroup*`).

## Design Decisions

1. **Blocked wins over pending** (epic pending-contact-confirmation, DD-9):
   compute `isPending = !isBlocked && !!contact.isPendingConfirmation`, mirroring
   `app/pages/contacts.tsx`'s row logic. A contact that is both pending and
   blocked renders the blocked branch.
2. **Disabled, not hidden** for Send message / Add to group while pending — the
   product owner's explicit choice, previewing the post-confirm affordances.
3. **Reject is block** (spec-wide non-goal: no separate reject mechanism). Reject
   reuses `BlockContactButton` with `label = copy.contacts.pendingRejectButton`,
   exactly as the overview row and `PendingConfirmationPrompt` already do.
4. **Confirm reuses `confirmPendingContact`** (exported from
   `PendingConfirmationPrompt.tsx`): `confirmContact` + `clearPendingContact` +
   `reconcileConfirmedContactDirectMessageCount`. After it resolves, bump the
   page's local `version` counter so the `contact` memo re-derives and the profile
   flips to its confirmed (normal) layout in place.
5. **Code guard is a pure, exported function** (`canAddContactToGroup`) so the
   enforcement is unit-testable without jsdom/renderHook — consistent with the
   existing exported pure helpers `planProfileAnnounceFanout` /
   `addToGroupWithMarker` in the same file.

## Technical Approach

Affected file: `app/pages/profile.tsx`.

- Derive `isPending` alongside the existing `isBlocked`.
- Send-message button: render for `!isBlocked` (normal + pending) with
  `isDisabled={isPending}`.
- Add-to-group block: unchanged render condition (`!isBlocked && contact &&
  addableGroups.length > 0`); disable the `<Select>` and the Add button when
  `isPending`.
- `handleAddToGroup`: early-return via `canAddContactToGroup(contact)` before any
  `inviteByNpub` call.
- Bottom action: render the plain `BlockContactButton` only when `!isPending`;
  when `isPending`, render `ConfirmButton` (confirm handler) + `BlockContactButton`
  (relabelled Reject).
- Optional pending notice `Alert` reusing `copy.contacts.pendingConfirmHeading` /
  `pendingConfirmBody(displayName)` for parity with the blocked notice.

## Stories

Single story — one file plus a unit test for the extracted guard.

## Non-Goals

- No change to how a contact enters the pending state.
- No new "reject" mechanism distinct from block.
- No public broadcast of any profile data (privacy invariant unchanged; this epic
  reads local contact state and reuses existing confirm/block flows only).
