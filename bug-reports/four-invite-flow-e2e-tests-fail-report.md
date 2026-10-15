# seedContact e2e helper breaks on re-seeding an existing contact

Source: BACKLOG.json finding `four-invite-flow-e2e-tests-fail` promoted 2026-10-14

## Description

Original finding: "Four invite-flow e2e tests fail deterministically on master (also with a freshly
wiped relay, run in isolation): invitation-preview decline, profile-update-propagation multi-group
invite, remove-member AC-SCEN-8 re-invite, rename invite-join".

Re-diagnosed 2026-10-14 on a wiped relay with the correct Chromium build (1208):
3 of the 4 still fail; `groups-rename` now passes.

- groups-invitation-preview.spec.ts:142 "Bob previews another invitation and Declines from the preview"
- groups-profile-update-propagation.spec.ts:194 "multi-group › A creates two groups and invites B to both"
- groups-remove-member.spec.ts:191 "AC-SCEN-8 / AC-PURGE-5: re-inviting C shows Cancel Invite"

All three fail at `app/tests/e2e/helpers/group-setup.ts:51` (`seedContact`) waiting for
`contact-added-success` OR `add-page-error`, on the SECOND seed of a contact that already exists.

## Expected vs actual

- Expected: `seedContact` is idempotent — re-seeding an existing contact succeeds (its doc comment
  says the already_exists branch renders `add-page-error`, treated as success).
- Actual: commit 26d1606 (2026-07-21, "re-add of existing contact lands on DM, not error") changed
  `app/pages/add.tsx` so a non-blocked `already_exists` re-add `router.replace`s to
  `/contacts?id=<hex>&exists=1`. Neither testid ever appears → 30s timeout.

## Reproduction

```
docker compose -f docker-compose.e2e.yml down -v && docker compose -f docker-compose.e2e.yml up -d --wait
cd app && PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/playwright-few E2E_GROUPS=1 node scripts/run-e2e.mjs \
  tests/e2e/groups-invitation-preview.spec.ts tests/e2e/groups-profile-update-propagation.spec.ts \
  tests/e2e/groups-remove-member.spec.ts
```

## Impact

Three relay specs (and their serial followers) never exercise their real assertions; the full e2e
gate is red for a test-helper reason, masking genuine regressions.

## Constraints

- Product behaviour (re-add lands on the contact) is intended and shipped — do not change it.
- The helper must stay strict: accept only the real success outcomes (new-contact success view /
  the `exists=1` contact landing), never "any navigation".
