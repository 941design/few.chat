# Acceptance Criteria: Group Invite Links

## AC-1: Invite Link Storage Layer
- `inviteLinkStorage.ts` exports `createInviteLinkStore()` returning an idb-keyval store backed by IDB database `quizzl-invite-links` with store name `links`
- `saveInviteLink(link: InviteLink)` persists the record keyed by `nonce`
- `loadInviteLinks(groupId: string)` returns all `InviteLink` records whose `groupId` matches
- `getInviteLink(nonce: string)` returns a single `InviteLink | undefined`
- `updateInviteLinkMuted(nonce: string, muted: boolean)` sets the `muted` field and persists
- `deleteInviteLink(nonce: string)` removes the record
- `InviteLink` type has fields: `nonce` (string), `groupId` (string), `createdAt` (number), `label` (string | undefined), `muted` (boolean)

## AC-2: Join Request Storage Layer
- `joinRequestStorage.ts` exports `createJoinRequestStore()` returning an idb-keyval store backed by IDB database `quizzl-join-requests` with store name `requests`
- `savePendingJoinRequest(request: PendingJoinRequest)` persists the record keyed by `eventId`
- `loadPendingJoinRequests(groupId: string)` returns all `PendingJoinRequest` records whose `groupId` matches
- `deletePendingJoinRequest(eventId: string)` removes the record
- `clearPendingJoinRequestsForGroup(groupId: string)` removes all requests for that group
- Deduplication: `savePendingJoinRequest` is a no-op if a request with the same `pubkeyHex` + `groupId` already exists
- `PendingJoinRequest` type has fields: `pubkeyHex` (string), `nonce` (string), `groupId` (string), `receivedAt` (number), `nickname` (string | undefined), `eventId` (string)

## AC-3: Invite Link Generation
- `GenerateInviteLinkModal` renders a Chakra Modal with auto-generated 16-byte hex nonce via `crypto.getRandomValues`
- The URL follows format `https://nostling.941design.de/groups?join={nonce}&admin={adminNpub}&name={urlEncodedGroupName}`
- "Copy Link" button copies the URL to clipboard and shows a success toast
- Optional label input (text field) is stored with the `InviteLink` record
- On copy or close, `saveInviteLink()` persists the `InviteLink` to IndexedDB with `muted: false`
- An "Invite Link" button appears in `GroupDetailView` next to the existing "Invite Member" button (admin-only)
- i18n: `useCopy()` keys added for all UI strings (button label, modal title, copy button, label placeholder, success toast)

## AC-4: Join Request Sending (Invitee Side)
- `pages/groups.tsx` detects `join`, `admin`, and `name` query parameters and renders `JoinRequestCard` instead of the normal groups view
- `JoinRequestCard` displays the group name and a "Request to Join" button
- If the invitee has no identity (`lp_nostrIdentity_v1` absent), the standard identity setup flow runs first, then the join flow resumes automatically
- If the invitee is already a member of the group (resolved by checking admin pubkey's groups), `JoinRequestCard` shows "You're already a member" with a link to the group
- On confirmation: builds a kind 21059 inner rumor with `content: JSON.stringify({ type: "join_request", nonce, name })`, `tags: [["p", adminPubkeyHex]]`, wraps it in NIP-59 gift wrap (kind 1059) targeting the admin pubkey, and publishes to relays
- After successful publish, shows success message: "Request sent! You'll be added once the admin approves."
- i18n: `useCopy()` keys added for invitation card heading, request button, success message, already-member message

## AC-5: Join Request Receiving (Admin Side)
- The existing gift-wrap handler in `welcomeSubscription.ts` (kind 1059 `sub.on('event')`) is extended: after unwrapping, if the inner rumor kind is `21059`, it dispatches to a join-request handler instead of `joinGroupFromWelcome`
- The join-request handler: parses `content` as JSON, extracts `type`, `nonce`, `name`; looks up nonce via `getInviteLink(nonce)`
- If nonce not found or `muted === true`: silently discards the request
- If the requester's pubkey is already a group member: silently discards
- If a `PendingJoinRequest` with the same `pubkeyHex` + `groupId` already exists: silently discards (dedup)
- Otherwise: resolves `groupId` from the invite link record, stores a `PendingJoinRequest` via `savePendingJoinRequest()`, and calls the notification callback
- The processed gift-wrap event ID is added to `lp_processedGiftWraps` to prevent re-processing on reload

## AC-6: Unread Store Join Request Counters
- `UnreadState` gains a `joinRequests: Record<string, number>` field alongside existing `counts`
- `incrementJoinRequest(groupId: string)` increments the join request counter for the group and calls `emit()`
- `markJoinRequestsRead(groupId: string)` resets the join request counter for the group to 0 and calls `emit()`
- `clearJoinRequestGroup(groupId: string)` removes the group key from `joinRequests` and calls `emit()`
- `totalUnread` in `useUnreadCounts()` sums both `counts` and `joinRequests` values
- `useUnreadCounts()` returns `joinRequests` alongside existing `counts`
- The test bridge on `window.__nostlingUnread` exposes the new functions
- `initJoinRequestCounts(groupIds)` seeds `joinRequests` from the persisted pending requests via the startup scan (`reconcileInit('joinRequests', ...)`). A join request persisted while that scan is running must not be dropped from the badge: `incrementJoinRequest` calls `noteLiveIncrement('joinRequests', groupId)`, which queues the group for an authoritative re-read after the scan. Covered by the unit test `a join request that lands mid-scan is still counted once the scan finishes` (`app/tests/unit/unreadStore.test.ts`). The same startup-reconciliation invariant holds for the `counts` and `directMessages` slices (see `reconcileInit` / `noteLiveIncrement` in `app/src/lib/unreadStore.ts`); it is stated here only as a cross-reference.

## AC-7: Notification Bell Integration
- `NotificationBell` badge count reflects the combined total from chat messages and join requests
- The bell popover renders join request entries as "{group name} -- {n} join requests" (distinct from chat unread entries)
- Clicking a join request entry navigates to the group detail view and calls `markJoinRequestsRead(groupId)`
- i18n: `useCopy()` keys added for the join request popover entry format string

## AC-8: Pending Requests UI
- `PendingRequestsSection` renders above the Members section in `GroupDetailView`, visible only to admins and only when pending requests exist for the group
- Each `PendingRequestRow` shows: requester npub (truncated) and, when present, the requester's nickname (see `## Amendments` — the nickname is transported inside the NIP-59 gift-wrapped join request rumor itself, never resolved from, or falling back to, kind-0 metadata; when absent, the row renders the truncated npub alone), plus "Approve" and "Deny" buttons
- "Approve" calls `inviteByNpub(groupId, requesterNpub)` (existing MLS ceremony), then removes the `PendingJoinRequest` from IndexedDB and decrements the bell counter
- "Deny" removes the `PendingJoinRequest` from IndexedDB and decrements the bell counter; no notification is sent to the requester
- If `inviteByNpub` returns an error on approve, the error is displayed inline and the request remains pending
- i18n: `useCopy()` keys added for section heading, approve/deny buttons, error messages

## AC-9: Invite Link Muting
- `ManageInviteLinksModal` lists all invite links for the current group, loaded via `loadInviteLinks(groupId)`
- Each row shows: label (or "Untitled"), creation date, mute toggle switch
- Toggling mute calls `updateInviteLinkMuted(nonce, muted)` and updates the UI state
- Muted links cause the join-request handler (AC-5) to silently discard incoming requests referencing that nonce
- Unmuting a link resumes request acceptance
- The modal is accessible from a "Manage Links" button in `GroupDetailView` (admin-only)
- i18n: `useCopy()` keys added for modal title, mute toggle label, untitled fallback, manage links button

## AC-10: Backup Integration
- `BackupPayload` type gains `inviteLinks: InviteLink[]` field
- `collectBackupPayload()` reads all invite links from the `quizzl-invite-links` IDB store and includes them in the payload
- `restoreFromBackup()` writes invite links from the payload back to the `quizzl-invite-links` IDB store
- `PendingJoinRequest` records are NOT included in backup (ephemeral, re-receivable from relays)

## AC-11: E2E Test — Full Invite Link Flow
- E2E test uses `test.describe.serial()` with User A (admin) and User B (invitee)
- User A creates a group, generates an invite link via `GenerateInviteLinkModal`, and copies the URL
- User B navigates to the invite link URL, sees `JoinRequestCard`, clicks "Request to Join"
- User A's bell counter increments; navigating to the group shows `PendingRequestsSection` with User B's request
- User A clicks "Approve"; User B receives a Welcome and the group appears in their group list
- `clearAppState` includes `quizzl-invite-links` and `quizzl-join-requests` databases

## Amendments

- **2026-07-16** — **AC-8** amended by `specs/epic-group-invite-link-onboarding/` (story S5).
  The original clause — "nickname/avatar if resolvable from kind 0 metadata" — was vacuous
  under this product's privacy invariant (CLAUDE.md): no Few user ever publishes a public
  kind-0, so the lookup could never resolve, and `joinRequestHandler.ts` had hardcoded
  `nickname: undefined` accordingly. The requester's nickname now arrives exclusively inside
  the NIP-59 gift-wrapped join-request rumor itself (a new `requesterName` field, distinct
  from the rumor's existing group-name field), capped at 32 UTF-8 bytes on receive — never
  via a kind-0 lookup or fallback. No avatar transport was introduced. See
  `specs/epic-group-invite-link-onboarding/acceptance-criteria.md` AC-NAME-1..5 and AC-SEC-4
  for the full contract, and that epic's `spec.md` "Relationship to Other Epics" for the
  rationale. No other AC in this file is affected or renumbered by this amendment.
