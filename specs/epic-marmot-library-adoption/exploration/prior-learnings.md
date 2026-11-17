### marmot-group-sync-live-subscription-opens
In @941design/marmot a group's live kind-445 subscription is opened only AFTER its initial history walk (requestWithDeadline per relay, historyTimeoutMs). A relay that never sends EOSE delays that by historySilenceThreshold consecutive passes before it is excluded, so with one dead relay in a fixed relay list the first live delivery can take seconds (tests: set options.historySilenceThreshold: 1 and a small historyTimeoutMs). A group loaded from storage refuses group.invite with MarmotError code commit-pending until its first post-load sync, so an orchestrator must await group.synced() (without blocking its poll loop) before the first invite. The group's sync subscription stays open until client.dispose(); there is no per-group unload, so a relay-subscription-count check must baseline after groups are loaded. Test fakes must route request() per single relay: requestWithDeadline calls network.subscription([url]) and network.request([url]) once per relay and uses a real setTimeout for the deadline.

### marmot-lib-disposed-client-throws-synchronously
After client.dispose(), calls such as client.groups.list() throw a MarmotError('disposed') synchronously (not a rejected promise) and group.id getters throw too, so capture group ids before teardown and assert with expect(() => ...).toThrow. To test the storeIncompatible/envelope-mismatch wipe path, write state with createMemoryStorage({persistence, codecVersions:{engine:'other',tsMls:'x'}}), close, then reopen over the same persistence with default versions: client.groups.list() reports it; recover with stores.account.wipe({reason:'incompatible'}) on the same WritableStores handle (lease retained) and rebuild the client. Memory kits sharing one persistence contend for the lease like tabs (lease-held); pass leaseTimeoutMs to createMemoryStorage to keep negative tests fast.

### marmot-inbox-handler-follow-up-work
On Node (AsyncLocalStorage available) @941design/marmot runs registerInboxHandler/onApplicationRumor handlers inside a surface frame that stays live until the handler promise settles. A microtask scheduled from inside the handler runs BEFORE the frame is marked dead and inherits it, so an account-scope client call made synchronously from that continuation rejects with MarmotError 'reentrant'. setTimeout(0) runs after the frame is dead. Pattern: the inbox handler only records state and pushes a task onto an adapter-owned FIFO drained by setTimeout(0); all callbacks into app code and client calls happen there. Verified: a test calling client.keyPackages.count() synchronously from the app callback passes with setTimeout and fails with queueMicrotask. In browsers (no AsyncLocalStorage) only the synchronous part is detected.

### testing-marmot-inbox-redelivery-pool-dedups
Re-emitting an identical gift wrap via FakeRelay.publish() never reaches an inbox handler a second time: the SimplePool transport dedups by event id before the lib sees it. To exercise at-least-once redelivery, construct the client with options.seenSetCap:1 (the lib forgets a wrap once the next one is seen) and call client.inbox.stop() then start(): the backfill replays stored wraps and the handler runs again (inboxDisposition kind 'delivered' appears twice for that wrapId). Also: FakeRelay publishOk is read per publish from its options closure, so a late-bound script can refuse/drop selected publishes; OK messages 'blocked:'/'invalid:'/'restricted:'/'pow:' classify as terminal (sendInboxRumor status 'failed', welcome 'failed'), anything else (e.g. 'error: busy') as 'retryable'. sendInboxRumor also needs rumor.id = getEventHash(rumor) and rumor.pubkey = own pubkey.

### marmot-welcome-processed-after-expectwelcome
A Welcome whose manifest deadline has passed on the client clock (options.clock) is not auto-accepted: it appears in client.invitations.pending() with sponsorAccount and groupId, and client.invitations.accept(id) returns the MarmotGroup. Adapters that want late Welcomes must therefore check pending() (on inboxDisposition kind 'pending' and after registering the manifest) and accept only entries whose sponsorAccount and groupId match what they expect; a Welcome from a different sponsor for the same groupId (e.g. a promoted admin inviting the key package) stays pending. The deadline is evaluated on the injected clock, so tests can advance it past the deadline without waiting.

### 941design-marmot-new-mls-member-cannot
A member added via Welcome cannot decrypt application messages from earlier epochs, so history replay does not deliver the running question to a late joiner. In nht the host includes the running question in join_approval.activeQuestion (sent after admit resolves, in the joiner's epoch).

### 941design-marmot-inbox-handlers-must-not
Lib inbox handlers run inside a re-entrancy frame; on Node, microtasks inherit it, so calling client methods (admit/invite) from a handler or a queued microtask fails. Record in the handler, then dispatch app callbacks from an adapter-owned setTimeout(0) FIFO.

### 941design-marmot-0-2-0-alpha
- `createRawWebSocketNetwork(...).asTransportContract()` from @941design/nostr-events has no close API: track the sockets yourself (wrap the WebSocket impl) and close them on final release.
- `keyPackageRefOf` is async (returns a Promise).
- A Welcome that arrives before `expectWelcome` is auto-accepted, but still check `invitations.pending()` after registering.
- `group.invite(kps[])` makes one commit per batch, so serialize to one in-flight invite per group.
- `createIndexedDbStorage` takes a per-account Web Locks lease, so a second tab gets lease-held.
- For in-process tests, use `FakeRelay` from `@941design/nostr-events/transport/contract/conformance` with `// @vitest-environment node` and `createMemoryStorage()`.
- `inbox.start()` tears down on a failed first pass and can be restarted.

### nostr-tools-nip59-unwrapevent-does-not
nostr-tools 2.x `nip59.unwrapEvent(wrap, sk)` verifies the seal signature and that rumor.pubkey === seal.pubkey, but it never recomputes or checks `rumor.id`. The sender controls that id entirely, and it can contain ':' or other characters.

Consequences seen in nosti:
- **Key shadowing:** dedup or hold maps keyed by rumor id alone let one account shadow another's vote. Key them by `${pubkey}:${id}` instead.
- **Receipt-address injection:** building a signed replaceable event's d-tag by string-parsing a key that contains the rumor id let an attacker inject text into the address. Carry the fields explicitly instead.
- **Guard:** require /^[0-9a-f]{64}$/ before using a rumor id in any output.

### linux-webkit-playwright-x25519-generatekey-returns
On Playwright's Linux WebKit 18.5, crypto.subtle.generateKey({name:'X25519'}) returns a key pair whose public key does not belong to the private key: the exported jwk.x differs from the raw export, and ECDH is asymmetric between two generated pairs. Imported pkcs8 keys, SHA, HMAC, HKDF, AES-GCM and Ed25519 match Chromium. Effect: MLS libraries using @hpke/core with native WebCrypto X25519 (e.g. ts-mls) fail Welcome decryption on that engine with an AES-GCM OperationError. Diagnose by comparing jwk.x with exportKey('raw'), or by deriving both directions of ECDH. Real Safari is unverified. Probe with page.route to an https origin, because crypto.subtle is undefined on about:blank.

