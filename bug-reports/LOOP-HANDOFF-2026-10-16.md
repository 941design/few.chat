# Loop handoff — 2026-10-16 (supersedes the 2026-10-15 "Next in the loop" list)

## Done on 2026-10-16 (all on master, each with a full green gate)
1b9a934 durable removals/journal age-only/avatar re-sanitize · 9e25d07 poll seq/closed tally/close retry ·
625c0fa cross-tab reactions · 17f3fd5 cold-start backup retry · 041cf03 e2e per-test identities +
historical-recovery via app · 5a539cf buildDmProfileMap · 730b976 journal ack-on-success / replay-safe
leaves / single-txn removal settle (each followed by a chore(backlog) commit).

## In flight at the time of writing
Bug run `poll-followups` (bug-reports/poll-followups-*): round 2 done (Fable RETRY specs applied; Codex
verify clean; unit 5810 green). Uncommitted in the working tree. Full gate re-running after the
2026-10-16 ~13:30 machine crash → log /tmp/claude-501/e2e-gate/full-pollfu4.log. On green: set
result.json status done/outcome merged, state ACCEPTED + e2e_gate, commit app/ docs/behavior/polls.md
bug-reports/poll-followups-*, then resolve poll-held-close-startup-sweep,
poll-kept-votes-held-close-aware-pruning, poll-superseded-prune-at-close,
poll-receipt-clock-seed-failure-backward-step, pending-vote-cap-drop-observable.

## Remaining actionable after that
reactions-rejected-write-cache-reconcile, reaction-edit-handlers-ack-on-storage-failure,
leave-fallback-identity-writeback, idb-keyval-update-lint-ban, rumor-journal-real-idb-suite,
poll-pending-queues-recreated-after-purge, leave-clearpolldata-unguarded.
Blocked on multi-tab S1 product decisions: poll-receipt-clock-and-seq-cross-tab, cross-tab-account-switch-notice.

## Product decisions (collected, unchanged): see the 2026-10-15 file's list plus
reinvite-after-eviction-fails-already-exists (removed-member view; history on re-invite) and
multi-tab-mls-cache-coherence S1 (non-active tab UI, activation trigger, en/de copy), and whether to
authenticate all display-only announcements.

## Paused by owner request — 2026-10-16 ~18:30
Last commits: 14bdb5d reaction/edit storage failures · e60e5d4 journal/purge follow-ups (+ backlog commits).
Working tree clean. Remaining technical: poll-savepoll-not-purge-marked (new); multi-tab-blocked:
poll-receipt-clock-and-seq-cross-tab, cross-tab-account-switch-notice. Everything else is a product decision.
