Project review — few-chat / quizzl

Reviewed 2026-09-26 at commit `9eef568`, including the current working tree. No production code or existing user changes were modified. Temporary regression probes were removed from the repository and retained in `regression-probes.test.ts.txt`.

The highest-priority issues are offline group-message loss and inconsistent account/signer lifecycle handling. The successful unit suite and production build do not cover these integration boundaries adequately.

1. **[P1] Historical group messages are ingested before their application handlers exist.**

   Location: [MarmotContext.tsx:1589](../../../app/src/context/MarmotContext.tsx), with dispatcher attachment at [line 1827](../../../app/src/context/MarmotContext.tsx).

   `subscribeNewGroups()` awaits `subscribeToGroupMessages()` before installing `buildDispatcher(...).subscribe(...)`. The awaited function fetches and ingests historical events before returning (`welcomeSubscription.ts:1253`). During ingestion, the installed marmot-ts library emits `authenticatedApplicationMessage` synchronously; no application dispatcher is listening yet. The resolver receives no alternative `onApplicationMessage` callback here, and no library history factory is configured.

   Trigger: another member sends messages while this browser is closed; reopen the app. Those events can be decrypted and marked processed without ever reaching chat persistence, poll handlers, profile handlers, or edit/delete reconciliation. The shared processed-ID set also suppresses their live replay in the same session. Install the dispatcher before starting historical ingestion and tear both subscriptions down together.

   Evidence: traced the production call order and installed library emitter implementation. Not reproduced against a live relay because the relay suite could not start.

2. **[P1] External signer activation leaves the app using the local identity.**

   Location: [NostrIdentityContext.tsx:364](../../../app/src/context/NostrIdentityContext.tsx), and the analogous NIP-46 activation at line 313.

   Both activation functions install a signer but never update the identity used by the context. Connecting an extension/bunker for public key B while the app has auto-generated A therefore leaves displayed npub, recipient subscriptions, and constructed rumor authors on A while the external signer operates as B. A warning does not reconcile these identities.

   The same-key NIP-46 case fails on reload too: activation deletes `nostrIdentity` (line 342), startup then generates a new local identity before reconnecting the persisted remote session (lines 195–206), and the restored remote public key is not adopted. Persist a public external identity independently from local key material, resolve it before exposing a hydrated signing session, and route private operations through the selected signer.

   Evidence: production lifecycle trace; live extension/bunker integration was not exercised.

3. **[P1] Restoring a different identity retains the previous account's private state.**

   Location: [NostrIdentityContext.tsx:408](../../../app/src/context/NostrIdentityContext.tsx).

   `replaceIdentity()` changes keys and the NDK signer without switching the storage namespace or unloading account state. Group metadata/MLS state, DM histories, contacts, and trust data are stored under account-independent keys. Settings calls this function during phrase restoration on an already-used browser. The new Marmot client then loads the old group store.

   This also reaches backup: `collectBackupPayload()` enumerates every stored group and MLS state, while `BackupProvider` encrypts that payload to the newly active identity. A subsequent backup can transfer A's group secrets/history into B's backup. Preserve data for same-account recovery, but isolate different accounts and switch their subscriptions and stores atomically.

   Evidence: traced settings restore → identity replacement → global IDB stores → backup collection/encryption. This is a cross-account case, distinct from the documented non-destructive same-account restore behavior.

4. **[P1] Normal connection setup overwrites an external NDK signer with the local key.**

   Location: [MarmotContext.tsx:1196](../../../app/src/context/MarmotContext.tsx), [ndkClient.ts:142](../../../app/src/lib/ndkClient.ts).

   Activation calls `applyNdkSigner()`, which clears the remembered local key. The signer-mode change then reinitializes Marmot and calls `connectNdk(privateKeyHex)`. That calls `getNdk(key)` and unconditionally replaces the external signer with `NDKPrivateKeySigner`. Ordinary contact-chat connections do the same. Additionally, the DM send path at `ContactChat.tsx:881–892` constructs and wraps messages directly with the local private key, bypassing the external signer entirely.

   Separate connection establishment from explicit signer selection, and make all signing/encryption paths consume the active signer. Otherwise selecting an external signer does not reliably determine which identity sends messages or which operations require external approval.

   Evidence: a focused check installed signer B, followed the local-key rebinding path, and observed signer A replace it. The probe used two deterministic local signer objects to test the exact override/rebinding mechanism without an external service.

5. **[P2] Application dispatch is not serialized across messages.**

   Location: [applicationRumorDispatcher.ts:137](../../../app/src/lib/marmot/applicationRumorDispatcher.ts).

   Awaiting each handler only sequences handlers for one rumor. EventEmitter does not await the async listener before delivering the next rumor. A poll-open handler can be awaiting IDB while the following vote checks for the poll, finds nothing, and permanently drops the vote. The event is already in the dedup set. Similar read-before-write dependencies affect announcements and profile processing.

   Evidence: with the real poll handlers and fake IndexedDB, synchronously emitting poll-open followed by its vote stored zero votes. Add a per-group dispatch queue and ensure history synchronization can await its completion. Out-of-order transport dependencies also need explicit retention where appropriate.

6. **[P2] Poll vote storage is shared across groups.**

   Location: [pollPersistence.ts:104](../../../app/src/lib/marmot/pollPersistence.ts), with key construction at line 54.

   Polls are keyed by group, but votes use only `pollId`, and vote IDs contain only poll ID and voter. Incoming poll IDs are sender-controlled; they need not be unique UUIDs. Two polls with the same ID in different groups therefore share votes, and clearing one group's polls deletes the other poll's votes too. A deliberately reused ID can corrupt a receiver's tally across group boundaries.

   Evidence: created same-ID polls in two groups, submitted a vote through one group's real handler, and the other group's tally counted it. Include group ID in vote keys, APIs, and clearing operations, with a migration for existing rows.

7. **[P2] Older votes overwrite newer choices.**

   Location: [pollPersistence.ts:110](../../../app/src/lib/marmot/pollPersistence.ts).

   `saveVote()` replaces the row for a voter without comparing `votedAt`. That makes the result depend on arrival order rather than the signed event timestamp. Delayed events from another relay or history replay can undo a newer selection, and different clients can retain different results.

   Evidence: delivered choice B at timestamp 200, then choice A at timestamp 100 through the real vote handler; persisted choice became A. Compare revisions and use a deterministic tie-break for equal timestamps.

8. **[P2] Concurrent profile merges lose members' profile records.**

   Location: [groupStorage.ts:84](../../../app/src/lib/marmot/groupStorage.ts).

   `mergeMemberProfile()` performs a separate read and write of the whole group profile array. Concurrent arrivals can both read the same snapshot and overwrite each other's additions. Both callers report success, even though one profile disappears. The dispatcher currently permits this concurrency, and multiple tabs remain a concern even after dispatch is serialized.

   Evidence: `Promise.all()` of Alice and Bob merges into an empty group left only Bob in fake IndexedDB. Use an atomic IDB update/transaction; apply the same discipline to profile deletion and any other mutations of that array.

9. **[P2] Saved relay preferences are ignored when NDK is created.**

   Location: [ndkClient.ts:28](../../../app/src/lib/ndkClient.ts).

   The singleton always starts with `DEFAULT_RELAYS`, although settings persists a custom list and updates the pool only during an interactive edit. Reloading can therefore reconnect to relays the user removed; implicit NDK subscriptions/publications follow the wrong pool. Some group paths use explicit effective relay sets, so the resulting behavior is inconsistent across features.

   Evidence: with a custom persisted relay list, a fresh real NDK instance still contained `relay.damus.io` and `nos.lol`. Initialize the pool from `getEffectiveRelays()` and test actual connection configuration across reloads.

10. **[P2] The definitive E2E gate currently fails on an ambiguous locator.**

    Location: [update-detection.spec.ts:84](../../../app/tests/e2e/update-detection.spec.ts).

    `expect(page.locator('nav')).toBeVisible()` matches both desktop and mobile navigation elements, causing Playwright's strict-mode error. The inspected page snapshot showed the update banner and main navigation; this failure does not establish that the banner blocks interaction. Use the named main-navigation locator and actually exercise a navigation action for the stated behavior.

    Evidence: `make test-e2e-all` completed the non-relay bucket with 70 passes and this one failure, then stopped before the relay bucket.

Verification performed:

- `make test-unit`: **224 test files passed; 4,405 tests passed, one skipped** before adding temporary probes.
- `make build`: **passed**, including type checking and static export of 12 pages. Shared first-load JS was approximately 613 kB.
- Six temporary regression checks: **all six exposed the intended incorrect behavior** after correcting a test-double setup error. Existing 224 unit files still passed alongside them. These are reproductions of findings 4–9, not new production tests left behind.
- `make test-e2e-all`: **70 passed, one failed** in the non-relay bucket. The relay bucket did not run through this aggregate target.
- Separate `make test-e2e`: **blocked before browser tests** because Docker could not bind host port 3001. The existing listener was not terminated or replaced. Test fixtures started by the review were stopped afterward.
- Working-tree status after cleanup matched the initial status. User-owned untracked files, including the pending-invitation regression test, were preserved.

Evidence files:

- [Baseline unit output](unit.log)
- [Build output](build.log)
- [Focused regression probes](regression-probes.test.ts.txt)
- [Focused regression results](probes.log)
- [Browser test output](e2e.log)
- [Relay test startup output](relay-e2e.log)

Scope and practical limits:

The review concentrated on identity and signer lifecycle, group ingestion/authentication, persistence, polls, direct messages, backup/recovery, media/network boundaries, and build/test configuration. It also inspected the Cloudflare asset handler and rendering-related utilities. It was not a formal cryptographic audit or an exhaustive review of every asset and specification. Live relay behavior, real remote signers, and deployed infrastructure remain unverified in this run.

The code has substantial positive coverage around authenticated sender binding and protocol parsing. The main gap is integration behavior: async initialization, lifecycle transitions, real EventEmitter scheduling, and real IDB read/write semantics. For example, existing dispatcher helpers often await listeners, while the installed library's EventEmitter does not; several storage tests use Map-backed mocks that do not reproduce IndexedDB's structured cloning. At least 28 unit files also use `readFileSync`, so the raw test count should not be treated as equivalent to runtime behavioral coverage. Prioritize regressions at these boundaries, beginning with offline-history delivery and account/signer transitions.
