# few.chat behaviour specification

Human-readable, product-level specifications of how few.chat behaves — one document
per topic. These describe **current, intended behaviour**: the states things can be
in, what moves them between states, the confirmations and invariants that hold, the
edge cases, and the reasoning behind key decisions. They deliberately avoid
implementation detail and user-interface presentation.

These documents are created and maintained with the `/behavior-docs` skill, and must
be updated in the same run as any feature or bug work that changes user-facing
behaviour. UI presentation rules live separately in
[`docs/design-rationales.md`](../design-rationales.md).

## Topics

- **[Groups](groups.md)** — creating a group; the admin and member roles and granting
  admin; bringing people in (invite by identity, invite links, join requests,
  cancelling an invitation); joining (pull-only Welcomes, auto-accept, onboarding);
  renaming; leaving; removing a departed member; and the failure modes.
- **[Contacts & direct messages](contacts-and-direct-messages.md)** — adding a contact
  (by identity, by scanning a card), pending & issuer confirmation, blocking, keeping
  profiles in sync, sending/receiving DMs, and the walled-garden reachability model
  (ever-known peers).
- **[Profiles & identity](profiles-and-identity.md)** — the auto-generated identity and
  key packages; setting a name and avatar; the never-public privacy invariant; and how
  profiles propagate (signed in-group, unsigned to contacts) and heal.
- **[Reactions & emoji](reactions-and-emoji.md)** — reacting to messages in groups and DMs,
  the curated emoji set, aggregation, and the group (member-attested) vs DM (authenticated)
  trust difference.
- **[Message editing & deletion](message-editing-and-deletion.md)** — editing/deleting your
  own messages, the revision-clock convergence rule, author-only (DM authenticated, group
  member-attested) enforcement, and what a delete does not reach.
- **[Polls](polls.md)** — creating a group poll, voting and changing a vote, when results
  become visible, creator-only closing, and the honest limits of vote secrecy and
  attribution.
- **[Notifications & unread](notifications-and-unread.md)** — what raises the in-app
  notification indicator (messages, join requests, expiring links), the "never notify"
  invariants (own/open/stranger/blocked/pending), and how unread counts stay honest.
- **[Backup & recovery](backup-and-recovery.md)** — the seed phrase that recovers your
  identity, the encrypted relay backup of app state, how direct-message history is re-fetched
  from relays, and what does and does not come back.

## Not covered

- **Voice & video calls** and **image sharing (attachments)** — currently disabled
  features, intentionally omitted.
- **Themes/appearance, settings, learning/quiz groups, the feedback channel, and
  static-site update detection** — not yet written; available on request.
