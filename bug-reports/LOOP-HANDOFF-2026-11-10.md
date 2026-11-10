# Loop handoff — 2026-11-10 (supersedes LOOP-HANDOFF-2026-10-19.md)

Status: **paused at the owner's request** after item 16, with a clean tree. The only uncommitted change
is the owner's own `.clauded.yaml`. No AGENT-DECIDES fix is left that needs no owner input; what remains
is diagnosis work and items waiting on OWNER questions.

## Done in this run

| # | Commit | Finding (slug) | What changed | Gate |
|---|--------|----------------|--------------|------|
| 16 | aa39de3 | `invite-lookup-ignores-invitee-s-keypackage` | An invite reads the invitee's advertised relay list and looks for the KeyPackage there too; the Welcome goes to the advertised relays plus our own. Details below. | first run red (3 failures), second run green (72 + 353); see "Gate" |

Items 7–15 are described in LOOP-HANDOFF-2026-10-19.md.

### Item 16 in detail
- **Lookup.** `inviteByNpub` delegates to `lookupInviteeKeyPackages`
  (`app/src/lib/marmot/inviteeKeyPackageLookup.ts`). It reads the invitee's relay list from our relays:
  kind 30051 with `d=marmot` first, kind 10051 otherwise, newest, signed by the invitee. If our relays
  hold a usable KeyPackage, that one is used and the advertised relays are not asked. Otherwise up to 3
  advertised relays (`wss://`, or `ws://` on localhost) are asked, with a 5 s bound each.
- **No pool side effects.** Advertised relays are queried over one-shot raw WebSockets
  (`app/src/lib/marmot/relayRequest.ts`). They never enter the NDK pool or the saved relay settings.
- **Signature checks.** Every relay-list and KeyPackage event is verified with nostr-tools before use.
  This also closes an older exposure: NDK samples signature verification for long-trusted relays, so a
  forged KeyPackage could previously have been accepted.
- **Welcome.** `getUserInboxRelays` returns the advertised relays plus our effective relays, and our
  relays alone when no valid list was read.
- **Unchanged.** What the app publishes (30051 only, to the effective relays), the error codes, and
  everything in `inviteByNpub` after the fetch.
- **Limit.** Two users whose relay lists share no relay still cannot invite each other, because the
  relay list itself is only on the invitee's relays. In practice the fix helps partial overlap and
  non-Few Marmot clients that publish kind 10051 widely. `docs/behavior/groups.md` §4.1 states the
  limit. See OWNER question 11.
- **Verification.** Unit suite 6566 passed, 1 skipped. Stryker at concurrency 1 on the two new modules:
  90.88% (23 survivors, all equivalent mutants or redundant defensive catches). Reviewer accepted in
  round 3; Codex approved in its third pass.

### Gate
The full `make test-e2e-all` gate was run twice on the final tree.
- **Run 1: red.** 72 + 349 passed, 3 failed.
  - `dm-pairing-pending-confirmation:205`: the known composer stall. The probe did not arm in time
    ("arming timed out"), so there is no stack.
  - `groups-contacts:54`: the documented profile-propagation flake at line 93 (the contact card shows
    the npub, not "Bob"). It failed the same way in 1 of 3 isolated reruns.
  - `groups-cancel-pending:144`: the cancel announcement was not visible within 15 s. This failure is
    new. It passed 8 of 8 isolated reruns. It occurs after the invite has succeeded, and the fix does
    not touch the cancel path. Filed as `groups-cancel-pending-announcement-flake`.
- **Run 2: green.** 72 + 353 passed, no stall, not INVALID.

The fix was committed on the green second run. The cause of the `groups-cancel-pending:144` failure is
not established.

### Not done in this run
- The retro synthesizer and project curator were not run (there was no retro stub for this run). The
  backlog changes were made directly through the backlog scripts.
- The Decider was never consulted; the `base:decider` and `base:verification-examiner` agent types
  became unavailable mid-run. The three remediation rounds were driven by the reviewer and Codex.

## Decisions taken for the owner to confirm (implementation-level, reversible)
- Item 16: at most 3 advertised relays are asked, 5 s each, and only when our own relays hold no usable
  KeyPackage.
- Item 16: Few's own list (30051 `d=marmot`) is preferred over kind 10051 when both exist.
- Item 16: the Welcome always also goes to our own relays, never to the advertised relays alone.
- Carried over from 2026-10-19: items 12, 13 and 14 (see that handoff).

## Next (AGENT-DECIDES, suggested order)
1. `dm-composer-enter-press-hangs-30s`: continue the diagnosis (state in the 2026-10-19 handoff). New
   data point: in run 1 the stall hit with the probe unarmed because arming timed out after 2 s. The
   renderer may therefore already have been blocked when the probe tried to attach.
2. `groups-cancel-pending-announcement-flake`: check whether the `page.goto` in the `:131` test unloads
   the page while the announcement send or its echo is in flight. That would be the same class as the
   `groups-contacts:93` race (`bug-reports/profile-propagation-flake-diagnosis.md`).
3. `advanced-settings-spec-relay-list-kind-mismatch`: `specs/advanced-settings.md` says kind 10051;
   AC-RELAY-9 and the code use 30051. A one-line spec correction, unless Q11 decides to publish 10051.
4. `stale-replace-other-tab-writes`: only after OWNER Q4.
5. `forwarded-envelope-freshness-and-replay`: only if OWNER Q8 wants the ADR-012 hardening.

## OWNER questions (Fable's recommendation marked "rec.")
1–10 are unchanged from LOOP-HANDOFF-2026-10-19.md and still open.

11. (new) Two Few users with fully disjoint relay lists cannot invite each other
    (`disjoint-relay-lists-cannot-invite`). Should Few publish a relay-list-only pointer (relay URLs
    only, no profile data) to the default relays even after the user removed them?
    - Yes: 30051 plus 10051, on by default, with an Advanced-settings opt-out (rec.).
    - No: carry relay hints in the invite or pairing code instead.
    - No: accept the limit as documented.

## Environment notes and traps learned in this run
- The base plugin's scripts need `CLAUDE_PLUGIN_DATA=/home/mrother.guest/.claude/plugins/data/base-941design`
  in the environment; without it they fail with "CLAUDE_PLUGIN_DATA is not set".
- NDK 3.0.3 pool facts:
  - `NDKRelaySet.fromRelayUrls` adds temporary relays to the shared pool with a 30 s removal timer, and
    `pool.removeRelay` does not clear that timer. Do not use it for a one-off query to a foreign relay.
  - Pool keys are normalised with a trailing slash, even after a query string.
  - A subscription without a relay set asks only `pool.permanentAndConnectedRelays()`.
  - The pool is rebuilt from `DEFAULT_RELAYS` on each load.
- The Welcome publish path in the adapter uses raw WebSockets (`rawPublish`), not the pool.
- Two `publishGuardRealPublish.test.ts` cases can time out when the unit suite runs under host load;
  a quiet rerun passes.
- A full gate took 75–90 min in this run (1 CPU). Isolated reruns need a relay wipe first
  (`docker compose -f docker-compose.e2e.yml down -v && up -d --wait`) and
  `PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/playwright-few`.
- Stryker scratch configs for item 16 are in the session scratchpad (`stryker.kp.mjs`,
  `vitest.stryker.kp.mjs`); the source-scan suite `inviteLookupWiring.test.ts` is excluded from them.
- Everything else in the 2026-10-19 "Environment notes" still applies, including: never commit, revert
  or stage `.clauded.yaml`, and never edit `app/` while a gate runs.

## Instructions for unattended work
Unchanged from LOOP-HANDOFF-2026-10-17.md §"Instructions for unattended work".
