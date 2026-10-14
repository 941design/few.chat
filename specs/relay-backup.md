# Feature Spec: Relay Backup (Account Recovery via NIP-78)

## Goal

Make user accounts fully recoverable from a mnemonic/nsec by publishing encrypted app state to Nostr relays as a single NIP-78 addressable event.

## Background

Today, restoring from a mnemonic recovers only the Nostr keypair and kind-0 profile nickname. All study progress, settings, topics, avatar/badges, group membership, MLS group state, and chat history are lost. This feature eliminates that data loss.

## Key Decisions

### 1. Single opaque event — `d` tag is just `nostling`

One kind-30078 event per user. The `d` tag reveals only the app name. All data categories (settings, progress, groups, MLS state) are inside the NIP-44 encrypted blob. No metadata leakage about group count, topic count, or data categories.

### 2. NIP-44 encrypt to self

Content is encrypted using the user's own keypair (ECDH with self). Only the user's nsec can decrypt. Relay operators and other users see an opaque ciphertext.

Uses the existing `signerAdapter.ts` NIP-44 implementation (`nostr-tools/nip44` v2), calling `encrypt(ownPubkey, plaintext)` and `decrypt(ownPubkey, ciphertext)` on the signer's `nip44` interface.

### 3. Forward secrecy is intentionally sacrificed

Storing MLS group state in the backup means nsec compromise exposes historical group messages. This is an acceptable tradeoff for a study/quiz app — the security boundary is already the nsec. Same tradeoff WhatsApp makes with cloud backups.

### 4. MLS group state is included

The serialized MLS `ClientState` per group is part of the backup. On restore, the user can decrypt historical messages without needing a fresh Welcome from peers. Key rotation is still done on membership changes (join/leave) but does not need an aggressive schedule.

The `SerializedClientState` from `@internet-privacy/marmot-ts` is a binary blob. It is base64-encoded for inclusion in the JSON backup payload. Read via `IdbGroupStateBackend.getItem(groupId)` for each group, restored via `setItem(groupId, state)`.

### 5. Backup is a single atomic snapshot

All data in one event = no partial-write risk. Either the full backup lands or it doesn't. No inconsistent state between settings, progress, and group data.

### 6. Relay size limit respected

Target backup size well under 64 KB. MLS state for small groups (5-20 members) is a few KB each. Study progress and settings are small. If the blob ever exceeds limits, split into `nostling` and `quizzl:ext` without revealing contents.

### 7. Schema versioning

The backup payload includes a `version` field (integer, starting at 1). On restore, the deserializer checks the version and applies any necessary migrations. Unknown future versions are rejected with a user-facing message ("backup was created by a newer version of nostling").

### 8. Relay selection

Default to the same relays from the kind 30051 addressable relay list (the `d:marmot` event already published for key package discovery). No separate "storage relay" config for v1. If no relay accepts the backup event, show a non-blocking warning in the UI.

### 9. Restore conflict handling

Restore is **non-destructive** (supersedes the original clear-and-replace design, which wiped categories the backup does not carry — contacts, DM threads, knownPeers, relays, signerMode — and was fixed as a bug). Restore overwrites only the categories the backup carries (settings, profile, and each backed-up group's metadata, MLS state and member profiles), never deletes groups absent from the backup, and **merges** group chat by message id (local wins on id collision) because the backup truncates chat history. `restoreFromBackup` in `app/src/lib/backup/relayBackup.ts` is authoritative; user-facing behaviour is described in `docs/behavior/backup-and-recovery.md`.

## What Gets Backed Up

| Data | localStorage key / IDB store | Backed up |
|------|------------------------------|-----------|
| Settings (theme, language) | `lp_settings_v1` | Yes |
| Avatar + badges | `lp_userProfile_v1` | Yes |
| Selected topics | `lp_selectedTopics_v1` | Yes |
| Study progress (points, answers, notes) | `lp_progress_v1` | Yes |
| Study sessions / time tracking | `lp_studyTimes_v1` | Yes |
| Score sync sequence number | `lp_scoreSyncSeq_v1` | Yes |
| MLS group state (per group) | `quizzl-groups-state` IDB | Yes |
| Group metadata (id, name, relays, members) | `quizzl-groups-meta` IDB | Yes |
| Member scores (per group) | `quizzl-member-scores` IDB | Yes |
| Member profiles (per group) | `quizzl-member-profiles` IDB | Yes |
| Chat messages (last 10 per group) | `quizzl:messages:{groupId}` IDB (default store) | Yes |
| Key package private keys | `quizzl-keypackages` IDB | No — regenerated fresh |
| Contact cache | `lp_contactCache_v1` | No — rebuilt from member profiles |
| Score sync queue | `lp_scoreSyncQueue_v1` | No — ephemeral retry queue |
| Processed gift wrap IDs | `lp_processedGiftWraps` | No — idempotent reprocessing is safe |
| Nostr identity | `lp_nostrIdentity_v1` | No — derived from mnemonic |
| Backup flag | `lp_nostrIdentityBackedUp_v1` | No — set to true after restore |

## Backup Payload Schema (v1)

```typescript
interface BackupPayload {
  /** Schema version — always 1 for this spec */
  version: 1;
  /** Unix seconds when this backup was created */
  createdAt: number;

  // --- localStorage data (stored as-is, JSON-parsed values) ---

  /** Value of lp_settings_v1 */
  settings: { theme: string; language: string } | null;
  /** Value of lp_userProfile_v1 */
  userProfile: {
    nickname: string;
    avatar: { id: string; subject: string; accessories: string[] } | null;
    badgeIds: string[];
  } | null;
  /** Value of lp_selectedTopics_v1 */
  selectedTopics: string[] | null;
  /** Value of lp_progress_v1 */
  progress: Record<string, unknown> | null;
  /** Value of lp_studyTimes_v1 */
  studyTimes: unknown[] | null;
  /** Value of lp_scoreSyncSeq_v1 */
  scoreSyncSeq: number;

  // --- IndexedDB data ---

  /** Group metadata from quizzl-groups-meta IDB store */
  groups: Array<{
    id: string;
    name: string;
    createdAt: string;
    memberPubkeys: string[];
    relays: string[];
  }>;

  /** MLS group state — keyed by groupId, values are base64-encoded SerializedClientState */
  groupStates: Record<string, string>;

  /** Member scores from quizzl-member-scores IDB store, keyed by "group:{groupId}" */
  memberScores: Record<string, unknown[]>;

  /** Member profiles from quizzl-member-profiles IDB store, keyed by "group:{groupId}" */
  memberProfiles: Record<string, unknown[]>;

  /** Last 10 chat messages per group, keyed by groupId */
  chatMessages: Record<string, Array<{
    id: string;
    content: string;
    senderPubkey: string;
    groupId: string;
    createdAt: number;
  }>>;
}
```

## Chat Message Retention

Only the last 10 messages per group are included in the backup. This keeps the blob small and provides enough context for the user to resume conversations. Older messages are only recoverable if the MLS group state backup allows decrypting them from relay history.

## Backup Trigger

Triggers are prioritized by significance. Not all state changes warrant a relay write.

**Immediate triggers** (publish as soon as debounce window allows):

- Group created, joined, or left
- Profile changed (nickname, avatar, badges)
- Member invited or removed
- App backgrounding / page visibility change to hidden

**Deferred triggers** (batched into the next immediate trigger or periodic backup):

- Quiz completed / study progress changed
- Settings changed (theme, language)
- Study session recorded
- Chat messages received or sent

**Not a trigger:**

- Individual chat messages do not trigger a backup on their own. Chat state is picked up by the next backup triggered by something else.

**Debounce:** At most one relay publish per 5 minutes, regardless of trigger priority. Immediate triggers are queued and flushed at the next debounce window.

## Nostr Event Structure

```json
{
  "kind": 30078,
  "tags": [["d", "nostling"]],
  "content": "<NIP-44 ciphertext of JSON.stringify(BackupPayload)>",
  "created_at": 1234567890
}
```

Signed with the user's private key via the existing `signerAdapter.signEvent()`.

## Backup Flow (Serialize → Encrypt → Publish)

1. Collect all localStorage keys listed in the backup table, JSON.parse each value
2. Read all group IDs from `quizzl-groups-meta` IDB via `loadAllGroups()`
3. For each group:
   a. Read MLS state from `IdbGroupStateBackend.getItem(groupId)` → base64-encode
   b. Read member scores from `loadMemberScores(groupId)`
   c. Read member profiles from `loadMemberProfiles(groupId)`
   d. Read chat messages from `loadMessages(groupId)` → take last 10
4. Assemble `BackupPayload` with `version: 1` and `createdAt: now`
5. `JSON.stringify(payload)` → encrypt via `signer.nip44.encrypt(ownPubkey, json)`
6. Build kind 30078 event with `d:nostling` tag and encrypted content
7. Sign via `signer.signEvent(event)`
8. Publish to relays from kind 30051 relay list

## Restore Flow

1. User enters mnemonic → derive nsec/npub, create signer
2. Fetch kind 30078 with filter `{ kinds: [30078], authors: [pubkey], '#d': ['nostling'] }` from relays
3. Take most recent event (highest `created_at`) — some backup is better than nothing
4. Decrypt content via `signer.nip44.decrypt(ownPubkey, event.content)`
5. `JSON.parse(decrypted)` → validate `version` field
6. If `version > 1`: reject with "backup from newer nostling version" message
7. ~~Warn user that restore replaces all current data~~ / ~~8. Clear existing local state~~ — superseded: restore is non-destructive (see Key Decision 9); nothing is cleared.
9. Rehydrate localStorage: write each non-null field back to its `lp_*` key
10. Rehydrate IDB:
    a. For each group in `groups[]`: `saveGroup(group)`
    b. For each entry in `groupStates`: base64-decode → `IdbGroupStateBackend.setItem(groupId, state)`
    c. For each entry in `memberScores`: `saveMemberScores(groupId, scores)`
    d. For each entry in `memberProfiles`: `saveMemberProfiles(groupId, profiles)`
    e. For each entry in `chatMessages`: merge with the stored messages by id (local wins on collision), sort chronologically, write back via idb-keyval
11. Set `lp_nostrIdentityBackedUp_v1 = 'true'`
12. Reload app to reinitialize contexts with restored state

## Relay Write Failure Handling

- Attempt publish to all relays from the kind 30051 list
- If at least one relay accepts: success, no UI indication needed
- If all relays reject: show a non-blocking toast/banner "Backup could not be saved — check relay connectivity"
- Do not retry automatically — the next trigger will attempt again
- No queue/persistence of failed backups (the next successful backup supersedes anyway)

## Implementation Notes

- New module: `app/src/lib/backup/relayBackup.ts` — serialize, encrypt, publish, fetch, decrypt, rehydrate
- Backup trigger integration: hook into `MarmotContext` for group events, `ProfileContext` for profile changes, `visibilitychange` listener for app backgrounding
- Debounce logic: simple timer — on trigger, if no publish in last 5 minutes, publish now; otherwise mark dirty and publish when timer fires
- The existing `createPrivateKeySigner` in `signerAdapter.ts` already exposes `nip44.encrypt`/`nip44.decrypt` — use directly
- Base64 encoding for `SerializedClientState`: use `btoa(String.fromCharCode(...bytes))` / `Uint8Array.from(atob(b64), c => c.charCodeAt(0))`
