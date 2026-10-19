# A KeyPackage publish no relay accepted leaves the account uninvitable

Source: BACKLOG.json finding `invite-fresh-peer-fails-with-has` (e2e flake, two sightings on the 1-CPU VM,
2026-10-18; AGENT-DECIDES loop item 12).

## Actual
An inviter sees "This user has not set up their Few identity yet": the invitee's KeyPackage is not on the
relay. Root cause (code, not only timing):
1. At startup MarmotContext publishes KeyPackages only when the local store holds none
   (`client.keyPackages.count() === 0`).
2. marmot-ts `KeyPackageManager.create` stores the private material locally BEFORE publishing, and records
   the event as published whatever the relays answered.
3. `NdkNetworkAdapter.publish` never throws: a relay timeout or websocket error resolves `ok: false`.

So when the first publish is not accepted (cold relay, offline at first launch, a slow connection on the
1-CPU VM), the device keeps 5 local KeyPackages, the relay has none, and no later start ever publishes
again. The account cannot be invited until its local packages are used up.

## Expected
If the relays hold no KeyPackage of ours, the app publishes again. A device that cannot reach the relays
(the check times out) does not churn.

## Test
Unit (pure helper `ensureKeyPackagesOnRelays`): local none → publish; local present and relays have one →
no publish; local present and relays have none (fetch complete) → republish; fetch timed out → no publish;
fetch throws → no publish. Source scan: MarmotContext runs the check in the background after startup.
E2E: the full gate (the invite helpers).
