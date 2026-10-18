# Loop handoff — 2026-10-18 (supersedes LOOP-HANDOFF-2026-10-17.md)

Status: **loop list from 2026-10-17 completed** (items 0–6). Remaining work is either newly filed
technical findings (below, AGENT-DECIDES) or blocked on an OWNER question.

## Done on 2026-10-18 (all on master)
- 29ff1ad fix(dm): keep sent DMs on a late relay ack and through the thread-open load
  (`dm-own-send-bubble-vanishes-on-publish-reject`). Root cause of the red gates: NDK's 2.5 s ack
  default + ContactChat's blind thread-open seed. Shared 10 s `publishWithTimeout`; failed-send
  notice with Retry.
- ecb110f docs(adr): ADR-012 implementation status verified (stays Proposed; see OWNER Q8).
- 43bd639 test(themes): icon-set three-column guard test.
- 7ebadfa fix(groups): a removed member can accept a re-invite and chat again (`stale-welcome-reinvite`;
  resolves `reinvite-after-eviction-fails-already-exists`). New e2e `groups-reinvite-after-removal`.
- e69a361 fix(backup): no automatic local-key backup while an external signer is connected
  (+ Settings notice).
- 1cbe126 fix(backup): never publish a backup after a wipe or account switch in this tab
  (`backup-empty-snapshot-publish-after-wipe`): page-lifetime suspension and identity-bound scheduler.
- f3a70ff fix(reactions): a re-add in the same second as its removal now reaches peers
  (`reaction-readd-same-second-not-propagated`): stamp floor built atomically in the per-thread queue.
- Full e2e gates green: full-reinvite (72 + 353 passed); full-backup-react (72 + 352 passed, 1 failed:
  AC-60 composer Enter-press stall before any reaction code ran, 5/5 green in isolation; filed as
  `dm-composer-enter-press-hangs-30s`).

## Decisions taken for the owner to confirm (implementation-level, reversible)
- **Stale re-invite rule** (item 1): a locally held group is replaced by a new Welcome only if our own
  leaf is absent from its tree or its state is unreadable. The Welcome's epoch is ignored. A
  Welcome for a group we are still a member of never wipes local state; such a Welcome would be
  forged or forked.
- **External-signer mode** (item 4): automatic backup was found to still run with the stored
  *local* key while a NIP-07/46 signer was active (publishing under a different identity). It is now
  off in external mode with a Settings notice. This sharpens OWNER Q5.
- **Backup after wipe** (item 5): chose an in-tab suspension over an "empty snapshot" heuristic. A
  wipe or switch in *another* tab still relies on the reload notice (multi-tab = OWNER Q4).

## Next (AGENT-DECIDES technical findings filed during this loop, suggested order)
1. `connectndk-rebinds-external-signer` — connectNdk(privateKeyHex) silently replaces an active
   NIP-07/46 signer (also the root of the stale-backup signer rebind).
2. `stale-replace-retired-setup-untracked` — last Codex finding of the re-invite run (capped at
   round 5): a retired subscription setup across an effect restart is not awaited by the replace.
3. `dm-thread-switch-stale-rows-and-pending-send` — thread switch while a send is pending.
4. `stale-replace-other-tab-writes`, `subscription-generation-resubscribes-all` — re-invite
   follow-ups (multi-tab part depends on OWNER Q4).
5. `dm-composer-enter-press-hangs-30s` — gate flake (renderer stall on the thread-open history load).
6. `forwarded-envelope-freshness-and-replay` — only if OWNER Q8 says ADR-012 hardening is wanted.

## OWNER questions (Fable's recommendation marked "rec.")
1. Kind-13 send failure on leave: abort leave + retryable error (rec.) / proceed + warn / accept and document?
2. Evicted member: group vanishes locally (rec.) / read-only "removed" view / status quo?
   (The re-invite path now works either way.)
3. Pending-invite resend: cancel + re-invite in one tap (rec. if DD-4 stands) / label only / drop DD-4?
4. Multi-tab: single active tab with takeover (rec.) / all tabs active with invalidation?
   (blocks `multi-tab-mls-cache-coherence`, `poll-receipt-clock-and-seq-cross-tab`, parts of the
   re-invite and backup follow-ups)
5. External-signer backup — automatic backup is now **off** in external mode (it used to back up
   under the stored local key, i.e. a different identity) and Settings says so. Next step:
   manual "Back up now" signed by the external signer (rec.) / silent via signer / leave as notice only?
6. Icon sets: commission a filled/pixel theme / collapse to `line` (rec. absent a plan) / guard test only?
   (guard test now in place)
7. Reject a mismatched NIP-46/07 signer at connect time (rec. yes, later)?
8. ADR-012: accept it as implemented-in-part (author authentication of announcements is in place),
   and is the remaining envelope hardening (freshness bound + persistent replay set,
   `forwarded-envelope-freshness-and-replay`) wanted?
9. Confirm the stale re-invite rule above (own leaf absent or unreadable state ⇒ replace).

## Environment notes
- The VM runs on **1 CPU** (owner's uncommitted `.clauded.yaml` change). A full e2e gate takes
  ~65 min.
- `.clauded.yaml` is the owner's uncommitted change: never commit, revert, or stage it.

## Instructions for unattended work
Unchanged from LOOP-HANDOFF-2026-10-17.md §"Instructions for unattended work" (bug workflow per
item, Stryker at concurrency 1 with a scratch config, full `make test-e2e-all` gate with no `app/`
edits while it runs, close-out via the base:backlog scripts, one commit per run on master).
