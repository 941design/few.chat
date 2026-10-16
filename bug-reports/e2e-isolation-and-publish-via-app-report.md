# E2E isolation (pairing specs) and publish-via-app (DM specs)

Source: BACKLOG.json findings `e2e-pending-confirmation-relay-pollution` (2026-10-16),
`dm-e2e-publish-via-app-refactor` (2026-05-19) and `unreadstore-publish-dm-bridge-module-cohesion`
(2026-06-03). Test-only defects plus one dev-only module move; no user-facing behaviour changes.

## 1. Pending-confirmation spec reads relay history

**Verified.** `computeTestKeypairs()` salts identities per spec *file*. All five tests of
`dm-pairing-pending-confirmation.spec.ts`, every `--repeat-each` repeat, every retry and every run on a
relay not wiped since share one USER_A/USER_B pair. When A confirms B, the app (correctly) reveals all
of B's held DMs on the relay, including earlier runs' and test 2's, so step 5 read 5/7/11 instead of 2.
The lead reproduced it at HEAD (3 of 4 repeats fail).

**Fix.** `computeTestKeypairs({ perTest: true })` (opt-in, `app/tests/e2e/helpers/auth-helpers.ts`)
also salts with the test id, repeat index, retry and a random UUID, so every test execution gets new
keys and an empty relay history. Called from `beforeEach`. Refused for `dm-feedback-channel.spec.ts`
(it must keep the maintainer identity). The default call is unchanged for every other spec.

The exact assertions stay: 1 while pending (the pending flag, DMs not counted), exactly 2 after confirm
(this test's two held DMs), 0 after opening the thread. They now measure the product, not relay history.

**Other dm-pairing specs.** All eight shared the same per-file pattern; the others are single-test, so
they were not polluted in the gate, but the same is true of them under repeats, retries or a non-wiped
relay (e.g. the negative "admits nobody" specs could see an earlier run's genuine pairing-ack). All
eight now use per-test identities.

**dm-pairing-single-scan-mutual:57 (line 109 click timeout).** Not this class: the gate wipes the relay
at start, the file's identities are unique, the spec has one test, and there are no local retries, so A
and B had no history. Playwright's log stops at "performing click action" with the button visible,
enabled and stable: the click never returned, which points at A's page being busy for 30 s. Cause
unknown, not reproduced (3/3 here, 2/2 in the lead's rerun). Left open.

## 2. DM specs that publish from the test process

**Verified against current code.** `dm-giftwrap-bell` already sends through `__fewPublishDm`;
`dm-third-party-inbound` no longer exists. The only `dm-*` spec still publishing from the test process
was `dm-historical-recovery` (nostr-tools `wrapEvent` + raw `WebSocket` with back-dated rumors).
`dm-pairing-sender-binding`'s `forgedPairingAck` is an existing, documented narrow exception (a forged
ack the app cannot produce) and was left alone.

**Fix.** "Historical" only needs the messages to be on the relay before Alice's chat mounts, so no
exception is needed: Alice's page is closed, Bob sends 5 DMs through his own app page
(`__fewPublishDm` → `publishDirectMessage`, his real signer and NDK) at least 1 s apart so each rumor
has its own `created_at` second, then Alice reopens and opens Bob's chat. The assertions are tighter
than before: exactly 5 run-tagged messages (was ≥ 5) in exact order 0..4 (was non-decreasing), and
still 5 after reopening (dedup).

A first version also asserted that Alice had no stored thread for Bob before opening the chat. That
was wrong: in one repeat, 4 of the 5 messages were already stored right after loading `/contacts`.
The precondition was removed (the messages still come only from the relay, since Alice was offline for
every send). This contradicts a comment in the pending-confirmation spec (content is only persisted
once the chat mounts); see open questions.

## 3. `__fewPublishDm` bridge location

The refactor uses the bridge, so it was moved verbatim from `app/src/lib/unreadStore.ts` to
`app/src/lib/dmPublishTestBridge.ts`. The window name, signature, behaviour and the
`typeof window !== 'undefined' && process.env.NODE_ENV !== 'production'` guard are identical. It is
side-effect-imported from `app/pages/_app.tsx`, so it is installed on every page, as before (unreadStore
was loaded app-wide via MarmotContext). The `__fewUnread` bridge stays in unreadStore (it exposes that
module's own API). A unit-test comment that referenced the old line numbers was annotated.

## Verification

- Unit: 250 files, 5589 passed, 1 skipped (unchanged). `tsc --noEmit`: clean (covers tests/e2e).
- E2E (relay wiped once, not between runs):
  - `dm-pairing-pending-confirmation --repeat-each 4`: 20/20 passed.
  - `dm-pairing- dm-historical-recovery --repeat-each 3`: all 36 pairing executions passed; one
    historical-recovery failure from the wrong precondition above (fixed).
  - `dm-historical-recovery --repeat-each 3` after the fix: 6/6.
  - Bridge callers once (dm-giftwrap-bell, dm-block-contact, dm-feedback-channel, dm-walled-garden-*,
    groups-pull-only-invitation-*, groups-ever-known-survives-leave,
    groups-notification-domain-invariants): 31/31.
  - No INVALID markers. Full gate not run (lead).

## Open questions

1. The single-scan-mutual click hang is unexplained; suggest a separate finding if it recurs.
2. Which path stores a group-member peer's DM content before their chat is opened? Either a boot-time
   path persists it or the pending-confirmation spec's comment about persistence is stale.
