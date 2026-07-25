# few.chat design rationales

Standing user-interface design rules, each with its reasoning. These are the
presentation-layer counterpart to the behaviour specification in
[`docs/behavior/`](behavior/README.md), which deliberately avoids UI detail:
behaviour docs say *what* the product does; this document says *how the UI
expresses it* and why.

Each rule is a general design choice, not a one-off. When a new rule of general
scope is stated during development, append it here in the same shape
(**Rule** / **Why** / **How to apply**) — do not leave it only in a commit
message, spec, or agent memory.

## No concrete example names

No concrete example names may appear anywhere in the application — not for
users, not for groups.

**Why:** Concrete placeholder names (e.g. "Alex") read as real content and
personalize the UI in a way the product deliberately avoids.

**How to apply:** Use generic placeholders instead. For name fields, follow the
established pattern `profileNamePlaceholder` → `'You'` / `'Du'` in
`app/src/lib/i18n.ts`. Group/poll fields already use generic labels ("Group
Name", "Option A"). Non-name example strings that are conventions (e.g.
`relay.example.com`) or label-purpose hints ("Sent to class chat") are fine —
the rule targets personal/group *names* specifically.

## Negative actions are danger outline, affirmative actions solid

Negative actions on contact/member components (rejecting group admission/Deny,
rejecting a contact request, removing a group member, cancelling an invite,
blocking) are **always** styled as a danger *outline* button
(`variant="outline" colorScheme="danger"`) — never solid. Affirmative actions
(Confirm, Approve, Make admin) stay **solid**.

**Why:** The two action categories are deliberately asymmetric. Affirmative
actions are solid so they read as the encouraged path; negative actions are a
danger outline — clearly destructive (red) yet visually secondary, so a
reject/remove never competes with the affirmative action for the eye.

**How to apply:**

- `RejectButton` in `app/src/components/UserCard.tsx` is the canonical negative
  affordance (danger outline) — used for Deny, Cancel invite, Remove member.
  `ConfirmButton` beside it stays solid success.
- `BlockContactButton`'s `danger` prop puts its block/Reject trigger into the
  same danger-outline treatment; every reject/block reuse passes it (profile
  page, contacts-list pending row, `PendingConfirmationPrompt`).
- Scope is the inline action buttons on the cards. Final confirm buttons inside
  a destructive confirm **modal** stay solid danger (matches `LeaveGroupButton`,
  `BlockContactButton`'s block-confirm-btn) — the dialog's primary action
  should be prominent.

## Minimal info text — omit copy the affordance already conveys

Keep informational / helper text in the UI to a minimum. When an action is
self-explanatory from its own affordance, omit the explanatory copy (headers,
hint lines, instructional captions) entirely rather than restating what the
control already conveys.

**Why:** Redundant chrome (a heading that names what the user just tapped, a
sentence describing an obviously-interactive control) adds visual noise and
reading burden without adding information. A live camera viewfinder, for
instance, already reads unambiguously as "scan" — a "Scan QR Code" heading and
a "Point the camera at a QR code" hint tell the user nothing the viewfinder
doesn't.

**How to apply:** Drop the header and hint when the surface is self-evident
(the QR-scanner overlay in `app/src/components/QrScanFab.tsx` renders neither).
Preserve accessibility when you drop a visible heading: give the dialog an
accessible name via `aria-label` on the `ModalContent` (role=dialog) so screen
readers still announce it. Delete the now-dead i18n strings rather than leaving
orphaned copy. Error/empty/rejection states and genuinely non-obvious flows
still get their text — the rule targets redundant reassurance, not all copy.
