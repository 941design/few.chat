# Feature Spec: Group Invite Links

> **Superseded in part (2026-10-15):** the mute/unmute material (Key Decision 4, `InviteLink.muted`, Flow 4, `muteInviteLink`, "No expiry in v1", implementation step 7) describes the original v1 design and is no longer current. Shipped behaviour (see `specs/epic-invite-link-lifecycle/`, status done): links expire automatically ~24 h after creation (`expiresAt = createdAt + DAY_MS`, `isExpired` in `app/src/lib/marmot/inviteLinkStorage.ts`) and the only admin action in `ManageInviteLinksModal` is a terminal, confirmed hard delete (`deleteInviteLink`). `joinRequestHandler` silently drops requests for unknown, expired, and legacy-muted nonces. There is no UI to mute or unmute.

## Goal

Let group admins share a URL that anyone can open to request membership in a group — without needing to exchange npubs manually. Links contain a nonce so admins can delete individual links at any time (links also expire automatically after ~24 h).

## Background

Today, inviting someone requires the admin to enter the invitee's npub (typed or QR-scanned). This works but has high friction: the invitee must first share their npub out-of-band, and both parties must be available at the same time. An invite link lets the admin share a single URL (via messenger, email, printed QR code, etc.) that the invitee opens at their convenience. Because MLS requires the inviter to actively create a Welcome from the invitee's KeyPackage, the link cannot bypass the MLS ceremony — it triggers a **join request** that the admin then approves.

## Key Decisions

### 1. Link contains a nonce, not a group secret

The invite link encodes a random nonce, the admin's npub, and the group name (for display). The nonce is not a password or cryptographic credential — it is an opaque identifier the admin uses to track and revoke individual links. No group keys or MLS state are exposed in the URL.

### 2. Join requests are NIP-59 gift-wrapped DMs

When the invitee opens a link, their app sends a **gift-wrapped direct message** (kind 1059 wrapping an inner rumor) to the admin's pubkey. The inner event contains a structured JSON payload identifying the group and the nonce. This reuses the existing NIP-59 two-layer encryption already used for MLS Welcomes, adding no new wire protocol.

### 3. No auto-approve

Every join request requires explicit admin approval. There is no toggle to auto-accept requests. This keeps the security model simple: the admin always decides who enters the MLS group.

### 4. Nonce-based revocation (muting) — SUPERSEDED by epic-invite-link-lifecycle (expiry + hard delete)

Each generated link has a unique nonce. Admins can **mute** (disable) a nonce, causing the app to silently ignore any join requests that reference it. Muted nonces are persisted locally (IndexedDB). The link itself still opens the app and the invitee still sees the join UI, but the admin's app drops the request on receipt. This is a deliberate UX choice: the invitee is not told the link is dead, avoiding social awkwardness — their request simply never gets approved.

### 5. Pending requests appear as a section in the group detail view

When a group has pending join requests, a new section appears **above** the Members section. Admins see each requester's npub (and nickname/avatar if available) with Approve / Deny buttons. This section is only visible to admins and only when there are pending requests.

### 6. Bell notification for incoming requests

Incoming join requests increment the notification bell counter (same as unread chat messages). The bell popover shows "{group name}: join request" entries that link to the group detail view. This gives admins visibility without requiring them to check each group manually.

### 7. Static export compatible

The link uses query parameters, not path segments: `/groups?join={nonce}&admin={npub}&name={encodedName}`. This respects the `output: 'export'` constraint.

## Invite Link Format

```
https://nostling.941design.de/groups?join={nonce}&admin={adminNpub}&name={urlEncodedGroupName}
```

| Parameter | Type | Purpose |
|-----------|------|---------|
| `join` | string (hex, 16 bytes / 32 chars) | Unique nonce identifying this invite link |
| `admin` | string (npub / bech32) | The admin who generated the link |
| `name` | string (URL-encoded) | Group display name (cosmetic, not authoritative) |

The `groupId` is intentionally **not** in the URL. The admin's app resolves the nonce to the correct group internally. This avoids leaking the MLS group identifier.

## Data Model

### Join Request Event (inner rumor, wrapped in kind 1059)

```typescript
// Inner rumor — never published in cleartext
{
  kind: 21059,             // application-specific DM kind (avoid collision with standard kinds)
  pubkey: "<requester>",
  created_at: <unix>,
  tags: [["p", "<admin pubkey>"]],
  content: JSON.stringify({
    type: "join_request",
    nonce: "<hex nonce from link>",
    name: "<group name from link>",   // echoed back for admin display
  })
}
```

The outer gift wrap (kind 1059) targets the admin's pubkey using the same NIP-59 flow used for MLS Welcomes.

### Invite Link Record (persisted per group in IndexedDB)

```typescript
interface InviteLink {
  /** Hex nonce — primary key */
  nonce: string;
  /** Group this link belongs to */
  groupId: string;
  /** When the link was created (Unix ms) */
  createdAt: number;
  /** Human-readable label (optional, for admin's own tracking) */
  label?: string;
  /** Whether requests referencing this nonce are silently ignored */
  muted: boolean;
}
```

Stored in a new IndexedDB object store: `quizzl-invite-links`, keyed by nonce.

### Pending Join Request (in-memory + IndexedDB)

```typescript
interface PendingJoinRequest {
  /** Requester's pubkey (hex) */
  pubkeyHex: string;
  /** The nonce from the invite link */
  nonce: string;
  /** Group ID (resolved from nonce) */
  groupId: string;
  /** When the request was received (Unix ms) */
  receivedAt: number;
  /** Requester's nickname (if resolvable from kind 0 metadata) */
  nickname?: string;
  /** Event ID of the gift wrap (for deduplication) */
  eventId: string;
}
```

Stored in a new IndexedDB object store: `quizzl-join-requests`, keyed by `eventId`.

## Flows

### Flow 1: Admin generates an invite link

1. Admin opens group detail view.
2. Clicks "Invite Link" button (next to existing "Invite Member" button).
3. `GenerateInviteLinkModal` opens:
   - Auto-generates a 16-byte random nonce (`crypto.getRandomValues`).
   - Shows the full URL.
   - "Copy Link" button copies to clipboard.
   - Optional: label input for admin's own reference ("sent to class chat", etc.).
4. On copy/close, the `InviteLink` record is persisted to IndexedDB.
5. Admin shares the URL via any channel.

### Flow 2: Invitee opens the link

1. Invitee opens the URL in their browser.
2. `pages/groups.tsx` detects `join` query parameter.
3. **If the invitee has no identity yet:**
   - Show the standard identity setup flow (auto-generated keypair).
   - After setup completes, resume the join flow automatically.
   - KeyPackages are published as part of identity setup.
4. **If the invitee already has an identity:**
   - Show a confirmation card: "You've been invited to join **{name}**. Send a join request to the group admin?"
   - "Request to Join" button triggers the request.
5. On confirmation:
   a. Build the inner join-request rumor (kind 21059).
   b. Gift-wrap it (kind 1059) to the admin's pubkey.
   c. Publish to relays.
   d. Show success message: "Request sent! You'll be added once the admin approves."
6. The invitee's app does **not** yet have the group — they wait for a Welcome.

### Flow 3: Admin receives and approves a join request

1. Admin's app subscribes to incoming gift wraps (kind 1059) — this subscription already exists for MLS Welcomes.
2. On receiving a gift wrap:
   a. Decrypt the two NIP-59 layers.
   b. If inner rumor is kind 21059 with `type: "join_request"`:
      - Look up the nonce in `quizzl-invite-links`.
      - If nonce not found or `muted === true`: silently discard.
      - If nonce valid: resolve `groupId` from the invite link record.
      - Check for duplicate (same pubkey + groupId already pending): skip.
      - Store as `PendingJoinRequest` in IndexedDB.
      - Increment the notification bell counter for the group.
3. Admin sees the bell badge and navigates to the group.
4. The "Pending Requests" section shows the request with:
   - Requester's npub (truncated) and nickname/avatar if resolvable.
   - "Approve" and "Deny" buttons.
5. **On Approve:**
   - Call existing `inviteByNpub(groupId, requesterNpub)`.
   - This fetches their KeyPackage, creates the MLS Welcome, promotes to admin — the existing flow.
   - Remove the `PendingJoinRequest` from IndexedDB.
   - Decrement the bell counter.
6. **On Deny:**
   - Remove the `PendingJoinRequest` from IndexedDB.
   - Decrement the bell counter.
   - No notification is sent to the requester (they simply never receive a Welcome).

### Flow 4: Admin mutes an invite link — SUPERSEDED (now: admin deletes a link; links also auto-expire after ~24 h; see epic-invite-link-lifecycle)

1. Admin opens group detail view.
2. A "Manage Invite Links" section (or button) shows all active invite links for this group.
3. Each link shows: label (or "Untitled"), created date, and a "Mute" toggle.
4. Toggling mute sets `muted = true` on the `InviteLink` record in IndexedDB.
5. Future join requests referencing this nonce are silently discarded (Flow 3, step 2b).
6. The link URL still works (the app loads, the invitee can submit a request), but the admin's app ignores it.
7. Muting is reversible: the admin can unmute a link to start accepting requests from it again.

## UI Components

### New Components

| Component | Purpose |
|-----------|---------|
| `GenerateInviteLinkModal` | Modal for creating + copying an invite link |
| `PendingRequestsSection` | Section at top of group detail view showing pending join requests |
| `PendingRequestRow` | Single pending request with Approve/Deny buttons |
| `ManageInviteLinksModal` | Modal listing all invite links for a group with mute toggles |
| `JoinRequestCard` | Shown to the invitee when they open an invite link |

### Modified Components

| Component | Change |
|-----------|--------|
| `pages/groups.tsx` | Detect `join` query param; render `JoinRequestCard` or `GroupDetailView` |
| `GroupDetailView` | Add `PendingRequestsSection` above Members; add "Invite Link" button |
| `NotificationBell` | Include join request counts in badge and popover |
| `unreadStore.ts` | New `incrementJoinRequest` / `markJoinRequestsRead` / `clearJoinRequestGroup` functions, separate counter type |
| `MarmotContext` | Subscribe to kind 21059 join requests inside the existing gift-wrap handler; expose `pendingRequests`, `approveJoinRequest`, `denyJoinRequest`, `generateInviteLink`, `muteInviteLink` |

## Notification Bell Integration

The unread store gains a second counter dimension: `joinRequests` alongside `counts` (chat messages).

```typescript
type UnreadState = {
  counts: Record<string, number>;         // chat messages (existing)
  joinRequests: Record<string, number>;   // join requests (new)
};
```

`totalUnread` becomes the sum of both. The bell popover renders two types of entries:
- Chat: "{group name} — {n} unread messages" (existing)
- Join request: "{group name} — {n} join requests" (new, links to group detail)

Navigating to a group's detail view calls `markJoinRequestsRead(groupId)` alongside the existing `markAsRead(groupId)`.

## Storage

### New IndexedDB Stores

| Database | Store | Key | Value |
|----------|-------|-----|-------|
| `quizzl-invite-links` | `links` | `nonce` (string) | `InviteLink` |
| `quizzl-join-requests` | `requests` | `eventId` (string) | `PendingJoinRequest` |

### Backup Integration

`InviteLink` records should be included in the relay backup (kind 30078) so that nonce-to-group mappings survive device recovery. `PendingJoinRequest` records are ephemeral and not backed up — they can be re-received from relays.

Add to `BackupPayload`:

```typescript
/** Active invite links (nonce → group mapping + mute state) */
inviteLinks: InviteLink[];
```

## Deduplication & Replay Protection

- Join requests are deduplicated by `(requesterPubkey, groupId)`. If a request already exists for the same person and group, the newer one is silently dropped.
- The admin's app tracks processed gift-wrap event IDs in the existing `lp_processedGiftWraps` set to avoid reprocessing on reload.
- If the requester is already a group member, the request is silently discarded.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Invitee has no identity | Identity setup flow runs first, then join request resumes |
| Invitee has no KeyPackages yet | KeyPackages are published during identity setup; by the time the admin approves, they exist |
| Admin is offline when request arrives | Request is persisted on relay; admin's app picks it up on next sync |
| Multiple admins in the group | Only the admin whose npub is in the link receives the request. Other admins cannot see it. |
| Admin leaves the group | Pending requests for that group become unresolvable. The invitee's request is never answered. Consider: on group leave, clean up related invite links and pending requests. |
| Link shared after admin is removed from group | Same as above — request arrives but admin can no longer invite. Show an error on approve attempt. |
| Invitee clicks link but is already a member | Show "You're already a member of this group" and link to the group detail view |
| Same person requests twice | Deduplicated by (pubkey, groupId) — second request is dropped |
| Nonce collision | 16 bytes of randomness = 2^128 space, collision probability negligible |

## Caveats

### Single admin bottleneck

The link encodes one admin's npub. If that admin is unavailable, the request stalls. A future enhancement could encode multiple admin npubs or a "group admin" concept, but for v1 the single-admin model is acceptable and keeps the protocol simple.

### No expiry in v1 — SUPERSEDED

(Superseded: links now expire ~24 h after creation; see epic-invite-link-lifecycle.) Original v1 text: links do not expire automatically. Admins can mute them manually. Time-based expiry (e.g., "valid for 7 days") is a natural follow-up but adds complexity to v1.

### No rate limiting

A malicious actor could spam join requests. Since requests are gift-wrapped DMs to a specific admin, this is equivalent to DM spam — a known Nostr limitation. The admin can mute the nonce to stop the noise.

### Invitee sees no feedback on denial

By design, denied requests produce no notification to the invitee. This avoids social friction but means the invitee may wait indefinitely. Consider adding a "re-request" flow or timeout hint in a future iteration.

## Implementation Order

1. **Storage layer** — IndexedDB stores for invite links and pending requests.
2. **Link generation** — `GenerateInviteLinkModal`, nonce creation, clipboard copy.
3. **Join request sending** — `JoinRequestCard`, gift-wrap construction, relay publish.
4. **Join request receiving** — Gift-wrap handler extension in `MarmotContext`, nonce validation, persistence.
5. **Bell integration** — Extend `unreadStore` with join request counters, update `NotificationBell`.
6. **Pending requests UI** — `PendingRequestsSection` in group detail, approve/deny handlers.
7. **Muting** (superseded by expiry + hard delete) — `ManageInviteLinksModal`, mute toggle, filter in gift-wrap handler.
8. **Backup integration** — Add `inviteLinks` to `BackupPayload`.
9. **E2E tests** — Full flow: generate link, open as User B, approve, verify Welcome received.
