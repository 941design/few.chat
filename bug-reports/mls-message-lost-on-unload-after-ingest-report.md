# MLS application message lost if the page unloads between ingest and handler processing

Source: BACKLOG.json finding `mls-message-lost-on-unload-after-ingest` (filed 2026-10-15 from the
in-page-instrumented diagnosis in bug-reports/profile-propagation-flake-diagnosis.md).

## Verified mechanism (Fable, installed marmot-ts dist)

marmot-group.js live path: processMessage → state set (dirty, no IDB) → `yield {kind:'processed'}` (:1291)
→ emit applicationMessage/authenticatedApplicationMessage (:1298-1299) → loop end → `await this.save()`
(:1587) → store.setItem. Past-epoch path identical (yield :1072, emit :1079-1080, save :1130).
The app consumes the generator with `for await` in app/src/lib/marmot/epochResolver.ts (:185, :299, :328);
the generator is suspended at the yield until the loop body finishes. The dispatcher
(app/src/lib/marmot/applicationRumorDispatcher.ts) receives the emit synchronously but runs handlers
asynchronously on its `tail` queue (multi-roundtrip IDB), so they nearly always lose the race against
the single-put state save. An unload in that window loses the rumor forever (ratchet advanced).

## Adopted design (write-ahead rumor journal, app-side, no library change)

- New app/src/lib/marmot/rumorJournal.ts: idb-keyval store `few-rumor-journal`, key `${groupId}:${rumorId}`,
  value {groupId, rumorId, senderPubkey, data: the bytes the dispatcher receives, receivedAt};
  put (idempotent), ack (delete), listPending(groupId), sweep (age / per-group cap).
- epochResolver: `onApplicationMessage?: (msg) => Promise<void>` AWAITED in all three loops; on put
  failure warn and continue (never throw — that would skip save). welcomeSubscription wires it to
  journal.put. Guarantee by JS ordering: journal put resolves ⇒ generator resumes ⇒ emit ⇒ save.
  Reverse cut (journal written, state not saved) is harmless (redelivery re-decrypts; put idempotent).
- Dispatcher: optional `journal.ack(groupId, id)` at the end of the queued block regardless of handler
  errors; `replay(entries)` on the subscription feeding each entry through the same listener (choke
  point, LRU, handlers). MarmotContext: after dispatcher `.subscribe(...)` and before
  subscribeToGroupMessages, `await listPending(groupId)` → replay (FIFO `tail` ⇒ replayed run first;
  drain() covers them; LRU swallows the live duplicate).
- Journal is NOT exported in relay backups (transient, per-device). Privacy invariant unaffected
  (local only; no new publishes).
- Add a guard comment + unit test at the yield consumer (any future ingest consumer must keep the
  await, or the guarantee is lost).

## Expected
Reload immediately after a peer's send never loses the rumor.
