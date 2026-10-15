# Gate 7 "regressions" — diagnosis (2026-10-15)

Gate log: `/tmp/claude-501/e2e-gate/full-7.log`. Failing specs under investigation:

1. `dm-block-contact.spec.ts:257` (AC-UNBLOCK-2/4 / AC-PRIV-1/2/3): 2 publishes after the unblock baseline (`[30078, 445]`)
2. `dm-feedback-channel.spec.ts:115`: `group-detail-page` not visible (`helpers/group-setup.ts:100`)
3. `dm-giftwrap-bell.spec.ts:99`: the newly created group's card is never clickable (`helpers/group-setup.ts:266`)

## Verdict

**Not a code regression.** The gate ran against the main working tree's `next dev`
while the polls-integrity fixer was still editing poll files. Next.js hot module
replacement (HMR) served half-edited code, which produced HTTP 500s and runtime
errors, and it forced full page reloads in the middle of tests. Each of the three
failures directly follows one of those forced reloads.

## Attribution

All runs used the shared lock, a relay wiped with `down -v`, `PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/playwright-few` and `E2E_GROUPS=1`. Each run covered the 3 specs, which is 10 tests.

| Tree | What it contains | Result |
|---|---|---|
| `wt-head` | HEAD `b5e6f45`, which includes 9471e99 and bbb96d6 | **10/10 passed** |
| `wt-wip` | HEAD plus a frozen snapshot of the full uncommitted working tree (small-ui-count-bugs and polls-integrity diffs, with the untracked `pollReplay.ts`) | **10/10 passed** |
| `wt-wip` + HMR pokes | Same snapshot. A comment line was appended to `pollPersistence.ts` every 15s, giving 8 full reloads during the run | **10/10 passed**, so harmless reloads alone do not reproduce the failures (see below) |

No bisect over 9471e99 and bbb96d6 was needed, because HEAD is green. The
uncommitted small-bugs and polls diffs are also green once frozen.

## Root cause per failure

The evidence is in the gate log. Next stamps `/version.json?t=` with a timestamp, and the poll file mtimes were taken from the main tree:

- 11:34:25 (log :332–339): `GET /groups/ 500` and `GET /version.json 500` appear, then `Fast Refresh had to perform a full reload when ./src/lib/marmot/handlers/pollHandler.ts changed`, followed twice by `... due to a runtime error`. A file on disk was half-edited at that moment (last mtime of `pollHandler.ts` is 11:34:52).
- **Failure 1** (log :365–371, about 11:35:01): two full reloads for `handlers/chatHandler.ts`, whose mtime is 11:35:01. They land after the test's `beforeUnblockClick` snapshot (`dm-block-contact.spec.ts:300`). The reload remounts the app on `/profile`. The remount runs the app-start relay-backup publish (kind 30078) and the AC-023 stale-profile sweep (kind-445 profile-request). Both are counted as "caused by unblock". The spec's 3s sweep wait (:292–298) cannot cover a remount that happens after the baseline. `performUnblockContact` itself does not publish anything.
- **Failure 2** (log :395–402): two full reloads for `pollPersistence.ts` hit while `inviteContactViaPicker` was navigating `/add` → `/groups?id=…` (`group-setup.ts:99–100`). The log shows the reloaded pages as `GET /groups/` (no `?id`). The detail page never rendered under the half-edited code.
- **Failure 3** (log :415–420): two more full reloads for `pollPersistence.ts` (final mtime 11:36:24) hit during the 3s settle wait after `createGroup` (`group-setup.ts:262`). `createGroup` had already seen the card (count before+1). The page reloaded into a transient module graph and the card never re-rendered within 30s.

The harmless-HMR repro passed. So the damage came from the *broken intermediate
states* the dev server compiled (500s and runtime errors while the poll API changed
from `loadVotes(pollId)` to `loadVotes(groupId, pollId)` across several files). It did
not come from reloads alone. Those states cannot be recovered after the fact, but both
end states (HEAD and the snapshot) are green.

Not part of this diagnosis: `groups-contacts.spec.ts:54` (log :942, own name shown as
an npub) also failed in gate 7, with no HMR event nearby. That matches the known
profile-seed and `clearAppState` flake class (memory `e2e_profile_seed_clearstate_race`), and it was not investigated here.

## Proposed minimal fix (test infrastructure / process, no product change)

1. **Run gates against a frozen tree.** Make the e2e gate run in a snapshot worktree
   (HEAD plus `git diff | git apply` plus untracked files, `node_modules` symlinked, as done here),
   or never start a gate while a fixer is editing `app/`.
2. **Make contamination visible.** In `app/scripts/run-e2e.mjs`, watch the dev-server
   output for `Fast Refresh had to perform a full reload` or `GET … 500`. If either appears, print a loud
   "RUN INVALID: source changed during e2e" warning and exit non-zero, so a contaminated
   gate is never read as a product regression.
3. Optional hardening: start the e2e dev server with file watching disabled
   (for example, the webpack `watchOptions.ignored` set to `**/*` when `E2E=1`), so mid-run edits cannot reach the browser.
