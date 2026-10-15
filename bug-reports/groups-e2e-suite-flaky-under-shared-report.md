# Groups e2e suite flakes: vacuous "joined" wait after accepting an invitation (+ residual races)

Source: BACKLOG.json finding `groups-e2e-suite-flaky-under-shared` promoted 2026-10-14

## Description

Original finding (2026-07-10): ~7 groups tests intermittently fail on cross-user propagation
assertions; attributed to shared USER_A/USER_B keypairs + shared strfry relay contamination.
Per project memory the contamination part was fixed (3ea90a9, 15aa639); a residual of ~4
"rotating ~30s VM-latency timeouts" remained unexplained. Success signal: `make test-e2e-all`
green across 3 consecutive runs with no per-spec quarantine.

## New evidence (2026-10-14)

Full gate (`make test-e2e-all`, after the seedContact + dispatch-isolation fixes): non-relay 72/72;
relay bucket 331 passed, 2 failed, 19 skipped, 5 did not run:

1. `groups-rename.spec.ts:127` invite-join — `waitForGroupAndOpen` (spec :95-106):
   clicks `accept-invitation-*`, then waits `getByText(groupName)` — which the still-pending
   InvitationCard row ALREADY shows → vacuous wait; then `openGroupDetail` does `page.goto('/groups/')`
   while the MLS join is in flight; screenshot shows Bob still on the pending INVITATION
   (Accept/Decline) and the `group-card-*` click times out. The same vacuous pattern
   (`accept-invitation-*` click → `getByText(groupName)`) is copy-pasted in ~15 specs, e.g.
   groups-admin:133, forward-secrecy:82, lazy-updates:76, poll-after-leave:98,
   member-admitted-announcement:118, profile-request:99, polls:86, profile-reactive:88,
   profile-forwarded-attribution:136, profile-update-propagation:73, remove-member:105,
   transitive-invite:104, rename:104 (grep for more). Joined state has its own testid:
   `group-card-${group.id}` (GroupCard.tsx:76) vs `invitation-card-`/`pending-invitation-row-`/
   `accept-invitation-` (InvitationCard.tsx:116/130/156).
2. `groups-dm-reactions.spec.ts:366` AC-47+AC-49: `reaction-badge-<id>-👍` not visible within
   10 s (spec :410). Passed 2/2 in isolated re-runs on a wiped relay.

Isolated recheck (rename + dm-reactions, wiped relay, ×2): run 1 all passed; run 2
`groups-rename.spec.ts:168` AC-RENAME-3 failed: `getByText('Rename Test Original')` still visible on
Bob's /groups list 15 s after the RENAMED name appeared (substring match — could be a stale second
card/invitation for the same group, or a preview line containing the old name). Not yet diagnosed.

## Expected vs actual

Expected: specs wait for the real joined state before navigating; assertions select precise elements.
Actual: vacuous waits + reload races → nondeterministic timeouts.

## Reproduction

Full: `make test-e2e-all` (~48 min). Targeted: wiped relay +
`cd app && PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/playwright-few E2E_GROUPS=1 node scripts/run-e2e.mjs tests/e2e/groups-rename.spec.ts`

## Constraints

- Prefer ONE shared helper (in app/tests/e2e/helpers/group-setup.ts) that accepts an invitation and
  waits for the joined `group-card-*` with the group name, used by all affected specs.
- Do not loosen timeouts as the fix; do not quarantine/skip tests.
- If AC-RENAME-3's stale text is a PRODUCT bug (e.g. a stale invitation card persisting after join,
  or the list showing two cards for one group), stop and report to the lead — do not paper over it.
