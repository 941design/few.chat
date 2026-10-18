# A just-sent DM bubble vanishes when the relay acks late; the full e2e gate flakes on it

Source: BACKLOG.json finding `dm-own-send-bubble-vanishes-on-publish-reject` promoted 2026-10-18.

## Actual
`ContactChat.sendMessage` (app/src/components/contacts/ContactChat.tsx ~:902-932) upserts the
optimistic bubble, then `await ndkEvent.publish()` with no timeout argument. NDK 3.0.3's per-relay
publish defaults to **2500 ms** (`NDKRelayPublisher.publish(event, timeoutMs = 2500)`); if no relay
acks within that window the relay-set publish throws `NDKPublishError("Not enough relays received
the event (0 published, 1 required)")`. The catch removes the bubble and rethrows; ChatBox puts the
text back into the composer.

The group send path does not have this problem: marmot-ts publishes through
`NdkNetworkAdapter.rawPublish` with a **10 000 ms** ack timeout.

Consequences:
- On a loaded 1-CPU VM the strfry OK arrives after 2.5 s now and then: three full e2e gates
  (2026-10-17/18) each failed 1–2 DM own-send tests (groups-dm-reactions :299 / :371 / :435,
  dm-block-cross-tab :84) with "bubble visible, then gone" (`locator.hover` timeout after
  `toBeVisible` passed).
- For users on a slow link the relay usually *did* store the event, so the peer receives the
  message while the sender sees it disappear and gets the text back to resend → duplicate.

## Expected
A DM publish that the relay accepts within a reasonable window (same as groups: 10 s) is kept.
Only a genuine failure rolls back.

## Reproduction
groups-dm-reactions.spec.ts under CPU load (full gate on the 1-CPU VM, or the spec with
`--repeat-each` plus busy-loop load). Anchor: ContactChat.tsx:920-930.

## Second cause (found by the 2026-10-18 gate)
With the timeout fixed, the full gate still failed AC-60 (:299) once. Its snapshot shows the
bubble gone **without** the failure notice and with an empty composer, so nothing rolled back.
Own sent DMs are stored (`appendMessage`) only after the relay ack and there is no self-wrap, so
until then the bubble exists only in React state. The thread-open effect seeded state with a
blind `setMessages(filterVisibleMessages(stored))` (and `setMessages([])` on error); when that IDB
read resolved after the first send (the test sends as soon as the composer shows), it erased the
bubble for good. Fix: `seedThreadMessages` merges storage into the rendered rows of the same
thread (rows of another thread are dropped; ContactChat is not keyed by peer).

## Tests
Unit: DM publishes pass the shared publish timeout (not NDK's 2.5 s default); a relay ack later
than 2.5 s but within the timeout keeps the bubble. E2E: full gate green.
