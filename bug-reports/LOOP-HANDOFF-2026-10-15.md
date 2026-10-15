# Backlog loop handoff — 2026-10-15

The autonomous backlog loop (owner request: work through BACKLOG.json until only product decisions
remain; base 2.7.7 workflows run manually; mutation audits at concurrency 1; Fable for technical
questions) was interrupted when the VM root filesystem started returning EIO for every binary
(/bin/sh, git, node) and /tmp writes. Only the project mount stayed readable/writable.

Last commit before the failure: `0797fd3` (backlog triage resolutions). Everything below is
UNCOMMITTED in the working tree — do not discard it.

## In flight (uncommitted)

### 1. invite-accept-not-atomic-across-page-unload — remediation round 1 written, unverified
- Code: app/src/lib/marmot/welcomeSubscription.ts (pre-join group id; already-joined short-circuit;
  orphan → marmotClient.groups.destroy → re-join; R1 per-group Web Lock `withGroupJoinLock`
  `few-join-<groupId>` with in-module fallback; R2 `dropInvitationsForJoinedGroups(client)` requires
  overlay AND groups.has; `loadGroupsAndReconcileInvitations` skips when loadAll fails),
  app/src/context/MarmotContext.tsx, docs/behavior/groups.md (own sections only).
- Tests: app/tests/unit/marmot/inviteAcceptIdempotentJoin.test.ts (29, green before the outage),
  app/tests/e2e/groups-reinvite-after-leave.spec.ts, app/tests/e2e/groups-accept-reload-atomic.spec.ts.
- Artifacts: bug-reports/invite-accept-not-atomic-across-page-unload-{report.md,state.json,contract.json,result.json}
  (state REMEDIATING round 1; result.json status in_progress, not re-validated).
- TODO: tsc; `make test-unit`; Stryker re-run (concurrency 1) on touched functions; e2e (2 new specs +
  groups-invitation-preview, groups-direct-invite-lifecycle, groups-pull-only-invitation-accept) on a
  wiped relay; then examiner + reviewer re-review (round-0 reviewer REJECTED on R1/R2 — both now
  addressed) + Codex adversarial; validate-result.sh; commit; resolve the finding.

### 2. untrusted-group-input-hardening (findings display-only-chat-announcements-spoofable-share,
group-profile-sync-marmot-profilesync-ts) — fix done, e2e + review pending
- Code: app/src/lib/marmot/parseStructured.ts (canonical 64-hex guard for all subject pubkeys),
  app/src/lib/dmProfile/kinds.ts (shared avatarImageUrlProblem / isAllowedAvatarImageUrl),
  app/src/lib/marmot/profileSync.ts (drop bad avatar, keep profile), docs/behavior/profiles-and-identity.md,
  docs/behavior/groups.md ("malformed identity" section), parseStructured(.contract).test.ts fixtures.
- Tests: app/tests/unit/marmot/untrustedGroupInput.test.ts (123; 41 failed pre-fix). Mutation 93.84% → 95.73%.
- Leave sender binding: not needed (only producer leaveGroupImpl.ts:139; gateAnnouncement already enforces).
- TODO: re-run the 12 relevant e2e specs on a wiped relay (the interrupted run's only recorded failure was
  groups-leave-intent AC-MEMBERS-2 blank name = known flake, finding
  leave-announcement-blank-name-when-profile-unknown); validate-result.sh; examiner + reviewer + Codex;
  commit; resolve both findings.

NOTE: docs/behavior/groups.md has hunks from BOTH runs — commit them together or split carefully.

## Next in the loop (tasks #4-#7)
Polls cluster (poll-vote-store-key-not-group + migration → poll-vote-not-yet-received-poll →
option caps of poll-receive-side-handlers-not-validate); small UI/count bugs
(profile-page-add-group-success-confirmation, create-group-enabled-before-client-ready,
one-time-migration-clear-stale-unread, stale-foreign-group-invite-expiry-count,
decodecard-accepts-signed-name-len-0, gate-incoming-calls-with-block-deny); first-relay-backup
short first retry; cross-tab block sync; profile-propagation latency diagnosis; test-infra/spec
cleanups (dm bridge module + dm-historical-recovery, profileMap builder, invite-links.md mute,
initJoinRequestCounts AC); left-groups-keep-mls-state-forever; reinvite-after-eviction.

## Product decisions collected (for the owner, at loop end)
Q1 signer pubkey ≠ local identity (share-contact-card-permanently-fails-when) · Q2 auto backup for
NIP-07/46 users · Q3 failed kind-13 departure handling · Q4 re-add removed reaction · Q5 invite picker
"Invited, pending" / resend · Q6 two co-admins leaving race · Q7 icon-set theme dimension · Q8 block in
group calls · leave-announcement fallback wording · persist backup dirty mark across early reload.

## Environment notes
- Run e2e only via make or with PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/playwright-few, relay wiped
  (`docker compose -f docker-compose.e2e.yml down -v && up -d --wait`); serialize via
  `flock /tmp/claude-501/e2e.lock`.
- base plugin registry points at stale 2.6.30; run 2.7.7 workflows manually from
  ~/.claude/plugins/cache/941design/base/2.7.7.
