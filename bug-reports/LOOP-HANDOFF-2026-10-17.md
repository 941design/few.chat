# Loop handoff — 2026-10-17 (supersedes LOOP-HANDOFF-2026-10-16.md)

Status: **PAUSED by owner request** after the reaction / admin-and-invite increment (see "Last increment").

## Done on 2026-10-17 (all on master)
- 831c142 fix(polls): purge-mark open-poll saves and vote-seq allocation (`poll-savepoll-not-purge-marked`).
- 1cb4884 blank leave name, persisted backup dirty mark (`few-backup-dirty`), cross-tab account-change
  reload notice, share-card signer-mismatch error (+ Fable triage file
  `bug-reports/product-decisions-fable-2026-10-17.md`).
- f489511 fix(groups): execution-time sole-admin re-check on leave; "invitation pending" invite label.
- b8e6cda fix(reactions): a removed reaction can be added again (last writer wins per triple) + backlog.

## Last increment
Runs `admin-and-invite-guards` and `reaction-readd-after-removal` (bug-reports/<run>-*), both
reviewer-ACCEPTED (reactions after 2 remediation rounds), unit 6139 passed / 1 skipped, tsc clean,
Stryker c=1 95% / 95.6% with survivors justified.
**E2E gate was NOT fully green.** Three full gates (`/tmp/claude-501/e2e-gate/full-reactions-admin{,-2,-3}.log`)
each failed 1–2 of 420 tests, all in the DM own-send path: Alice's just-sent DM bubble vanishes
(groups-dm-reactions :299 / :371 / :435; once dm-block-cross-tab :84). Diagnosis: ContactChat removes
the optimistic bubble when the relay publish rejects (ContactChat.tsx:920-930) — outside the diff;
groups-dm-reactions passed 3/3 in isolation and the `dm-` subset 52/52 with the changes. Committed by
lead decision because of the pause request; filed as `dm-own-send-bubble-vanishes-on-publish-reject`.
Earlier gates on 1cb4884 and 831c142 were green, so if the next full gate on master shows this again,
treat it as the top item.

## Next in the loop (AGENT-DECIDES items left, in this order)
0. `dm-own-send-bubble-vanishes-on-publish-reject` (technical, P1 — it keeps the full gate red): first
   confirm the publish-rejection mechanism with a log, then fix. The failed-send UX (keep the bubble
   with a retry vs. drop it) needs en/de copy — ask Fable.
1. `stale-welcome-reinvite` — report already written: `bug-reports/stale-welcome-reinvite-report.md`
   (committed with this handoff). Engineering half of
   `reinvite-after-eviction-fails-already-exists`: a valid Welcome for a locally held group whose own
   leaf is gone / epoch is stale replaces local state (teardown, destroy, re-join; history starts
   fresh). Add an e2e remove → re-invite → accept → chat. The evicted-member *view* stays OWNER Q2.
2. ADR-012 status: verify and, if implemented, close "authenticate all display-only announcements".
3. Icon-set three-column guard test (direction stays OWNER Q6).
4. External-signer settings notice — en "Automatic backup is off while an external signer is
   connected." / de "Automatische Sicherung ist aus, solange ein externer Signierer verbunden ist."
5. Technical finding `backup-empty-snapshot-publish-after-wipe` (filed 2026-10-17).
6. Small follow-up from the reaction run: `reaction-readd-same-second-not-propagated` —
   stamp a re-add rumor's created_at past its tombstone second so peers see it too.
Everything else open in BACKLOG.json is blocked on an OWNER question below.

## OWNER questions (Fable's recommendation marked "rec.")
1. Kind-13 send failure on leave: abort leave + retryable error (rec.) / proceed + warn / accept and document?
2. Evicted member: group vanishes locally (rec.) / read-only "removed" view / status quo?
3. Pending-invite resend: cancel + re-invite in one tap (rec. if DD-4 stands) / label only / drop DD-4?
4. Multi-tab: single active tab with takeover (rec.) / all tabs active with invalidation?
   (blocks `multi-tab-mls-cache-coherence`, `poll-receipt-clock-and-seq-cross-tab`)
5. External-signer backup: manual "Back up now" (rec.) / silent via signer / notice only?
6. Icon sets: commission a filled/pixel theme / collapse to `line` (rec. absent a plan) / guard test only?
7. Reject a mismatched NIP-46/07 signer at connect time (rec. yes, later)?
8. ADR-012 forwardable signed meta-events — still wanted, if unimplemented?

## Environment notes
- The VM runs on **1 CPU** (owner's uncommitted `.clauded.yaml` change: cpus 4 → 1). A full e2e gate
  takes ~65 min; 1-CPU load produces occasional click-timeout flakes (e.g.
  `dm-pairing-pending-confirmation:214`) — rerun the spec 5× in isolation, then rerun the full gate.
- `.clauded.yaml` is the owner's uncommitted change: never commit, revert, or stage it.

## Instructions for unattended work (how to resume the loop)
Owner standing instruction (2026-10-17): *work autonomously; before consulting the owner, ask Fable;
decide implementation details without consulting the owner; defer product decisions you cannot decide
until the very end; work uninterrupted.*

Per item:
1. **Pick** the next item from "Next in the loop". If an item turns out to need a product decision,
   ask Fable first (`Agent`, model `fable`, with the finding text + relevant code/doc excerpts; ask for
   AGENT-DECIDES with concrete copy/behaviour, or OWNER with a recommended option). Implement
   AGENT-DECIDES answers; append OWNER ones to the list above. Never block the loop on the owner.
2. **Run the /base:bug workflow** (base plugin 2.7.7, `~/.claude/plugins/cache/941design/base/2.7.7/commands/bug.md`):
   report `bug-reports/<run>-report.md` → state/contract → fixer (`base:dev`) → verification
   examiner → reviewer (`base:code-reviewer` + `codex:adversarial-review`) → remediation rounds until
   ACCEPTED. Write behaviour changes into `docs/behavior/<topic>.md` in the same run; all new UI text
   en + de in `app/src/lib/i18n.ts` via `useCopy`; consult `docs/design-rationales.md` before UI work.
3. **Mutation-test** changed logic with Stryker at **concurrency 1**, scratch config outside
   `app/reports` (plain `.mjs` vitest config in the scratchpad; exclude source-scan suites).
4. **Gate**: unit via `make` (never bare npm), then the **full** e2e suite only —
   `make test-e2e-all > /tmp/claude-501/e2e-gate/<run>.log 2>&1` in the background. Wipe the relay
   first if specs fail on pending invites (`down -v && up -d --wait`). **Do not edit `app/` while the
   gate runs** (the runner marks the run INVALID). A subset is never a pass. Batching two accepted
   runs into one gate is fine.
5. **Close out**: state ACCEPTED + e2e_gate in `<run>-state.json`; `<run>-result.json` status done /
   outcome merged; run the bug workflow's `validate-result.sh`; resolve/enrich/add findings only via
   the `base:backlog` scripts (`resolve.sh`, `enrich-finding.sh`, `add-finding.sh`), never by editing
   BACKLOG.json.
6. **Commit** directly to master, one commit per run (app + docs + `bug-reports/<run>-*`), message
   ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; never session
   ids; never `.clauded.yaml`, never unrelated untracked reports. Never revert/delete preexisting
   or uncommitted work — preserve (stash/copy) and report.
7. Do not edit installed plugin files under `~/.claude/plugins/` (agent memory excepted); do not
   schedule follow-ups.
8. At the very end (or on a pause request): finish the current increment, commit, update this
   handoff (done list, next list, OWNER questions), then present the OWNER questions to the owner.
