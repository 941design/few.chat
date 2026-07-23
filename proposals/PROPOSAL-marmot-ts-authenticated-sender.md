# Proposal: surface the authenticated sender leaf for MLS application messages (implements `group-messaging.md:43`)

**To:** maintainers of `@internet-privacy/marmot-ts`
(`github.com/marmot-protocol/marmot-ts`) and `ts-mls`.
**From:** the few.chat application team. We build an MLS/Marmot group-chat PWA on
top of marmot-ts and maintain a controlled fork; we will carry this change there
regardless, but it is spec-conformance and belongs upstream.
**Status:** request for agreement + reference implementation offer.
**Verified against:** `@internet-privacy/marmot-ts@0.5.1`, `ts-mls` v2.

> **Framing:** this is **not a feature request** — it asks the library to expose
> the value the **Marmot spec's own receiver check already requires**. Today that
> check is unimplementable by any consumer, so every marmot-ts app is open to
> member-on-member impersonation. Every file:line below is verified against the
> 0.5.1 dist.

---

## 1. The gap

The Marmot spec requires receivers to bind an application message's claimed
author to its MLS-authenticated sender:

> `group-messaging.md:43` — *receivers validate the inner app event pubkey
> matches the MLS-authenticated identity.*

A consumer cannot perform this check, because the authenticated sender is
resolved during decryption and then **discarded**:

```ts
// ts-mls/dist/src/processMessages.d.ts:14-19 — application-message result
| { kind: "applicationMessage";
    message: Uint8Array;
    newState: ClientState;
    consumed: Uint8Array[];
    aad: Uint8Array; }        // <-- no sender
```

```js
// marmot-ts/dist/client/group/marmot-group.js:840
this.emit("applicationMessage", result.message);   // bytes only
```

**Consequence:** any legitimate group member can set the inner rumor's `pubkey`
to another member's key and impersonate them (chat, reactions, edits/deletes,
and system messages such as a forged "leave"). MLS still bars non-members; the
exposure is member-on-member, exactly the case `group-messaging.md:43` exists to
prevent.

## 2. The value is already computed — for proposals, not application messages

ts-mls resolves the sender leaf inside `unprotectPrivateMessage` and already
returns it for the proposal path:

```js
// ts-mls/dist/src/processMessages.js
import { getSenderLeafNodeIndex, senderTypes } from "./sender.js";   // :14 (already imported)
// proposal return:
senderLeafIndex: getSenderLeafNodeIndex(result.content.content.sender),   // :91
```

The two **application-message** returns omit it:

```js
// :48  (historical-epoch branch — decrypts against receiverData.ratchetTree)
{ kind: "applicationMessage", message: ..., ... }        // no senderLeafIndex
// :67  (current-epoch branch)
{ kind: "applicationMessage", message: ..., ... }        // no senderLeafIndex
```

## 3. Ask #1 (ts-mls) — add the sender to the application-message result

Add `senderLeafIndex` (or the resolved credential) to **both** application-message
return sites, mirroring `:91`. `result.content.content.sender` is already in scope
at each.

> **Correctness requirement — resolve against the epoch-correct tree.** The
> historical-epoch branch (`:38`) decrypts against `receiverData.ratchetTree`, not
> `state.ratchetTree`. Leaf indices are reused after member removals, so a
> late-arriving old-epoch message resolved against the *current* tree misattributes
> to whoever now holds that leaf. The sender must be resolved (or the index
> returned with its epoch) inside the unprotect path where the correct tree is in
> scope — **not** at marmot-ts's emit site against `this.state.ratchetTree`.

## 4. Ask #2 (marmot-ts) — resolve to a pubkey, enforce the check, surface it

marmot-ts already ships the leaf→pubkey resolution and uses it for commits:

```js
// marmot-group.js:45-53 (commit path)
const senderCredential = getCredentialFromLeafIndex(ratchetTree, senderLeafIndex);
const senderPubkey     = getCredentialPubkey(senderCredential);
```

Apply the same and:

1. **Enforce `rumor.pubkey === senderPubkey`** (the `group-messaging.md:43`
   check) **immediately after decryption, before any of save / yield / emit**.
   At `marmot-group.js:828-841` the current order is
   `history.saveMessage(result.message)` → `yield { ..., result, ... }` →
   `this.emit("applicationMessage", ...)`. Gating only the emit is insufficient:
   a forged rumor would still be persisted to the history store and delivered to
   consumers of `ingest()`'s yielded results. The check must run once, up front,
   and on mismatch **drop** (no save, no yield, no emit) and emit a diagnostic
   event (e.g. `unauthenticatedMessage`). Note the check must
   `deserializeApplicationData` to read `pubkey`; define behaviour for bytes that
   fail to deserialize (today the app dispatcher discards them silently —
   `applicationRumorDispatcher.ts:86-89`; relocating the check relocates that
   decision).
2. **Surface the authenticated sender** to consumers:

```ts
// today  (marmot-group.d.ts:149)
applicationMessage: (message: Uint8Array) => void;

// proposed
export interface AuthenticatedApplicationMessage {
  message: Uint8Array;      // decrypted rumor bytes, unchanged
  senderPubkey: string;     // Nostr hex, from the authenticated leaf credential
  senderLeafIndex: number;
}
applicationMessage: (msg: AuthenticatedApplicationMessage) => void;
```

### Compatibility

The payload change is breaking. Either land it as a **major** (the Few app is
prepared to migrate), or add it as a **new event**
(`authenticatedApplicationMessage`) beside the existing one so current consumers
are untouched and opt in. Either is fine by us; the additive event is friendlier
to the ecosystem. Note that a consumer *cannot* opt out of correctness here and
stay spec-compliant — the check is normative — so a major bump is defensible.

## 5. What stays with the consumer

Only the enforcement/UX policy the spec does not dictate — whether to log or
surface a dropped message, and any application-payload conventions layered on top
(few.chat carries signed, forwardable system-message envelopes *inside* the rumor
`content`, which needs no library involvement and preserves the unsigned-rumor
requirement). The library's responsibility ends at *"here is the authenticated
sender; a mismatched message was dropped."*

## 6. Why this is the strongest kind of upstream change

It **implements the spec's own required receiver check** rather than adding
anything new, reuses code marmot-ts already ships for commits, and preserves the
unsigned-rumor rule verbatim (no wire-format change). It converts marmot-ts from
"impersonation is possible for every consumer" to "impersonation is prevented for
every consumer," and it lets forks like ours delete their delta once merged.

## 7. Appendix — reproduction

In a group with Alice and Mallory, have Mallory serialize a rumor
`{ kind: 9, pubkey: <Alice hex>, created_at, tags: [], content: "…", id: getEventHash(...) }`
and send it as a normal application message. Every client deserializes it, reads
`rumor.pubkey`, and displays it as Alice's. With Asks #1–#2, ts-mls returns
Mallory's leaf, marmot-ts sees `pubkey (Alice) !== senderPubkey (Mallory)`, drops
it, and emits a diagnostic.
