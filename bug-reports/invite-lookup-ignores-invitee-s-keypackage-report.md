# An invite ignores the invitee's KeyPackage relay list

Source: BACKLOG.json finding `invite-lookup-ignores-invitee-s-keypackage` promoted 2026-11-09 (filed
2026-10-19 during loop item 12; AGENT-DECIDES).

## Actual
`inviteByNpub` (`app/src/context/MarmotContext.tsx` ~2219) fetches the invitee's KeyPackage (kinds 443 and
30443) from the inviter's NDK pool only. It never reads the invitee's KeyPackage relay list. When the pool
holds no KeyPackage it reports `no_key_package`, although the invitee may have published one on relays it
advertises.

The Welcome has the twin defect. `NdkNetworkAdapter.getUserInboxRelays` (~164) reads only kind 10051. The
app itself advertises its relays as kind 30051 with `['d','marmot']` and never publishes 10051, so for a Few
peer the Welcome always goes to the inviter's own relays, whatever the invitee advertised.

## Expected (scope ruled 2026-11-09: lookup and routing only, no new publication)
1. The inviter resolves the invitee's KeyPackage relay list from its pool: kind 30051 with `d=marmot`
   first, kind 10051 otherwise. It uses only an event authored by the invitee, and the newest one.
2. Listed URLs are filtered: valid relay URL, `wss://` (`ws://` only for localhost), normalised, deduped,
   at most 3 in list order.
3. KeyPackages are fetched from the pool and from the listed relays. `no_key_package` is reported only when
   both hold none; `timeout` only when nothing was found and a fetch timed out. A failing listed relay is
   not fatal.
4. A listed relay that was not in the pool before the lookup is not left in the pool afterwards, and is
   never written to the saved relay settings.
5. The Welcome is sent to the listed relays plus the inviter's relays (not the listed relays alone).
6. What the app publishes is unchanged: 30051 only, to the user's effective relays.

## Not in scope (stays open as an OWNER question)
Two Few users with fully disjoint relay lists still cannot invite each other: the relay list itself is
published only on the invitee's relays, so the inviter cannot find it. Fixing that needs a new publication
(a relay-list pointer on the default relays) or relay hints in the invite/pairing code. Both are product
decisions. `docs/behavior/groups.md` must state this limit.

## Reproduction
Unit, on an extracted dependency-injected helper: the pool holds the invitee's relay list but no
KeyPackage; a listed relay outside the pool holds the KeyPackage. Before the fix the lookup returns
`no_key_package`.

## Impact
An invitee whose KeyPackage is on relays it advertises but the inviter does not use (a non-Few Marmot
client that publishes kind 10051 widely; a Few user after a relay change) cannot be invited, and its
Welcome goes to relays it may not read.

## Test
Unit: the lookup helper and `getUserInboxRelays`. E2E: the full gate as a regression check. The e2e stack
has one relay, and the app cannot itself produce the "list reachable, KeyPackage elsewhere" state, so no
new e2e spec is added.
