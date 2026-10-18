# A reaction re-added in the same second as its removal shows only on the sender's device

Source: BACKLOG.json finding `reaction-readd-same-second-not-propagated` (filed 2026-10-17,
follow-up of `reaction-readd-after-removal`; AGENT-DECIDES loop item 6).

## Actual
buildReactionRumor stamps `created_at = floor(now/1000)`. Stores compare add vs removal at
one-second resolution, and a tie goes to the removal. If a reaction is removed and re-added within
the same second, every receiver (peers and the sender's other devices) keeps it removed. The sender's
own optimistic row is bumped past the removal second, so the sender still sees it live. The views
diverge silently. This is documented as a limit in docs/behavior/reactions-and-emoji.md.

The mirror case has the same flaw: if a re-add is stamped into the next second and the user removes
it again within that real second, the removal rumor (stamped `floor(now)`) is older than the add, so
receivers keep the reaction live.

## Expected
A rumor for a reaction triple is never stamped older than the sender's own latest state for that
triple. A re-add is stamped strictly after the stored removal second, and a removal no earlier than
the stored add second (a tie goes to the removal). Receivers then converge on the sender's view.

## Test
Unit: buildReactionRumor honours a notBefore second. Remove then re-add within the same second
gives a re-add created_at greater than the removal's, and a peer store applying both rumors shows
the reaction live. Re-add then remove within the same second makes a peer store show it removed.
Group and DM send paths pass the floor.
