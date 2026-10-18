# Switching DM threads briefly shows the previous conversation; an unacked send is lost on a quick switch back

Source: BACKLOG.json finding `dm-thread-switch-stale-rows-and-pending-send` (code-reviewer, round 5 of
`dm-own-send-bubble-vanishes-on-publish-reject`; AGENT-DECIDES loop item 9).

## Actual
ContactChat is deliberately not keyed by peer (ChatBox's per-thread failed-send stash relies on it
staying mounted), so its `messages` state survives a thread switch.
1. After switching from A to B, A's rows stay rendered under B's header until B's IndexedDB read
   resolves (display only; nothing is sent).
2. A text send in A that is still awaiting its relay ack is dropped by B's thread-open seed (it keeps
   only B's rows). Switching back to A before the ack: A's seed reads storage, which does not have the
   send yet (own DMs are persisted only after the ack), so the bubble is gone. When the ack arrives,
   appendMessage persists it without updating the view; it reappears only on reload.

## Expected
1. The conversation view only ever shows rows of the open thread.
2. An own send that has not been acked yet stays visible in its thread across thread switches: the
   thread-open seed merges the thread's pending own sends.

## Test
Unit (pure helpers): rows of another thread are never rendered; the seed merges a thread's pending own
sends that storage does not know yet, does not duplicate one storage already has, and ignores pending
sends of other threads; a pending send is forgotten after its ack or failure.

## Scope note (from review)
The premise above holds only for a switch that keeps ContactChat mounted (a notification click or
back/forward between two threads). The usual path goes through the contact list and remounts
ContactChat, so the pending sends live in a module-scope, per-account registry
(`app/src/lib/pendingOwnSends.ts`) instead of a component ref. Review also uncovered a deeper defect,
fixed in this run: a delete or edit of an unacked own send was only buffered and never applied once
the send was stored (`persistOwnSend`). Deleting an image while it uploads still does not stick
(temp id); that is documented and filed as `deleting-dm-image-while-still-uploading`.
