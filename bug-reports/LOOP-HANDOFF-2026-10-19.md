# Loop handoff — 2026-10-19 (supersedes LOOP-HANDOFF-2026-10-18.md)

Status: **paused at the owner's request** after item 15, with a clean tree. The only uncommitted change
is the owner's own `.clauded.yaml`. Every AGENT-DECIDES item from the 2026-10-18 list is either done or
waiting on an OWNER question, with one exception: `invite-lookup-ignores-invitee-s-keypackage` (filed
during this run) is open and needs no owner input.

## Done in this run (all on master, each with bug-reports/<slug>-{report,contract,state,result}.*)

Each item had its test written and failing before the fix; reviews by base:code-reviewer and Codex until
both accepted; Stryker at concurrency 1 on the changed module; a full `make test-e2e-all` gate; and
close-out through the backlog scripts.

| # | Commit | Finding (slug) | What changed | Gate |
|---|--------|----------------|--------------|------|
| 7 | d0485ea | `connectndk-rebinds-external-signer` | A connected NIP-07/46 signer stays NDK's signer until it is disconnected; `connectNdk(privateKeyHex)` no longer replaces it. | green except a cold first-relay-test KeyPackage miss (led to item 12) |
| 8 | 25cf4fe | `stale-replace-retired-setup-untracked` | A re-invite replace waits for that group's retired subscription setup. | green |
| 9 | 8695bfc | `dm-thread-switch-stale-rows-and-pending-send` | A conversation shows only its own rows; an unacked send survives a thread switch (module-scope `pendingOwnSends`). | green except the known composer stall |
| 10 | 113cdf9 | re-invite follow-up | A re-invite replace waits for the group's members-changed work and profile send. | green |
| 11 | e8f361b | `subscription-generation-resubscribes-all` | A re-invite replace resubscribes only the replaced group. | green |
| 12 | 5dd7206 | `invite-fresh-peer-fails-with-has` | On startup, after the stale-KeyPackage cleanup, the app counts the relay KeyPackages a local package backs. When a complete fetch finds none, it republishes one last-resort KeyPackage. A timed-out fetch never republishes. | green except the known stall (isolated baseline comparison recorded) |
| 13 | 19f6de0 | `deleting-dm-image-while-still-uploading` | An image row that is still uploading (temporary id; DM and group) offers no delete, no edit and no reactions. The handlers ignore it too. | green (72 + 353) |
| 14 | 982748e | `pending-contact-confirm-badge-reads-1` | Confirm counts every DM held while the contact was pending, including one whose write is in flight. Details below. | green except 2 hits of the known stall; both specs 5/5 in isolation |
| — | a337ee1 | `dm-composer-enter-press-hangs-30s` (diagnostic only, finding stays open) | Renderer stall probe for the composer sends; see "Composer stall" below. | green (72 + 353, no stall) |
| 15 | cbbb751 | `reconcileinit-re-read-overwrites-other-peers` | DM-count scans add live DMs instead of replacing them. Details below. | green (72 + 353) |

### Item 14 in detail: the unread recount on Confirm
- The DM watcher registers each held DM write (`unreadStore.trackHeldDirectMessageWrite`) in the same
  tick as its `isPendingConfirmation` check.
- `reconcileConfirmedContactDirectMessageCount`:
  - runs one at a time per peer, and starts its per-call tracker before its first await;
  - waits at most 5 s for the peer's held writes;
  - for the first recount of a peer, sets `max(pre, stored) + live bumps during the call`. Later recounts
    set `pre + stored ids not yet counted`, using the per-peer `confirmRecountCountedIds`.
- A held write that lands after the 5 s cap schedules a recount that dedupes by message id.
- The behaviour docs are corrected: held DMs count as unread on Confirm. The docs had claimed they arrive
  already read.

### Item 15 in detail: DM-count scans
- `reconcileInit` has an `additive` merge for the DM slice. Live DMs during a scan are added to the
  stored count and not re-read, and peers outside the scan are untouched.
- A read or clear during a scan drops that peer's earlier count. The guard for this is kept per slice.
- The startup scan:
  - reads the last-read time per key;
  - records the stored ids it counted, and keeps the count and the record unchanged on a failed read;
  - adds only stored ids that were not yet counted;
  - re-bases any confirm recount already in flight for that peer.
- The confirm recount settles its count and its record inside the serialized commit.

**Design note for future work on `unreadStore`.** The DM unread count has four writers: the live bump,
the startup scan, the confirm recount, and late held writes. Item 14 took 7 Codex rounds and item 15 took
6, each finding the next interleaving. The invariant everything now relies on: stored-unread DMs and
live-only DMs are disjoint. An open conversation is the active view, so it is never bumped, and it marks
read what it stores. `confirmRecountCountedIds` records which stored DMs are already counted. If this
area is touched again, consider one per-peer ledger of counted message ids that every writer shares.

## Composer stall (`dm-composer-enter-press-hangs-30s`): state of the diagnosis
- **Symptom.** Under full-suite load, a click on `chat-send-btn` or an Enter press in `chat-input` waits
  30 s in "performing click action". Even a DOM query fails afterwards, so the renderer's main thread is
  blocked. Sightings so far: groups-dm-reactions (AC-46, AC-60, :233),
  dm-pairing-pending-confirmation (:214, :223) and dm-block-cross-tab (:84). It turned 4 of this run's 9
  gates red. Isolated reruns always pass.
- **Probe.** `app/tests/e2e/helpers/renderer-stall-probe.ts` attaches a CDP Debugger session early on
  the composer pages of those three specs. On a failure it pauses V8 and attaches the main thread's JS
  stack and the pause latency to the test as `renderer-stall-*`, then rethrows; test outcomes are
  unchanged. Find a report with `grep -A30 "renderer-stall-probe\] " <gate log>`.
- **Observation.**
  - Armed: dm-block-cross-tab passed 20/20 in isolation (10 of those runs under a CPU hog), and both armed
    full gates (full-probe, full-dmscan) were green with no stall.
  - Unarmed: 4 stalls in 21 isolated runs.
  - The armed debugger may therefore suppress the stall, so armed passes are not evidence of a fix.
- **Next step.** Keep collecting reports from gates. If no stall appears in about 3 armed gates, compare
  armed and unarmed under equal load. One way: arm only a random half of runs, logged, and see whether the
  stall tracks arming. If it does, the stall is timing-sensitive in a way the Debugger's per-script
  bookkeeping changes, which points at main-thread work in the thread-open path.

## Decisions taken for the owner to confirm (implementation-level, reversible)
- Item 12: on startup the app republishes **one** last-resort KeyPackage, not five, because the device
  has a single addressable 30443 slot. It republishes only after a complete fetch, never after a
  time-out.
- Item 13: an uploading image row offers no delete, edit or reactions. The alternative, cancelling the
  upload, is not implemented.
- Item 14: the recount waits at most 5 s for held writes. A later write is counted when it lands.
- Item 14: the behaviour docs were changed to match the code (held DMs count as unread on Confirm). If
  the old wording, "arrive already read", was the intended product, that is an OWNER question; the code
  and the e2e spec have implemented "count as unread" since AC-DM-3.
- Carried over from 2026-10-18: the stale re-invite rule, external-signer backup off, and in-tab backup
  suspension after a wipe (see the OWNER questions).

## Next (AGENT-DECIDES, suggested order)
1. `invite-lookup-ignores-invitee-s-keypackage`: the invite path looks KeyPackages up only on our
   relays, not on the invitee's KeyPackage relay list (kind 10051). Filed during item 12; needs no owner
   input.
2. `dm-composer-enter-press-hangs-30s`: continue the diagnosis as above. Check every gate log for a probe
   report.
3. `stale-replace-other-tab-writes`: only after OWNER Q4 (multi-tab model).
4. `forwarded-envelope-freshness-and-replay`: only if OWNER Q8 wants the ADR-012 hardening.

Open findings that need an OWNER decision first: `if-leaver-s-kind-13-departure` (Q1),
`invite-modal-picker-cannot-re-invite` (Q3), `multi-tab-mls-cache-coherence` and
`poll-receipt-clock-and-seq-cross-tab` (Q4), `external-signer-users-nip-07-nip` (Q5),
`icon-set-should-be-a-real-theme-dimension` (Q6).

## OWNER questions (Fable's recommendation marked "rec."); unchanged from 2026-10-18, still open
1. Kind-13 send failure on leave: abort the leave with a retryable error (rec.) / proceed and warn /
   accept and document?
2. Evicted member: the group vanishes locally (rec.) / a read-only "removed" view / status quo?
3. Pending-invite resend: cancel and re-invite in one tap (rec. if DD-4 stands) / label only / drop DD-4?
4. Multi-tab: a single active tab with takeover (rec.) / all tabs active with invalidation? This blocks
   `multi-tab-mls-cache-coherence`, `poll-receipt-clock-and-seq-cross-tab`, `stale-replace-other-tab-writes`
   and the cross-tab part of the backup work.
5. External-signer backup is currently off with a Settings notice. Next: a manual "Back up now" signed by
   the signer (rec.) / back up silently via the signer / leave the notice only?
6. Icon sets: commission a filled or pixel theme / collapse to `line` (rec., absent a plan) / keep the
   guard test only?
7. Reject a mismatched NIP-46/07 signer at connect time (rec. yes, later)?
8. ADR-012: accept it as implemented in part? Is the remaining envelope hardening (a freshness bound and a
   persistent replay set) wanted?
9. Confirm the stale re-invite rule: our own leaf absent, or the state unreadable, ⇒ replace.
10. (new, low priority) Confirm "a contact's messages held while pending count as unread on Confirm"
    (current code and docs) over "they arrive already read" (the old docs).

## Environment notes and traps learned in this run
- The VM runs on **1 CPU**, which is the owner's uncommitted `.clauded.yaml`. Never commit, revert or
  stage that file. A full e2e gate takes about 65 min.
- Do not edit `app/` while a gate runs. If a fix must change while a gate is running, stop the gate
  (TaskStop) and rerun it later; never edit under it.
- **Vitest trap** (project memory `test-vitest-concurrent-dynamic-import-mock-race`): two same-tick
  first-time `import('idb-keyval')` calls can resolve the real module even though the test `vi.mock`s it.
  The real `get` throws "indexedDB is not defined", and unreadStore swallows that as "nothing stored".
  Settle the first import before you overlap calls.
- `unreadStore-property.test.ts` cases must reset the peers' counts. The additive DM merge keeps a
  pre-scan count, which the old replacing merge used to hide.
- `app/.stryker-tmp/sandbox-BvDevv` was there before this run and is git-ignored. It was left alone.
- Stryker scratch configs are in the session scratchpad (`stryker.cr.mjs` with
  `vitest.stryker.cr.mjs`). Exclude suites that scan source text from the include.

## Instructions for unattended work
Unchanged from LOOP-HANDOFF-2026-10-17.md §"Instructions for unattended work":
- the bug workflow per item;
- Stryker at concurrency 1 with a scratch config;
- a full `make test-e2e-all` gate with no `app/` edits while it runs;
- close-out via the base:backlog scripts;
- one commit per run on master, staging explicit paths only.
