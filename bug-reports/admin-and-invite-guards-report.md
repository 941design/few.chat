# Leave can strand a group with zero admins; invite picker mislabels a pending invitee as "already in group"

Source: BACKLOG.json findings `two-co-admins-leaving-at-nearly` and the label half of
`invite-modal-picker-cannot-re-invite`; decided 2026-10-17 by Fable on the owner's delegation
(bug-reports/product-decisions-fable-2026-10-17.md, items 6 and 7).

## 1. Zero-admin race on leave
Actual: the sole-admin leave block is evaluated in the leave modal against the last-known
adminPubkeys (selectLeaveModalState → isSoleAdmin); leaveGroupImpl does no re-check at execution
time, so two co-admins leaving at nearly the same moment can both pass and the group ends with
zero admins (frozen membership).
Expected (decided): leaveGroupImpl re-reads adminPubkeys from the current MLS state at execution
time (inside try/catch, per the twin-read discipline in project memory
leave_guard_discipline_twin_reads — fail-closed direction to be chosen deliberately) and aborts
the leave if the leaver is now the sole admin, surfacing the existing `lastAdminLeaveBlocked` copy.
The residual window (both pass before either departure is processed) is documented in
docs/behavior/groups.md §8 as a sub-case of the accepted "no admin reachable" failure.

## 2. Invite picker label
Actual: after A invites B, B's picker option is disabled as "already in group" until B accepts,
because memberPubkeys updates at the MLS commit.
Expected (decided): a distinct disabled reason `invite_pending` when the contact is a member who has
not yet confirmed (the existing confirmedPubkeys / Pending-badge signal), labelled
en "invitation pending" / de "Einladung ausstehend" (lowercase, like inviteReasonAlreadyMember).
Resend is NOT in scope (owner question).
