# Adopt @941design/marmot — Acceptance Criteria

## Terminology

- **Library harness** — an in-process vitest suite (`// @vitest-environment node`) running real `@941design/marmot` clients over `createMemoryStorage()` and `FakeRelay` from `@941design/nostr-events/transport/contract/conformance`. Used wherever the spec demands "real library" behaviour. Never bundled.
- **Unit** — vitest, `app/tests/unit/**/*.test.ts`, no jsdom; hooks tested via extracted pure functions; idb mocks seeded **out of key order** where order matters.
- **Smoke spec** — the temporary relay-bucket Playwright spec `groups-library-smoke.spec.ts` (D15); deleted in the last story.
- **Sink** — the app `HistoryBackend` (`app/src/lib/marmot/history/`), backed by the per-account idb store `few-group-history:<pubkey>`, keyed `${groupId}:${eventId}`, rows `{entry, seq, dispatched}`.
- **Own row** — an optimistic own chat row awaiting confirmation; its identity is the canonical `rumor.id`.
- **Retired kinds** — 13 (leave_intent) and 21063 (decline DM); never reusable.
- **App inbox kinds** — 21059 join request, 21060 pairing ack, 21061/21062 DM profile, 21064 invite context.
- **App rumor kinds** — 0, 5, 7, 9, 10, 11, 12, 30.
- **Checkpoint subset** — `groups-lifecycle`, `groups-welcome`, `groups-pull-only-invitation-accept`, `groups-pull-only-invitation-decline`, `groups-leave-intent`, `groups-remove-member`, `groups-dispatch-isolation`, `dm-walled-garden-group-member-allowed`. A dev aid, never a pass.
- **Verification level tags** — each AC ends with `[L: ...]` naming its level: `unit`, `harness` (library harness), `e2e:<spec>`, or `structural` (grep/file/build check, used only where the requirement is genuinely structural).
- **Stub litmus** — each behavioral AC names a concrete output, stored state, emitted event content or raised error that a no-op/stub cannot produce.

## Known TAGs

- **DEP** — dependency pins, bundler config, build.
- **BOOT** — client bootstrap, lifecycle, startup reconciliation, wipe.
- **SIGN** — signer adapter, budgets, NIP-46 permissions, nip44 gate.
- **TRANS** — transport.
- **HIST** — history sink (append / withdraw / list / purge / sweep) and handler dispatch.
- **IDEM** — idempotency / ordering of the sink.
- **OWN** — own-send echo and reconciliation.
- **FORGE** — sender binding.
- **WDR** — withdrawal and own-send failure detection.
- **SEND** — outbound helper and call-site migration.
- **MEDIA** — encrypted media.
- **INV** — invitations: invite, pending, accept, decline.
- **KP** — key-package lookup and publish.
- **CTX** — invite-context (D3).
- **BLK** — deny layer.
- **CAP** — pending-invitation caps.
- **AUTO** — auto-accept correlation.
- **JOIN** — join requests.
- **DECL** — decline durability.
- **LEAVE** — leave and eligibility.
- **MEM** — remove member, cancel invitation, admins, rename, removed-by-admin.
- **MT** — multi-tab lease.
- **BKP** — relay backup (D5).
- **REL** — inbox relay list and relay settings (D17).
- **KIND** — kind registry.
- **WIPE** — `storeIncompatible` and startup reconciliation.
- **PRIV** — privacy invariant.
- **CTXT** — `MarmotContext` composition root and `useMarmot()` surface.
- **DEL** — deletion of superseded code, keys, stores.
- **TEST** — test-removal rule, test rewrites, gates.
- **GATE** — run sequencing, smoke proof, end gate.
- **DOC** — behaviour docs, ADR, CLAUDE.md.
- **MUT** — mutation gate (D11).
- **STRUCT** — genuinely structural assertions.
- **OBS** — cross-cutting whole-flow properties.

Reconciliation note (Mode 1): AC text names new modules (`client/`, `history/`, `send/`, `invitations/`, `membership/`, `kinds.ts`) that the exploration reports as absent. These are artifacts this epic creates, so the references were kept (verdict `keep`); no AC was rewritten or retired. Library typings were not installed at exploration time, so library member names (`groups.list`, `invitations.pending`, `extensions.registerInboxHandler`, `RUMOR_KINDS`, etc.) are `unverifiable` and are taken from the spec.

## Dependencies and client bootstrap (S1)

**AC-DEP-1** — After the change, `app/package.json` MUST list `@941design/marmot`, `@941design/marmot-engine`, `@941design/nostr-events` each at the exact string `0.2.0-alpha.0` and `nostr-tools` at the exact string `2.23.3` (no `^`/`~`/range). [L: structural; checked by a node script reading package.json]

**AC-DEP-2** — `app/package.json` MUST NOT list `@internet-privacy/marmot-ts` or `ts-mls` as dependencies. `@hpke/*` and `@noble/post-quantum` MUST be absent unless a grep of `app/src` and `app/tests` finds a remaining import of them. [L: structural]

**AC-DEP-3** — `app/next.config.mjs` swc-loader include MUST match `node_modules/@941design/marmot`, `…/marmot-engine`, `…/nostr-events` paths and MUST still match `node_modules/ts-mls`; `swcMinify` MUST remain `false`. Evaluating the include predicate against a path under each of those four packages MUST return true. [L: unit (imports the config's include list)]

**AC-DEP-4** — A resolve check MUST import each new package's subpath exports used by the app (`@941design/marmot`, `@941design/marmot/mls`, `@941design/marmot-engine/core` (the engine package has no root `.` export), `@941design/nostr-events`, `@941design/nostr-events/transport/contract/conformance`) without a "Cannot find module" error after `make deps`. [L: unit/structural (node resolve script wired into a vitest test)]

**AC-DEL-1** — `grep -rE "@internet-privacy/marmot-ts|from ['\"]ts-mls" app/src app/tests` MUST return zero matches on the final tree; imports of MLS types MUST come only from `@941design/marmot/mls`. `make build` MUST exit 0. [L: structural]

**AC-TRANS-1** — The client bootstrap MUST build its transport with `createSimplePoolNetwork({pool}).asTransportContract()` over a nostr-tools `SimplePool` owned by the marmot client, MUST pass no `verifier`, and MUST dispose that pool on teardown. A harness/unit test with a recording pool MUST observe the client's subscription and publish calls going to that pool, and observe `pool.close` (or equivalent) called after `dispose`. No `NDKRelay`/NDK instance MUST be reachable from the client module's import graph. [L: unit (stub pool) + structural import-graph check]

**AC-SIGN-1** — The signer adapter MUST wrap the app `EventSigner` with `fromForeignSigner(..., APPLESAUCE_SHAPE)`. For an nsec signer it MUST return a signer whose `budget` policy is `none`; for NIP-07 and NIP-46 signers it MUST return a timeout-policy budget. Asserted by calling the adapter factory with each signer mode and inspecting the resulting budget policy value. [L: unit]

**AC-SIGN-2** — Given a signer lacking `nip44`, the adapter factory MUST report `unsupported` with reason `nip44` and MUST NOT construct a client; the i18n string MUST exist (en and de entries both present and non-empty, different from each other). No fallback encryption path MUST exist. [L: unit (factory + i18n key presence)] The `useMarmot()` `unsupported` state and the UI rendering of that string are verified in S18 (cut-over) — see AC-SIGN-2b.

**AC-SIGN-3** — The NIP-46 requested-permission list MUST equal the union of `permissions.toNip46Perms()` and `sign_event` for every kind the app itself signs with the account key: 0, 20602, 30078, 10050, 24242 (Blossom upload auth) and 25050–25055 (call signaling inner events); it MUST NOT contain `sign_event` for 443, 444, 445, 1059, 10051 or 30051. A guard test MUST derive the app-signed kinds from the code's kind constants (Blossom auth kind, call kinds) so a new account-signed kind cannot be added without updating the set. [L: unit (exact set equality)]

**AC-SIGN-4** — A stored NIP-46 session whose granted perms equal the old set (including 30051/443/444) MUST be discarded on load (stored session cleared, user routed to reconnect); a stored session whose granted perms cover the new set MUST be kept. [L: unit]

**AC-SIGN-5** — The secure-context gate MUST still prevent client construction when `window.isSecureContext` is false (state `unsupported`, no `createMarmotClient` call). [L: unit]

**AC-SIGN-2b** — After the cut-over, given a signer lacking `nip44`, the `useMarmot()` state MUST be `unsupported` and the groups UI MUST render `groups.unsupportedNip44` (no group surfaces usable). [L: unit (context state extraction) + structural]

**AC-BOOT-3b** — After the cut-over, sign-out and signer-mode change MUST run the client teardown (abort an in-flight bootstrap via its AbortSignal, else `teardown()`), and the next bootstrap MUST be for the new pubkey only. [L: unit (context lifecycle extraction)]

**AC-SIGN-4b** — After the cut-over, on connect the app MUST persist `buildNip46Permissions()` next to the NIP-46 session payload, and on load MUST call `shouldDiscardStoredNip46Session` with that record: an old-set or missing record clears the session and routes to reconnect; a new-set session survives a reload (connect → reload → kept). [L: unit (identity load/connect extraction)]

**AC-BOUND-1** — Pure modules under `app/src/lib/marmot/**` MUST NOT import from `app/src/context/**` or React. [L: structural; existing import-boundary test extended to the new directories] Sole temporary exemption: the pre-existing `outboundJoinRequests.ts` React import, which S12 (owner of that file) removes, deleting the exemption from the boundary test.

**AC-BOOT-1** — Given the library harness, the bootstrap MUST run in this order: `openForWrite(pubkey)` → `createMarmotClient` → listener attach → inbox handlers registered (kinds 21059 and 21064) → `groups.list()` → per-group `onNotification` attach → history `sweep()` → `inbox.start()` → key-package ensure → kind-10050 ensure. A recording fake MUST show that call sequence; neither `sweep()` nor `inbox.start()` MUST be called before `groups.list()` resolves, and `inbox.start()` MUST NOT be called before `sweep()` settles. A rejected `sweep()` MUST be reported and MUST NOT abort the bootstrap. The bootstrap waits for `sweep()` at most HISTORY_SWEEP_WAIT_MS (15 s) and stops waiting on abort; past the cap it reports and continues, the sweep finishing in the background. [L: unit (sequence recorder) + harness]

**AC-BOOT-2** — Key-package ensure: when `keyPackages.count()` is 0 the bootstrap MUST call `keyPackages.create({lastResort:true})` exactly once; when count > 0 it MUST NOT create. After bootstrap in the harness the relay MUST hold exactly one kind-30443 event authored by the account and no kind-443 event. [L: harness]

**AC-BOOT-3** — Teardown MUST call `client.dispose()` then `stores.close()` (in that order), and a subsequent bootstrap for a different pubkey MUST use that pubkey's own store (no cross-account reads). A recording fake MUST show the order; a harness two-account run MUST show account B sees none of account A's groups. [L: unit + harness]

**AC-BOOT-4** — Client event listeners MUST be attached for `groupRemoved`, `inboxDisposition`, `welcomeDeclined`, `intentFailed`, `storeIncompatible`, `groupBranchSwitched`; emitting each event on a fake client MUST invoke exactly the corresponding app handler once. [L: unit]

**AC-BOOT-5** — Code running inside `HistoryBackend` calls, inbox handlers or client event listeners MUST NOT await an account-scope client call; follow-up client work MUST be queued with `setTimeout(0)` onto an owned FIFO that runs one job at a time. A test that enqueues two jobs from within a handler MUST observe: neither runs before the handler returns, and the second starts only after the first settles. [L: unit (fake timers)]

**AC-BOOT-6** — Library timing options MUST be `leaveTimeoutMs: 10000` and `removalSettleMs: 5000` in the options object passed to `createMarmotClient`. [L: unit (captured options)]

**AC-BOOT-7** — The library MUST be constructed only inside browser effects: importing `app/src/lib/marmot/client/index.ts` under `// @vitest-environment node` with `window` undefined MUST NOT throw, and `next build` static export MUST succeed. [L: unit + structural (`make build`)]

## Inbound history sink and handlers (S2)

**AC-HIST-1** — `append(entry)` on a fresh `(groupId,eventId)` MUST persist a row `{entry, seq, dispatched:false}` in `few-group-history`, call the app handlers once with `{groupId, eventId, rumor, sender}`, then rewrite the row with `dispatched:true`. Asserted by reading the idb mock after append (row present, `dispatched:true`) and by a handler spy called once. [L: unit]

**AC-HIST-2** — `sender` passed to every group handler MUST equal `entry.orderingKey.account`, never `rumor.pubkey`. A test feeding an entry whose `orderingKey.account` differs from `rumor.pubkey` MUST observe the handler receive the `orderingKey.account` value. [L: unit]

**AC-HIST-3** — If a handler throws, `append` MUST reject (so the library retries), the row MUST remain `dispatched:false`, and no later row for the same group MUST be marked dispatched by that call. A retry `append` of the same entry MUST re-run the handlers and, once they succeed, set `dispatched:true`. [L: unit]

**AC-HIST-4** — The entry's own dispatch in `append` MUST be bounded by 10 s: a handler that never resolves MUST cause `append` to reject within 10 s of fake-time after its own dispatch starts (not hang), leaving `dispatched:false`. On a group's first touch, the bounded recovery of older undispatched rows (AC-HIST-7, each row bounded by 10 s) runs before it; that extra time occurs at most once per group per backend instance, and a library timeout of such an append is retried and joins the in-flight dispatch. [L: unit (fake timers)]

**AC-HIST-5** — `withdraw(groupId, eventIds)` MUST delete the matching `few-group-history` rows and invoke the handlers' retract path once per withdrawn row of a registered kind (rows of unregistered kinds were never dispatched, AC-HIST-9, so they are deleted without retract); ids with no row MUST be a no-op (no retract call, no throw). `withdraw` MUST first durably mark every matching row `withdrawing`, then retract and delete each marked row IN TURN (a row is deleted right after its own retract, each step under its own settle bound; a failure or timeout leaves the earlier rows deleted and the rest marked, and the next `append`/`withdraw` of the group or a restart finishes them); a `withdrawing` row found at first-touch recovery or sweep MUST be retracted and deleted before any re-dispatch. Handlers receive `remaining()` = the group's dispatched, non-withdrawing rows in `seq` order (with persisted `receivedAt`; a row still `dispatched:false` is not in it, accepted), and the retract names the whole batch (`batch`) so one recompute per aggregate serves every withdrawn row naming it. A dispatch input carries the row's `receivedAt`, the clock a later recompute folds it with. [L: unit]

**AC-HIST-6** — `purge(groupId)` MUST delete every row for that group and no rows of any other group. [L: unit]

**AC-HIST-7** — Undispatched-row recovery. (a) First touch: per backend instance, before the sink runs its first `append` or `withdraw` for a group, every row of that group with `dispatched:false` MUST be re-dispatched through the handlers in `seq` order and marked `dispatched:true`, inside the same per-group serialised job, so no newer entry of that group is dispatched ahead of them; this recovery runs at most once per group per instance. (b) Startup pass: `sweep()` MUST apply the same recovery to every group that has a `dispatched:false` row and was not yet touched; the bootstrap calls it after `groups.list()` resolves and before `inbox.start()` (AC-BOOT-1). A row with `dispatched:true` MUST NOT be re-dispatched. A recovery handler failure MUST leave the row `dispatched:false`, MUST NOT abort recovery of the group's later rows or of other groups, and MUST NOT by itself reject the `append`/`withdraw` that triggered it. (c) Poison bound: a row whose recovery has failed 5 times (persisted counter, matching the library's own attempt cap) MUST be marked abandoned (no further recovery, reported once) so a hanging handler cannot delay every startup indefinitely. Tests: with two undispatched rows seeded for a group, a live `append` of a newer entry issued before `sweep()` MUST produce handler calls in the order row 1, row 2, new entry, and a following `sweep()` MUST dispatch nothing for that group; an `append` whose event id equals a recovered row MUST call the handler once in total; a row failing recovery 5 times is not attempted a 6th time. [L: unit]

**AC-HIST-8** — The sink MUST NOT use idb-keyval `update()`: no `update(` call from `idb-keyval` appears in any file under `app/src/lib/marmot/history/`. [L: structural (existing repo-wide ban test)]

**AC-HIST-9** — Handlers for chat (kind 9, incl. edit-marked kind 9), reaction (7), delete (5), polls (10 open, 11 vote, 12 close), profile (0), profile-request (30) and announcement rumors MUST each be reachable from `append` via the rumor kind; an unregistered kind MUST be stored and marked `dispatched:true` with no handler call and no throw. Asserted per kind against the real stores: the corresponding store receives the row. [L: unit]

**AC-HIST-10** — Message-type store bumps (chat, reaction, poll, delete/edit) MUST be driven from handler completion inside `append`/`withdraw`; `group.onNotification` MUST drive only member, admin, name and disband resync. A test emitting a `message` notification only MUST leave message stores unchanged; a test emitting `members` MUST NOT bump message stores. [L: unit]

**AC-HIST-11** — Roster and admin gates inside handlers (announcement roster gate, profile-request gate, admin-only signals) MUST read live `group.members()` / `group.admins` accessors, never the overlay. A test where overlay and live accessor disagree MUST gate by the live accessor. Handlers obtain the group handle through an injected `groupOf(groupId)` backed by `client.groups.get`. When it resolves `undefined` (group no longer held) the gate MUST fail closed (gated effect not applied, no throw); when it rejects, the handler MUST reject so the row stays `dispatched:false`. A test with `groupOf` resolving `undefined` MUST show the gated effect absent and the row marked `dispatched:true`. [L: unit]

**AC-HIST-12** — Every behavioural handler family (chat, reactions, delete/edit, polls, profile, profile-request, announcement roster gate) MUST have a passing behavioural suite against the sink-path factories and the input `{groupId, eventId, rumor, sender}`; the legacy suites may keep exercising the legacy factories until S22 deletes both (S22 MUST port any behaviour covered only by a legacy suite before deleting it). `handlersRumorPubkeyBoundary` MUST be re-expressed asserting that a handler given `sender ≠ rumor.pubkey` attributes the content to `sender`. [L: unit]

**AC-IDEM-1** — Replaying `append` for an event id whose row is `dispatched:true` MUST leave exactly one stored row, exactly one chat/reaction/poll row in the app store, and handler spies called once total. Re-appending a row with `dispatched:false` MUST re-run the handlers. [L: unit]

**AC-IDEM-2** — `list(groupId)` MUST return rows ordered by `seq` ascending; `seq` MUST be a per-group monotonic counter assigned at first append and unchanged by re-append. Tests seed the idb mock rows with keys deliberately out of `seq` order and assert the output order, and assert two groups keep independent counters. [L: unit]

**AC-FORGE-1** — Library harness with two real clients (Alice, Mallory) in one group: a rumor whose inner `pubkey` is Alice's but sent by Mallory's MLS leaf MUST never reach the sink's handlers and MUST never be rendered (chat store has no row for it). A genuine Alice message MUST be rendered attributed to Alice. [L: harness]

**AC-FORGE-2** — e2e: a group chat message sent through the app by Bob renders in Alice's UI attributed to Bob. The pre-existing impersonation exposure noted in `security_group_message_impersonation` MUST be closed (covered by AC-FORGE-1). [L: e2e:groups-identity (kept), harness]

**AC-OWN-1** — Harness/unit: after a member sends a chat message through the send helper and the sink echo arrives, the chat store MUST contain exactly one row with that `rumor.id`, and the group's unread count and the bell counter MUST be unchanged from before the send. [L: harness + unit]

**AC-OWN-2** — The own-echo path MUST hold for either arrival order: echo before `send()` resolves, and echo after. Both orders yield one row, status confirmed. [L: unit]

**AC-OWN-3** — e2e `groups-dispatch-isolation` MUST be rewritten so that its AC-AR-22 expectation reads: own send reconciles via the sink with no unread/bell increase (replacing dispatcher-level own-send suppression, D13); another member's message still raises unread. [L: e2e:groups-dispatch-isolation (rewritten)]

**AC-WDR-1** — After `withdraw` of an entry authored by another member, that member's chat row, reaction and poll event MUST be absent from the stores, and the group's unread count MUST equal the value recomputed over the remaining rows (asserted with a concrete before/after count). [L: unit]

**AC-WDR-2** — An own chat row that was withdrawn MUST end in the existing failed/retry status (not deleted) and MUST NOT be auto-resent (send spy call count unchanged). Own withdrawn reactions, votes, edit and delete signals MUST be dropped from the stores. [L: unit]

**AC-WDR-3** — Failure detection, one test per trigger: (a) `send()` rejects → row failed/retry, unless the library still holds the rumor queued (then it stays sending); (b) `intentFailed` whose intent id is bound to the row (the application intent created by that send, found by diffing `pendingIntents()` around the send) → failed/retry — failed intents of other operations do not fail it; (c) `groupBranchSwitched` for the group while unconfirmed → failed/retry; (d) still unconfirmed 60 s (fake-time) after the group is synced following `send()` resolution → failed/retry. For a row already confirmed through the sink, none of (a)–(d) MUST change its status. A later sink arrival with the same `rumor.id` for a failed row MUST flip it to confirmed. A retry MUST re-send the identical stored rumor (same id), and results of an earlier send attempt MUST NOT change a retried row. [L: unit (fake timers)]

**AC-WDR-4** — `withdraw` for an eventId that was never appended MUST leave all stores unchanged (the withdraw itself changes nothing and leaves no tombstone); a later `append` of the same id is applied normally, because the library only re-appends an id whose branch became canonical again. [L: unit]

**AC-WDR-5** — Harness: a fork rewind in the library that abandons another member's message causes the sink's `withdraw` to remove its chat row from the app store (A2). [L: harness (smoke spec covers the real-relay equivalent)]

**AC-WDR-6** — Effects already emitted (bell, known-peers additions, follow-up sends) MUST NOT be undone by `withdraw`: a test that appended then withdrew a message from a new peer MUST still find the peer in known-peers, and MUST NOT show a user-facing notice (no toast call). [L: unit]

**AC-WDR-7** — After any sequence of withdraws, the stored state of delete/edit slots, reactions and polls MUST equal the state produced by dispatching only the remaining history rows, in `seq` order, into empty stores (the oracle), for every withdraw order and with duplicate carriers. Plain kind-9 chat rows keep carrier accounting (AC-WDR-1/2). [L: unit, property]

**AC-WDR-8** — Withdrawing a row whose rumor is byte-identical to another member's remaining row MUST NOT change the effect of the remaining row; an effect is attributed only to `orderingKey.account` of a remaining row. [L: unit]

**AC-WDR-9** — A withdraw interrupted at any step MUST converge to AC-WDR-7 on the next backend start; recompute MUST be deterministic (persisted `receivedAt`, not wall clock) and MUST NOT emit bell, unread, known-peers or send effects. [L: unit]

## Outbound send and media (S3)

**AC-SEND-1** — `sendGroupRumor(group, kind, content, tags)` MUST compute the rumor `id` with nostr-tools `getEventHash`, set `pubkey` to the own account, and call `group.send({type:'application', rumor})` exactly once with that rumor; the returned/optimistic id MUST equal the rumor id. For chat, the precomputed canonical id (AC-AR-21) MUST equal the id seen in the echoed sink entry. [L: unit + harness]

**AC-SEND-2** — A harness send while a staged proposal is pending MUST deliver after the proposal commits with no app-side retry code; the second member receives the rumor with the identical id. [L: harness]

**AC-SEND-3** — Chat, reactions, delete/edit, polls, image messages, call notices, profile exchange and announcements MUST each send through `sendGroupRumor`; a send of each type against a fake group MUST observe a `group.send` call with the expected kind (9, 7, 5, 10/11/12, poll kinds, 9 with imeta, call notice kind, 0, announcement kind). [L: unit]

**AC-SEND-4** — The three `sendRumorSafe` copies MUST NOT exist (`grep -r sendRumorSafe app/src` returns zero matches). [L: structural]

**AC-MEDIA-1** — Image send MUST call `group.encryptMedia` and upload the ciphertext to Blossom; the published imeta tags MUST carry the library's media metadata and MUST NOT contain the plaintext bytes. Receive MUST call `group.decryptMedia` and render a blob equal to the sent bytes. Harness round trip with a fake Blossom: bytes in = bytes out, uploaded blob ≠ plaintext. [L: harness + unit]

**AC-MEDIA-2** — The decrypted-media cache (`few-media-blobs`, `few-media-meta`) MUST keep serving an already-decrypted image after reload without re-calling `decryptMedia`. [L: unit; e2e:groups-image-sharing (kept)]

**AC-SEND-5** — At most one `group.invite` is in flight per group, and `group.synced()` is awaited before invite, removeMember, setAdmins and rename (leave may skip it offline: `skipSync`; the library bounds leave by `leaveTimeoutMs`). Every wait is bounded (sync wait `syncTimeoutMs`, default 30 s; the commit-pending barrier likewise) and abortable; an op whose wait is lost before it starts rejects with a typed error and never runs. A test issuing two concurrent invites on one group MUST show serialisation (second call starts after first settles); a commit-pending rejection MUST be retried only for reasons the library clears itself (`awaiting-sync` after a bounded `synced()`; own pending commit / SelfRemove election / staged adds after an `ingest([])` barrier and backoff), while `proposal-deferred` and unknown reasons surface immediately. [L: unit]

## Invitations, join requests and inbox split (S4)

**AC-KP-1** — Invite MUST call `group.invite` with exactly one key-package event per call. Given candidates `[c1,c2,c3]` ordered `created_at` desc (tie: lower event id first; at most 6 candidates), when `c1` is rejected as a candidate (`invalid-options` with reason `verifier`, `invalid-keypackage` or `ineligible`, naming that event when an `eventId` is given) the lookup MUST call `invite([c2])` next, and on success stop; any other `invalid-options` (group-level, e.g. no group relays) MUST be thrown unchanged. When all candidates are exhausted the result MUST be the error `no usable key package`. An invitee who already holds a leaf MUST yield `already-member` without any `group.invite` call. [L: unit + harness]

**AC-KP-2** — The key-package lookup MUST query `transport.requestWithDeadline` with filter `{kinds:[30443], authors:[pk], limit:6}` over the union of the invitee's kind-10050 relays, kind-10002 write relays and the app defaults (deduplicated). Invitee-advertised relays are hostile input: at most 3 per list, `wss://`, no credentials, public DNS host (no IP literal, loopback, private, link-local or `.local`/`.internal` names); app-configured defaults are used as configured. "No key package found" MUST be reported on EOSE-with-empty-result or deadline. `keyPackages.observe` MUST NOT be called. This preserves commit aa39de3 for public relays: an invitee advertising a public wss relay outside the defaults MUST be found. [L: unit (recording transport)]

**AC-KP-3** — Tie-breaking: two candidates with equal `created_at` MUST be ordered by lexicographically lower event id first. [L: unit]

**AC-INV-1** — Library harness: Alice creates a group (`groups.create(name)`), invites Bob via the key-package lookup, Bob's `invitations.pending()` contains one invitation with Alice as `sponsorAccount`, `invitations.accept(id)` makes Bob a member, and both see each other in `group.members()`. [L: harness; e2e:groups-lifecycle, groups-welcome (kept)]

**AC-INV-2** — ADR-002 pull-only: a Welcome from an unrelated sponsor MUST land in `invitations.pending()` and MUST NOT auto-join; the invitee's group list stays unchanged until `accept`. [L: harness; e2e:groups-pull-only-invitation-accept (kept)]

**AC-INV-3** — Decline: `invitations.decline(id)` MUST remove the invitation from `pending()`, the sponsor's client MUST emit `welcomeDeclined` carrying `inviteeRef`, and the kind-21063 DM MUST NOT be published (recording transport sees no kind-21063). [L: harness; e2e:groups-pull-only-invitation-decline (kept)]

**AC-INV-4** — The invitation card MUST render from `invitations.pending()` only; `lp_pendingInvitations_v1` MUST NOT be read or written. [L: unit + structural]

**AC-INV-5** — The invitation-pending live-update behaviour MUST be preserved: a new invitation arriving while the invitee page is idle appears without reload. [L: e2e:groups-pending-invite-live-idle (kept)]

**AC-BLK-1** — For a blocked sponsor: an `inboxDisposition: pending` invitation MUST result in no entry in the app pending view, no bell increment, and a call `invitations.decline(id, {declineRumor:false})`; an invite-context rumor and a join request from the same blocked peer MUST each be dropped (nothing stored, no bell). A non-blocked sender MUST be processed normally. [L: unit + harness]

**AC-CAP-1** — With 257 pending invitations the 257th MUST be declined (retained total = 256); with 9 from one inviter the 9th MUST be declined (retained per inviter = 8). Declines are silent (no bell, no toast) and made with the library decline. The caps MUST equal the constants of `lib/pendingInvitations.ts` (256 / 8). [L: unit (stubbed pending list)]

**AC-CTX-1** — After a `delivered`/`retryable` invite outcome, the sponsor MUST send one `extensions.sendInboxRumor` of kind 21064 with content exactly `{"groupId":<id>,"name":<name>}` (no other keys, no description, no admins, no profile data); a `failed` outcome MUST send none. [L: unit (recording sendInboxRumor)]

**AC-CTX-2** — The invitation card MUST show the context's group name only when the context `rumor.pubkey` equals the invitation's `sponsorAccount` or one of its `sponsors`; any other sender MUST yield the generic label. The stored name MUST be keyed by `groupId+sponsor`, length-capped (cap constant asserted), and rendered as untrusted text (a name of `<b>x</b>` renders as literal text in the view model). The card MUST update live whether the context or the invitation arrives first, and MUST show the generic label when no context arrived. [L: unit (pure view-model function) + e2e:groups-invitation-preview (rewritten)]

**AC-CTX-3** — Holding store: contexts with no matching invitation MUST be kept at most 8 per sender and 64 in total (oldest evicted first), and expire after 7 days (fake-time). A held context MUST be validated against `sponsorAccount` when the invitation arrives and dropped on mismatch. The stored context MUST be deleted on accept, decline and expiry (7 days or the invitation leaving `invitations.pending()`). Tests assert exact retained sets after inserting 9/65 entries, and after 7 days + 1 ms. [L: unit]

**AC-CTX-4** — The invite-context handler MUST dedupe by `rumor.id` (redelivery stores one entry) and MUST persist-and-return without calling any account-scope client method. [L: unit]

**AC-CTX-5** — The invitation card MUST never show description or admin list pre-join. [L: unit (view model contains no such fields); e2e:groups-invitation-preview (rewritten)]

**AC-AUTO-1** — On `inboxDisposition: pending` with `groupId` and `sponsorAccount` matching an unexpired outbound join request, the app MUST call `invitations.accept(id)` exactly once (outside the listener frame, via the owned FIFO) and consume the request; a second matching event MUST NOT call accept. A non-matching invitation (different group, different sponsor, expired request) MUST stay pending with zero accept calls. The existing AC-AUTO rules apply unchanged. [L: unit + harness; e2e:groups-join-request-live (kept)]

**AC-AUTO-2** — Auto-accept MUST have exactly one mechanism: no `keyPackages.offer` and no `expectWelcome` call exists in `app/src`. [L: structural]

**AC-JOIN-1** — Join requests MUST be sent with `extensions.sendInboxRumor` of kind 21059; the join-request handler registered with `registerInboxHandler(21059)` MUST take the requester only from the delivered `rumor.pubkey`, dedupe by `rumor.id`, persist and return. Requester name/avatar travel inside the gift wrap only (recording transport: no kind 0, no cleartext nickname). [L: unit + harness]

**AC-JOIN-2** — Approval MUST fetch the requester's key package (AC-KP-1/2) and call `group.invite` with exactly one event; the request is then marked approved. [L: unit + harness; e2e:groups-invite-link, groups-join-request-profile (kept)]

**AC-JOIN-3** — Approving a requester whose account already holds a leaf in the group MUST issue no `group.invite` call, mark the request approved and consumed, and surface no error. [L: unit]

**AC-JOIN-4** — A join-request send whose outcome is `retryable` or `failed` MUST put the request into the existing send-failure state; no retry timer is created by the app for it. [L: unit]

**AC-JOIN-5** — Invite-link nonce, mute and dedup behaviour MUST be unchanged: replaying a join request with the same `rumor.id` or a muted requester MUST produce no new entry. [L: unit (existing join-request suite re-pointed); e2e:groups-invite-link (kept)]

**AC-INBOX-1** — Pairing-ack (21060) MUST be handled by the existing NDK DM listener; that listener MUST silently skip kinds 444, 4460–4462, 21059 and 21064 (no error log, no state change). `welcomeSubscription.ts` MUST NOT exist. [L: unit; e2e:dm-pairing-* (kept)]

**AC-INBOX-2** — Kind 21063 MUST NOT be sent or handled anywhere in `app/src` (only the retired-kind registry entry). [L: structural + AC-KIND-1]

**AC-DECL-1** — At invite time the sponsor MUST persist `inviteeRef → pubkey` in the pending-direct-invite marker. On `welcomeDeclined` the marker MUST be set `declined` durably before any removal work. The removal MUST run outside the listener frame after `await group.synced()`, and at startup MUST be retried for every `declined` marker. The marker MUST be cleared and the `declined` announcement sent only after `removeMember` resolved. Tests: (a) decline while group unsynced → `removeMember` call occurs only after `synced()` resolves; (b) decline while sponsor offline (listener fired, process restarts with marker in idb) → startup retry calls `removeMember`; (c) `removeMember` rejects → marker stays `declined`, no announcement; (d) success → marker cleared and exactly one announcement. [L: unit + harness; e2e:groups-direct-invite-lifecycle, groups-invite-lifecycle-announcements (kept)]

**AC-DECL-2** — A `welcomeDeclined` event with an unknown `inviteeRef` MUST be ignored (no `removeMember`). [L: unit]

**AC-DEL-2** — Pending-direct-invite marker shape MUST carry `inviteeRef` and a `declined` flag; legacy markers without `inviteeRef` MUST be ignored without throwing (pre-alpha, no migration). [L: unit]

## Membership and admin operations (S5)

**AC-LEAVE-1** — Eligibility (app-side, pure function): sole member → `abandon` (no `leave()` call, local purge only); sole admin with other members → blocked with the last-admin outcome and no `leave()` call; otherwise → `leave`. Truth table asserted over {members:1,2+} × {isAdmin} × {otherAdmins 0,1+}. The twin-read discipline (leaveGroupImpl and live-member read both guarded against a corrupt-state throw, with opposite fail-closed directions) MUST be kept: a throwing `members()` accessor MUST NOT skip the purge on the leave path and MUST fail closed on the live-member path. [L: unit]

**AC-LEAVE-2** — On leave, the group MUST disappear from the app group list immediately (before `leave()` settles); `leave()` MUST run in the background; the library group MUST be gone from `groups.list()` within 15 s (harness with real timing options); kind-9 "left" announcement MUST be sent first with a bounded wait and MUST soft-fail (a rejecting/hanging announcement does not block `leave()`). [L: unit + harness]

**AC-LEAVE-3** — If `leave()` rejects or times out (other than `last-admin`), the group MUST be restored to the list and the existing leave-failed toast i18n key MUST be shown. No durable "leaving" marker MUST be written (idb/localStorage scan after a mid-leave reload shows none; the group is listed again). [L: unit; e2e:groups-leave-intent (rewritten)]

**AC-LEAVE-4** — `getPendingRemovals`, the pending-removal store and its UI MUST NOT exist; the admin auto-commit of leave_intents and the left-group sweep/tombstones MUST NOT exist. [L: structural; e2e:groups-admin (pending-removal assertions deleted)]

**AC-LEAVE-5** — e2e: `groups-leave-intent`, `groups-leave-purges-mls-state`, `groups-reinvite-after-leave` MUST be rewritten to wait for library group absence via a `__fewTest` hook polling `groups.list()` before reload or re-invite, and MUST assert: the leaver's UI group is gone, the remaining members' rosters no longer contain the leaver, and re-invite after leave succeeds. [L: e2e:groups-leave-intent, groups-leave-purges-mls-state, groups-reinvite-after-leave (rewritten)]

**AC-LEAVE-6** — Last-member abandon and the "ever known survives leave" behaviour MUST be preserved. [L: e2e:groups-abandon-last-member, groups-ever-known-survives-leave, groups-poll-after-leave (kept)]

**AC-MEM-1** — Remove member MUST call the library `removeMember` once with the member's account and MUST work only for admins (a non-admin attempt surfaces the library error and the roster is unchanged). ADR-010 preserved. [L: harness; e2e:groups-remove-member (kept), groups-reinvite-after-removal (rewritten)]

**AC-MEM-2** — Cancel pending invitation MUST call `removeMember` for the invitee, clear the pending-direct-invite marker and update the UI. [L: unit; e2e:groups-cancel-pending (kept)]

**AC-MEM-3** — Grant admin MUST call `setAdmins` with the previous admins plus the target; rename MUST call `rename(name)`. After each, `group.admins` / name read from the library reflects the change in the harness. An `own-change-lost` outcome MUST be logged (console spy) and the view refreshed, with no toast and no UI notice. [L: unit + harness; e2e:groups-admin (kept minus pending-removal assertions), groups-rename (kept)]

**AC-MEM-4** — On `groupRemoved`, and at startup for any listed group whose `members()` lacks the own account (since `groupRemoved` is at-most-once), the app MUST run the local purge: library `group.abandon()` plus removal of app-side group data (overlay, member profiles, chat and poll rows, history rows via `purge`, invite links, markers), then update the UI so the group is gone. Tests: (a) event path; (b) startup-check path with no event; (c) second call is idempotent. [L: unit + harness; e2e:groups-remove-member (kept)]

**AC-MEM-5** — Disbanded/fenced groups MUST be surfaced through the existing UI state derived from `onNotification`; a disband notification marks the group disbanded in the overlay. [L: unit]

**AC-MEM-6** — A reinvited member (after leave or removal) MUST receive and be able to accept a fresh Welcome; the leaver's/removed member's old leaf MUST NOT block re-adding. [L: e2e:groups-reinvite-after-leave, groups-reinvite-after-removal (rewritten)]

## Multi-tab (S1 / S7)

**AC-MT-1** — With two `useMarmot` instances sharing a Web-Lock mock, the second (without the lease) MUST report `ready:false`, state "active in another tab" (new i18n string, en+de), perform no `group.*` write, and run none of the membership-derived sweeps (walled-garden purge, known-peers maintenance, invite-expiry sweep, profile-request sweep): spies on each MUST show zero calls. Its `whenReady()` MUST resolve once the lease outcome is known (lease-held), and `groups` MUST be exposed read-only from the overlay store. [L: unit (lease mock) + e2e:groups-multi-tab]

**AC-MT-2** — When the lease holder closes (lock released), the waiting tab MUST acquire the lease automatically (retrying `openForWrite` on `lease-held`), build the client, and flip to `ready:true` with no reload; thereafter sweeps run. [L: unit (lease mock with release) + e2e:groups-multi-tab]

**AC-MT-3** — Cross-tab store-changed sync for group data MUST be removed (no `storage`/BroadcastChannel listener for group stores) while DM, contacts and block cross-tab sync MUST remain (`dm-block-cross-tab` unchanged). [L: structural + e2e:dm-block-cross-tab (kept)]

**AC-MT-4** — DM gating and known-peers reads MUST work in a tab without the lease: a unit test with the lease-held state evaluating the walled-garden predicate over the overlay MUST return the same decision as in the lease-holder tab. [L: unit]

**AC-MT-5** — A new relay-bucket spec `app/tests/e2e/groups-multi-tab.spec.ts` MUST drive two pages of the same account in one browser context against the real Web Locks API and the real library lease (no mock, no raw relay publish): (a) after the first page has created a group, the second page MUST show the "active in another tab" state and MUST list that group; (b) after the first page is closed, the second page MUST become ready with no reload and a message sent from it in that group MUST appear in its chat. The spec MUST be counted in the CLAUDE.md e2e totals. [L: e2e:groups-multi-tab]

## Backup and recovery (S6)

**AC-BKP-1** — The kind-30078 backup payload built by the app MUST contain settings and own profile only: the serialized payload MUST NOT contain keys `groupStates`, `groups`, `memberProfiles`, `chatMessages` or `inviteLinks`. [L: unit]

**AC-BKP-2** — Restoring a backup payload that still contains those sections MUST restore settings and profile and MUST ignore the group sections (stores for groups, chats, member profiles, invite links remain empty; no throw). The group restore code MUST NOT exist. [L: unit + structural]

**AC-BKP-3** — `groups-seed-phrase`, `groups-seed-recovery`, `groups-backup-restore-outcomes` MUST be rewritten to assert: after recovery the account has settings and profile restored and no groups; rejoining by invitation works. They MUST NOT be deleted. [L: e2e:groups-seed-phrase, groups-seed-recovery, groups-backup-restore-outcomes (rewritten)]

**AC-BKP-4** — No `groups.restore` snapshot seam MUST be used (`grep -rn "groups.restore" app/src` empty). [L: structural]

**AC-BKP-5** — Backup publish MUST remain NIP-44 encrypted to the own key (kind 30078) and MUST carry no cleartext profile content (privacy invariant preserved). [L: unit]

## Relay list (S1 / S6)

**AC-REL-1** — Kind 10050 MUST be published listing exactly the configured relays only when the account has no kind-10050 or the existing one carries the app's `client` tag; when a foreign (untagged) 10050 exists, nothing MUST be published and its relays MUST be used for the client. Asserted with a recording transport for three cases: absent, app-tagged, foreign. The published 10050 MUST carry no profile data. [L: unit + harness]

**AC-REL-2** — A relay-settings save MUST (a) republish 10050 where permitted per AC-REL-1, (b) dispose and rebuild the client with the new defaults (recording shows `dispose` then a new `createMarmotClient` with the new relay list), and (c) rotate each listed key package so a kind-30443 exists on the new relays (harness: event present on the new FakeRelay). `republishDiscoverability` MUST NOT exist. [L: unit + harness]

**AC-REL-3** — `getBackupRelays` MUST return the configured relays and MUST NOT query kind 30051 (recording transport sees no filter with kind 30051). The kind-30051 publish MUST NOT exist anywhere in `app/src`. [L: unit + structural]

## Kind registry (S1)

**AC-KIND-1** — Importing `app/src/lib/marmot/kinds.ts` MUST throw when any two app kinds are equal, when an app kind equals a value in `RUMOR_KINDS`, or when an app kind equals a retired kind (13, 21063). Tested by importing the module with mocked registry inputs for each of the three collisions (each throws with a message naming the kinds) and a clean import not throwing. [L: unit]

**AC-KIND-2** — The registry MUST export: app rumor kinds {0,5,7,9,10,11,12,30}, app inbox kinds {21059 join request, 21060 pairing ack, 21061, 21062, 21064 invite context}, retired {13, 21063}; library-reserved values MUST be taken from `RUMOR_KINDS` (no literal copies: grep for `4460|4461|4462` literals outside the registry test returns none). [L: unit + structural]

**AC-KIND-3** — The invite-context kind MUST equal 21064 and MUST NOT be in 4460–4462 or 21059–21063. [L: unit]

## Startup, wipe and reconciliation (S1)

**AC-WIPE-1** — On `storeIncompatible` the app MUST call `stores.account.wipe({reason:'incompatible'})`, then `clearAllGroupData` (overlay, member profiles, group chat and poll rows, `few-group-history`, join requests, invite links, pending-direct-invite markers — each asserted empty afterward), then reinitialise the client. A second `storeIncompatible` in the same page load MUST NOT wipe again and MUST set state `unsupported`. [L: unit]

**AC-WIPE-2** — At startup, overlay groups absent from `groups.list()` MUST be purged via the same path as AC-MEM-4's purge; groups present in `groups.list()` MUST be untouched. A seeded pre-adoption overlay group MUST be removed after bootstrap. [L: unit + harness]

**AC-WIPE-3** — Wipe MUST never loop: a stub that raises `storeIncompatible` on every client build MUST cause at most one wipe and then `unsupported`. [L: unit]

## Privacy (cross-cutting)

**AC-PRIV-1** — With a recording transport, across create, invite, accept, send, join request and profile exchange, no published unwrapped event has kind 0, and no published event other than kinds 1059/445 contains the sender's nickname or avatar strings (substring scan over every published event's JSON). Events of kinds 30443, 10050 and 30078 MUST contain neither string. [L: harness]

**AC-PRIV-2** — The invite-context rumor (AC-CTX-1) travels only as a kind-1059 gift wrap; the recording transport MUST see no published event of kind 21064 at top level. [L: harness]

## Composition root and context (S7)

**AC-CTXT-1** — `MarmotContext` MUST keep the `useMarmot()` consumer surface minus fields with no consumer: every field name remaining on the returned object MUST have at least one consumer in `app/src` outside the context itself (grep-derived test), and every removed field (including `discoverable`, pairing-digest block, `getPendingRemovals`) MUST have none. [L: unit (structural-behavioral hybrid) ]

**AC-CTXT-2** — `MarmotContext.tsx` MUST contain no protocol logic: it MUST NOT import `@941design/marmot` constructors directly (only through `lib/marmot/client`), and its line count MUST be under 1000. [L: structural]

**AC-CTXT-3** — Re-homing is out of scope: `knownPeersRevision` and the DM/contacts reactivity counters MUST remain exposed by `useMarmot()` with unchanged semantics. [L: unit; e2e:dm-walled-garden-* (kept)]

**AC-CTXT-4** — Walled-garden group-member predicate MUST read membership from the new API (live `group.members()` on the lease tab, overlay elsewhere); `dm-walled-garden-group-member-allowed`, `-retroactive-purge`, `-stranger-blocked` MUST keep their assertions. [L: unit + e2e:dm-walled-garden-* (kept)]

## Deletion and dead-code sweep (S7)

**AC-DEL-3** — The following files MUST NOT exist: `NdkNetworkAdapter.ts`, `welcomeSubscription.ts`, `epochResolver.ts`, `rumorJournal.ts`, `applicationRumorDispatcher.ts`, `keyPackages.ts`, `pendingRemovalStorage.ts`, `leftGroupTombstones.ts`, `staleLocalGroup.ts`, `staleReplaceMarker.ts`, `replaceTeardown.ts`, `membersChangedSync.ts`, `inviteeKeyPackageLookup.ts`; `relayRequest.ts` MUST NOT exist unless it has an importer other than key-package lookup. `grantAdminImpl`, `renameGroupImpl`, `cancelInvitationImpl`, `leaveGroupImpl` identifiers MUST NOT exist as standalone legacy impls (thin calls with app policy only). [L: structural]

**AC-DEL-4** — localStorage keys `lp_processedGiftWraps`, `lp_keyPackageSlot_v1`, `lp_pendingInvitations_v1` MUST NOT appear in `app/src`. The idb stores `few-groups-state`, `few-keypackages`, `few-rumor-journal`, `few-pending-removals`, `few-left-groups` MUST NOT be created by any code (grep over `app/src`). No cleanup code for legacy stores ships. [L: structural]

**AC-DEL-5** — The `groupStorage.ts` state and key-package backends MUST be removed; no module under `app/src` constructs an MLS state or key-package backend. [L: structural]

**AC-DEL-6** — No `__fewTest` hook referring to deleted internals remains; each remaining hook has a consumer in `app/tests/e2e`. The smoke-spec-only hook and `groups-library-smoke.spec.ts` MUST be deleted. [L: structural]

**AC-DEL-7** — Dead code sweep: after the change, `tsc --noEmit` MUST pass and no exported symbol in `app/src/lib/marmot/**` lacks an importer (excluding public entry files), as checked by the repo's unused-export check or a script added to the gate. [L: structural]

## Test rewrite and removal rules (S7, cross-cutting)

**AC-TEST-1** — Only `groups-blackout-guard.spec.ts` and the pending-removal assertions in `groups-admin.spec.ts` MAY be deleted among e2e content. `groups-blackout-guard.spec.ts` MUST NOT exist on the final tree; every other spec file listed in `app/tests/e2e` at the pre-run tag (`pre-marmot-library-adoption`) MUST exist on the final tree except `groups-library-smoke.spec.ts` (temporary, never at the pre-run tag). Checked by diffing file lists against the tag. [L: structural]

**AC-TEST-2** — The 11 specs `groups-leave-intent`, `groups-leave-purges-mls-state`, `groups-rumor-reload-atomic`, `groups-accept-reload-atomic`, `groups-invitation-preview`, `groups-dispatch-isolation`, `groups-seed-phrase`, `groups-seed-recovery`, `groups-backup-restore-outcomes`, `groups-reinvite-after-leave`, `groups-reinvite-after-removal` MUST exist and each MUST differ from its pre-run tag content (rewritten against the new behaviour) and still contain at least one `test(` with an assertion on the behaviour named in its filename. [L: structural]

**AC-TEST-3** — `groups-rumor-reload-atomic` and `groups-accept-reload-atomic` MUST be rewritten to assert: a reload between sink persist and handler dispatch re-dispatches the row after reload so the message/accept outcome appears exactly once (the sink's startup sweep, AC-HIST-7), with no duplicate row. [L: e2e:groups-rumor-reload-atomic, groups-accept-reload-atomic (rewritten)]

**AC-TEST-4** — Every other e2e spec (all not named in AC-TEST-1/2) MUST keep its test titles and assertions; only helpers (`app/tests/e2e/helpers/*`), store names and `__fewTest` hooks MAY change. Verified by diffing test titles per file against the tag: the set of `test(` titles per kept spec MUST be unchanged. [L: structural]

**AC-TEST-5** — Behavioural unit suites (handlers, persistence, polls, profile, join-request, leave eligibility, unread) MUST NOT be deleted: each pre-run unit test file with a behavioural assertion MUST either exist unchanged-in-intent (re-pointed) or be listed in the run report with the justifying decision. The run report MUST list every deleted test file with the decision (D#) that justifies it. [L: structural (report check) ]

**AC-TEST-6** — Source-scan unit tests coupled to deleted internals MUST be rewritten or deleted with justification; no unit test MUST import a deleted module (`tsc` and vitest collection pass). [L: unit run]

**AC-TEST-7** — e2e `groups-library-smoke.spec.ts` (temporary): creates a group, sends a message and observes its own echo via the sink through a dev-only `__fewTest` hook; exercises A1 (an `append` that throws once is retried and eventually dispatched), A2 (`withdraw` called with kind-445 ids after a rewind), A3 (own message delivered after confirmation). It MUST pass in S1; it MUST be deleted in the last story. [L: e2e:groups-library-smoke]

**AC-GATE-1** — Story S1 ends with `make build` exit 0 and the smoke spec green; failure aborts the run with the old flow intact. [L: structural (build) + e2e:groups-library-smoke]

**AC-GATE-2** — The cut-over story ends with the checkpoint subset run; the subset result is reported as a dev aid and MUST NOT be reported as a pass. [L: structural (run report)]

**AC-GATE-3** — The end gate: `make build` and `make test` (unit + `make test-e2e-all` over the full suite) MUST exit 0 on the final tree, with e2e not INVALID. [L: structural (gate)]

**AC-GATE-6** — Production-bundle runtime proof: the e2e suite runs on `next dev`, and S1 showed the production build tree-shakes unreferenced library code, so the minified export is otherwise never executed. On the final tree, `make build` output (`app/out`) served statically MUST complete, in a real browser against the e2e relay, a two-account round trip: create group → invite → accept → message delivered both ways. [L: e2e (one-off scripted run against `app/out`, recorded in the run report)]

**AC-GATE-4** — The pre-run commit MUST be tagged `pre-marmot-library-adoption` (`git rev-parse pre-marmot-library-adoption` resolves) before the first story's changes; on an unmet end gate after the remediation budget the run reverts nothing. [L: structural]

**AC-GATE-5** — Coexistence of old and new code is allowed only between stories: on the final tree, AC-DEL-1/3/4/5 hold and no feature flag or adapter layer between old and new implementations exists (grep for the old names returns none). [L: structural]

## Mutation gate (S2–S5)

**AC-MUT-1** — Stryker (concurrency 1, scratch config, `app/reports` untouched) MUST be run on the new pure modules: history backend, send helper, signer adapter, key-package lookup, leave eligibility, kind registry, invite-context handler; surviving non-equivalent mutants MUST be closed by tests or recorded in the run report. Bootstrap wiring, React context and deleted modules MUST NOT be audited. [L: structural (run report) ]

## Documentation (S7)

**AC-DOC-1** — `docs/behavior/groups.md`, `profiles-and-identity.md`, `backup-and-recovery.md`, `notifications-and-unread.md` and (where the inbox split shows) `contacts-and-direct-messages.md` MUST be updated: `backup-and-recovery.md` states groups are not restored by recovery (D5); `groups.md` states single-tab-per-account (D4), leave semantics (D9), withdrawal (D6); the `docs/behavior/README.md` index stays in sync. Grep checks: `backup-and-recovery.md` no longer claims group restore; `groups.md` contains the "another tab" behaviour. [L: structural (doc grep)]

**AC-DOC-2** — A new ADR under `docs/adr/` MUST supersede ADR-012's fork mechanism while keeping its handler rule (group handlers take the sender only from the authenticated account, never `rumor.pubkey`; inbox handlers use the seal-bound `rumor.pubkey`), reaffirm ADR-003 for app-level rev-clock mutations and supersede only its marmot-ts-specific claims, and record the own-change-lost policy; ADR-012 and ADR-003 headers MUST reference the new ADR. [L: structural (doc grep)]

**AC-DOC-3** — CLAUDE.md e2e test counts (60 / 12 / 48 and the dm-* breakdown) MUST equal the counts printed by `playwright test --list` per bucket on the final tree. [L: structural (script compares)]

**AC-DOC-4** — Behaviour changes to a topic not covered by any behaviour document MUST be listed in the run report rather than authored mid-feature. [L: structural (report)]

## Cross-Cutting Invariants

**AC-OBS-1** — Inbound delivery convergence (property): for every sequence over a generator of {`append(e)`, redelivered `append(e)` (0–5 times), `append` that throws on attempt k then succeeds, crash-and-restart (reload of the sink from idb followed by the startup sweep) at any point, `withdraw(e)` for appended or never-appended e} over a finite set of kind-445 entries, the final app-store state MUST equal the state of the canonical run in which each non-withdrawn entry was dispatched exactly once in `seq` order and each withdrawn entry left no trace; `list` MUST always be `seq`-ordered. Assertion fails on any duplicate row, missing row, trace of a withdrawn entry, or order violation (fast-check, ≥200 runs, seeded for replay). A `withdraw` that precedes its `append` MUST be a no-op on the withdrawn id. [L: unit (property)]
Spans modules: history, handlers

**AC-OBS-2** — Own-send lifecycle (property): for every interleaving over a generator of {echo arrival, `send()` resolve, `send()` reject, `intentFailed`, `groupBranchSwitched`, 60 s timer expiry, re-echo} applied to one optimistic own row, the final state MUST satisfy: (i) exactly one row with that `rumor.id`; (ii) if an echo occurred at any point and no `withdraw` of it followed, status is confirmed and never downgraded by a later trigger; (iii) if no echo occurred and any failure trigger occurred, status is failed/retry; (iv) no auto-resend (send spy count ≤ 1). Assertion fails on any violated clause. [L: unit (property, fake timers)]
Spans modules: send, history

**AC-OBS-3** — Invitation flow (property): for every ordering over a generator of {invitation arrival (`inboxDisposition: pending`), invite-context arrival from sponsor, invite-context arrival from non-sponsor, context redelivery, accept, decline, expiry, restart} the resulting card label MUST be the context name if and only if a sponsor-sent context exists and the invitation is pending; the held-context sets MUST obey the 8/64 caps; no context survives accept/decline/expiry; and for an outbound join request matching the invitation, `accept` is called at most once. Assertion fails on any violated clause. [L: unit (property)]
Spans modules: invitations, joinRequests

**AC-OBS-4** — Decline durability (property): for every interleaving over a generator of {`welcomeDeclined` fires, group `synced()` resolves, `removeMember` rejects n times, process restart (marker reloaded from idb), sponsor offline for k startups}, the invitee is eventually removed (`removeMember` resolves for it) once the sponsor is online and synced, the `declined` announcement is sent exactly once and only after that resolution, and the marker is cleared only after it. Assertion fails if a decline is lost, the announcement precedes removal, or the marker clears early. [L: unit (property over a fake client)]
Spans modules: invitations, membership

**AC-OBS-5** — Lifecycle / lease (property): for every interleaving over a generator of {lease acquired, lease held by other tab, lease released, `storeIncompatible` (0–3 times), sign-out, signer change, relay-settings save} the app MUST (i) issue no `group.*` write and run no membership-derived sweep at any instant at which the lease is not held by this tab, (ii) perform at most one wipe per page load and never loop, (iii) end with a disposed-then-closed client after teardown. Assertion fails on any violation of (i)–(iii). [L: unit (property over fake lease + fake client)]
Spans modules: client, membership

**AC-OBS-6** — Privacy across flows (property): for every sequence over a generator of {create, invite, accept, decline, send chat/reaction/poll/image, join request, profile exchange, relay-settings save, backup publish} with random nicknames and avatar strings, the multiset of all published events satisfies: none of kind 0; none other than kinds 1059/445 contains a nickname or avatar string (kind 30078 excluded only because its payload is NIP-44 ciphertext, asserted by ciphertext shape). Assertion fails on any leaking event. [L: harness (property)]
Spans modules: client, invitations, joinRequests, send, backup

**AC-OBS-7** — Sender-binding (property): for every group message produced by a generator of {genuine rumor, rumor with forged `pubkey`, rumor re-sent by a different member} sent by real library clients over the harness, the set of rows rendered in the chat store equals exactly the genuine rumors attributed to their MLS sender. Assertion fails on any rendered forged or misattributed row. [L: harness (property)]
Spans modules: history, handlers, send

## Manual Validation

No rows are claimed. All ACs above are automated (unit, library harness, or e2e) or genuinely structural; the Deferred Human Review items in the spec are owner confirmations of product decisions, not behaviours that only a human can observe.

| MV id | Behavioral intent | Gap evidence | Owner | Blocked on | Adjudicated |
|-------|-------------------|--------------|-------|------------|-------------|

## Coverage Map (Design Decisions / Constraints / Assumptions)

- D1 → AC-TRANS-1. D2 → AC-SIGN-1..5. D3 → AC-CTX-1..5, AC-PRIV-2, AC-OBS-3. D4 → AC-MT-1..5, AC-OBS-5. D5 → AC-BKP-1..5, AC-TEST-2/3. D6 → AC-WDR-1..6, AC-OBS-1/2. D7 → AC-JOIN-1, AC-INBOX-1/2, AC-DECL-1/2, AC-OBS-4. D8 → AC-AUTO-1/2, AC-JOIN-2..5. D9 → AC-LEAVE-1..6, AC-OBS-4/5. D10 → AC-KP-1..3. D11 → AC-MUT-1. D12 → AC-KIND-1..3. D13 → AC-OWN-1..3, AC-HIST-10/11. D14 → AC-BLK-1, AC-CAP-1, AC-INV-4. D15 → AC-GATE-1..5, AC-TEST-7. D16 → AC-DOC-2, AC-MEM-3 (own-change-lost). D17 → AC-REL-1..3.
- Constraints: privacy → AC-PRIV-1/2, AC-OBS-6; `update()` ban → AC-HIST-8; static export/client-only → AC-BOOT-7; i18n → AC-SIGN-2, AC-MT-1 (en+de keys), AC-LEAVE-3.
- Assumptions A1–A3 → AC-TEST-7, AC-HIST-3/4, AC-WDR-5, AC-OWN-1.
- Success signal → AC-DEL-1, AC-GATE-3, AC-DOC-3.
