# Acceptance Criteria — Pending-contact profile gate

## AC-PEND-1 — Confirm + Reject shown on a pending profile
On the profile page for a contact whose `isPendingConfirmation` is true (and not
archived), a Confirm control and a Reject control are rendered — mirroring the
contacts overview's inline pair. Observable: both a Confirm button
(`copy.contacts.pendingConfirmButton`) and a Reject button
(`copy.contacts.pendingRejectButton`) are present.

## AC-PEND-2 — Send message disabled while pending
On a pending contact's profile the Send message button is visible but disabled
(`isDisabled`). It is NOT hidden. On a normal (confirmed) contact's profile it is
enabled, unchanged.

## AC-PEND-3 — Add to group disabled while pending
On a pending contact's profile, when addable groups exist, the group Select and
the Add-to-group button are visible but disabled. On a normal contact's profile
they are enabled, unchanged.

## AC-PEND-4 — Block button replaced by Confirm + Reject while pending
On a pending contact's profile, the standalone Block button
(`copy.profile.archiveAction`) is NOT rendered; the Confirm + Reject pair takes
its place. On a normal contact's profile the Block button is rendered, unchanged.
On a blocked contact's profile the Unblock button is rendered, unchanged.

## AC-PEND-5 — Confirm flips the profile to normal in place
Activating Confirm on a pending profile runs the confirm+reconcile bundle
(`confirmPendingContact`), clears the pending state, and re-derives the profile so
it shows the confirmed (normal) layout — enabled Send message, enabled Add to
group, standalone Block — without a navigation.

## AC-PEND-6 — Code-level enforcement: pending contact cannot be added to a group
`handleAddToGroup` refuses to invoke the group-invite path when the contact is
pending. The extracted pure guard `canAddContactToGroup(contact)` returns `false`
for a pending contact (and for a null/archived contact) and `true` for a normal
contact. Even if the disabled Add button were bypassed, no invite is issued for a
pending contact.

## AC-PEND-7 — Existing surfaces unchanged
The contacts overview pending row (inline Confirm/Reject, non-link), the
contact-chat redirect for pending/blocked contacts, and the profile blocked branch
all behave exactly as before.

## Manual Validation
(none — all ACs are code/e2e verifiable.)
