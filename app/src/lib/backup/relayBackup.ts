/**
 * Relay backup — payload assembly, serialization, encryption, and publishing.
 *
 * Collects all local app state (localStorage + IDB) into a single
 * BackupPayload object, encrypts it with NIP-44 self-encryption,
 * and publishes/fetches it as a kind 30078 replaceable event.
 */

import { STORAGE_KEYS } from '@/src/types';
import { getEffectiveRelays } from '@/src/lib/relay';
import {
  loadAllGroups,
  loadMemberProfiles,
  saveGroup,
  saveMemberProfiles,
  IdbGroupStateBackend,
} from '@/src/lib/marmot/groupStorage';
import { loadMessages } from '@/src/lib/marmot/chatPersistence';
import { listLeftGroupIds } from '@/src/lib/marmot/leftGroupTombstones';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';
import { loadAllInviteLinks, saveInviteLink } from '@/src/lib/marmot/inviteLinkStorage';
import type { InviteLink } from '@/src/lib/marmot/inviteLinkStorage';
import type { EventSigner } from 'applesauce-core';
import type NDK from '@nostr-dev-kit/ndk';
import { connectNdk, fetchEventsWithTimeout } from '@/src/lib/ndkClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupPayload {
  version: 1;
  createdAt: number;
  settings: { theme: string; language: string } | null;
  userProfile: {
    nickname: string;
    avatar: { imageUrl: string } | null;
  } | null;
  groups: Array<{
    id: string;
    name: string;
    createdAt: number;
    memberPubkeys: string[];
    relays: string[];
  }>;
  groupStates: Record<string, string>;
  memberProfiles: Record<string, unknown[]>;
  chatMessages: Record<
    string,
    Array<{
      id: string;
      content: string;
      senderPubkey: string;
      groupId: string;
      createdAt: number;
    }>
  >;
  inviteLinks: InviteLink[];
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function readJsonItem<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

/** Maximum number of chat messages to include per group. */
const MAX_CHAT_MESSAGES = 10;

export async function collectBackupPayload(): Promise<BackupPayload> {
  // localStorage reads
  const settings = readJsonItem<{ theme: string; language: string }>(
    STORAGE_KEYS.settings,
  );

  const rawProfile = readJsonItem<{
    nickname: string;
    avatar: { imageUrl: string } | null;
  }>(STORAGE_KEYS.userProfile);
  const userProfile = rawProfile ?? null;

  // IDB reads
  const groups = await loadAllGroups();

  const groupStates: Record<string, string> = {};
  const memberProfiles: Record<string, unknown[]> = {};
  const chatMessages: Record<string, ChatMessage[]> = {};

  const stateBackend = new IdbGroupStateBackend();
  const stateKeys = await stateBackend.keys();

  // MLS state (group keys) is exported only for groups this device is still
  // in: an overlay record exists and the group is not tombstoned as left
  // (bug: left-groups-keep-mls-state-forever). A left group's state awaiting
  // its deferred destroy, or an orphan without an overlay, never leaves the
  // device. The tombstones themselves are never exported.
  const leftGroupIds = await listLeftGroupIds();
  const backedUpGroupIds = new Set(groups.map((g) => g.id).filter((id) => !leftGroupIds.has(id)));

  // Load MLS state for those groups and base64-encode
  for (const key of stateKeys) {
    if (!backedUpGroupIds.has(key)) continue;
    const state = await stateBackend.getItem(key);
    if (state) {
      // SerializedClientState may be a Uint8Array or have a bytes field
      const bytes =
        state instanceof Uint8Array
          ? state
          : typeof (state as { bytes?: Uint8Array }).bytes !== 'undefined'
            ? new Uint8Array((state as { bytes: Uint8Array }).bytes)
            : new TextEncoder().encode(JSON.stringify(state));
      groupStates[key] = uint8ArrayToBase64(bytes);
    }
  }

  // Per-group data
  for (const group of groups) {
    const profiles = await loadMemberProfiles(group.id);
    memberProfiles[group.id] = profiles;

    const { messages } = await loadMessages(group.id);
    // Keep only the last MAX_CHAT_MESSAGES, preserving chronological order
    chatMessages[group.id] = messages.slice(-MAX_CHAT_MESSAGES);
  }

  // Invite links (all groups)
  const inviteLinks = await loadAllInviteLinks();

  return {
    version: 1,
    createdAt: Math.floor(Date.now() / 1000),
    settings,
    userProfile,
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      createdAt: g.createdAt,
      memberPubkeys: g.memberPubkeys,
      relays: g.relays,
    })),
    groupStates,
    memberProfiles,
    chatMessages,
    inviteLinks,
  };
}

// ---------------------------------------------------------------------------
// S2: NIP-44 encrypt, publish, fetch, decrypt
// ---------------------------------------------------------------------------

/** Kind 30078 is a parameterized replaceable event (NIP-78: application data). */
const BACKUP_EVENT_KIND = 30078;
const BACKUP_D_TAG = 'few';

/** Kind 30051 is a relay list for specific use (NIP-51 sets). */
const RELAY_LIST_KIND = 30051;

/**
 * Encrypt the backup payload with NIP-44 (self-encryption) and build
 * a kind 30078 unsigned event template.
 */
export async function createBackupEvent(
  payload: BackupPayload,
  signer: EventSigner,
  pubkeyHex: string,
): Promise<{ kind: number; created_at: number; tags: string[][]; content: string }> {
  const plaintext = JSON.stringify(payload);
  const ciphertext = await signer.nip44!.encrypt(pubkeyHex, plaintext);

  return {
    kind: BACKUP_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', BACKUP_D_TAG]],
    content: ciphertext,
  };
}

/**
 * Collect the backup payload, encrypt it, sign it, and publish to relays.
 * Returns { ok: true } on success, or { ok: false, error } if all relays reject.
 */
export async function publishBackup(
  signer: EventSigner,
  pubkeyHex: string,
  ndk: NDK,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const payload = await collectBackupPayload();
    const eventTemplate = await createBackupEvent(payload, signer, pubkeyHex);
    const signedEvent = await signer.signEvent(eventTemplate);

    const { NDKEvent, NDKRelaySet } = await import('@nostr-dev-kit/ndk');
    const relayUrls = await getBackupRelays(ndk, pubkeyHex, { reuseAfterRecentTimeout: true });
    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk);

    const ndkEvent = new NDKEvent(ndk);
    ndkEvent.kind = signedEvent.kind;
    ndkEvent.content = signedEvent.content;
    ndkEvent.tags = signedEvent.tags;
    ndkEvent.created_at = signedEvent.created_at;
    ndkEvent.pubkey = signedEvent.pubkey;
    ndkEvent.id = signedEvent.id;
    ndkEvent.sig = signedEvent.sig;

    await ndkEvent.publish(relaySet);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'publish failed';
    return { ok: false, error: message };
  }
}

/**
 * Outcome of looking up the user's backup. `unusable.reason` is diagnostic
 * only — the UI shows one message for both reasons.
 */
export type BackupLookup =
  | { status: 'found'; payload: BackupPayload }
  | { status: 'none' }
  | { status: 'unreachable' }
  | { status: 'unusable'; reason: 'newer-version' | 'unreadable' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isBase64(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    atob(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a decrypted v1 payload's full shape before anything is written,
 * so a malformed backup is refused instead of partially applied. Collections
 * an older v1 payload may lack are normalised to empty. Returns null when the
 * payload is not a usable v1 backup.
 */
export function parseBackupPayload(raw: unknown): BackupPayload | null {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.createdAt !== 'number') return null;

  const { settings, userProfile } = raw;
  if (settings !== null && settings !== undefined && !isRecord(settings)) return null;
  if (userProfile !== null && userProfile !== undefined) {
    if (!isRecord(userProfile) || typeof userProfile.nickname !== 'string') return null;
  }

  const groups = raw.groups ?? [];
  if (
    !Array.isArray(groups) ||
    !groups.every(
      (g) =>
        isRecord(g) &&
        typeof g.id === 'string' &&
        typeof g.name === 'string' &&
        typeof g.createdAt === 'number' &&
        isStringArray(g.memberPubkeys) &&
        isStringArray(g.relays),
    )
  ) {
    return null;
  }

  const groupStates = raw.groupStates ?? {};
  if (!isRecord(groupStates) || !Object.values(groupStates).every(isBase64)) return null;

  const memberProfiles = raw.memberProfiles ?? {};
  if (!isRecord(memberProfiles) || !Object.values(memberProfiles).every(Array.isArray)) return null;

  const chatMessages = raw.chatMessages ?? {};
  if (
    !isRecord(chatMessages) ||
    !Object.values(chatMessages).every(
      (list) =>
        Array.isArray(list) &&
        list.every((m) => isRecord(m) && typeof m.id === 'string' && typeof m.createdAt === 'number'),
    )
  ) {
    return null;
  }

  const inviteLinks = raw.inviteLinks ?? [];
  if (!Array.isArray(inviteLinks) || !inviteLinks.every(isRecord)) return null;

  return {
    ...(raw as unknown as BackupPayload),
    settings: (settings ?? null) as BackupPayload['settings'],
    userProfile: (userProfile ?? null) as BackupPayload['userProfile'],
    groups: groups as BackupPayload['groups'],
    groupStates: groupStates as BackupPayload['groupStates'],
    memberProfiles: memberProfiles as BackupPayload['memberProfiles'],
    chatMessages: chatMessages as BackupPayload['chatMessages'],
    inviteLinks: inviteLinks as unknown as InviteLink[],
  };
}

/**
 * Look up the latest backup on relays, decrypt and validate it. Never throws:
 * every failure maps to a lookup outcome the restore UI can show.
 */
export async function fetchBackup(
  signer: EventSigner,
  pubkeyHex: string,
  ndk: NDK,
  relays?: string[],
): Promise<BackupLookup> {
  let events: Set<{ content: string; created_at?: number }>;
  let timedOut: boolean;
  try {
    const relayUrls = relays ?? getEffectiveRelays();
    const { NDKRelaySet } = await import('@nostr-dev-kit/ndk');
    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk);
    ({ events, timedOut } = await fetchEventsWithTimeout(
      ndk,
      { kinds: [BACKUP_EVENT_KIND], authors: [pubkeyHex], '#d': [BACKUP_D_TAG] },
      undefined,
      relaySet,
    ));
  } catch {
    return { status: 'unreachable' };
  }

  if (events.size === 0) return timedOut ? { status: 'unreachable' } : { status: 'none' };

  // Pick the newest event by created_at
  let newest: { content: string; created_at: number } | null = null;
  for (const ev of events) {
    if (!newest || (ev.created_at ?? 0) > newest.created_at) {
      newest = { content: ev.content, created_at: ev.created_at ?? 0 };
    }
  }

  if (!newest) return { status: 'none' };

  let raw: unknown;
  try {
    raw = JSON.parse(await signer.nip44!.decrypt(pubkeyHex, newest.content));
  } catch {
    return { status: 'unusable', reason: 'unreadable' };
  }

  if (isRecord(raw) && typeof raw.version === 'number' && raw.version > 1) {
    return { status: 'unusable', reason: 'newer-version' };
  }
  const payload = parseBackupPayload(raw);
  return payload ? { status: 'found', payload } : { status: 'unusable', reason: 'unreadable' };
}

/**
 * How long after a timed-out relay-list fetch a backup publish skips the fetch
 * (bug: first-relay-backup-cold-start-retry). The fetch costs up to 8 s when
 * the relays are slow; a retry shortly after such a timeout would most likely
 * time out again and push the publish past its own deadline.
 */
const RELAY_LIST_TIMEOUT_REUSE_MS = 60 * 1000;

/**
 * In-memory, per identity: when the last relay-list fetch timed out. Never
 * persisted. Deliberately no remembered relay list: a remembered list could
 * name relays the user has since removed.
 */
const relayListTimedOutAt = new Map<string, number>();

/** Forget the relay-list memo (tests; nothing in the app needs to reset it). */
export function resetBackupRelayListMemo(): void {
  relayListTimedOutAt.clear();
}

/**
 * Read relay URLs from the user's kind 30051 relay list event.
 * Falls back to the effective relays (the user's configured relays, else
 * DEFAULT_RELAYS) if no list is found — also when the fetch timed out empty.
 *
 * With `reuseAfterRecentTimeout` (the backup publish path), within
 * RELAY_LIST_TIMEOUT_REUSE_MS of a timed-out fetch for this identity it skips
 * the fetch and uses the currently configured relays (getEffectiveRelays(),
 * read at call time) — the relays a timed-out fetch resolves to anyway.
 */
export async function getBackupRelays(
  ndk: NDK,
  pubkeyHex: string,
  opts?: { reuseAfterRecentTimeout?: boolean },
): Promise<string[]> {
  if (opts?.reuseAfterRecentTimeout) {
    const timedOutAt = relayListTimedOutAt.get(pubkeyHex);
    if (timedOutAt !== undefined && Date.now() - timedOutAt < RELAY_LIST_TIMEOUT_REUSE_MS) {
      return getEffectiveRelays();
    }
  }

  const { events, timedOut } = await fetchEventsWithTimeout(ndk, {
    kinds: [RELAY_LIST_KIND as import('@nostr-dev-kit/ndk').NDKKind],
    authors: [pubkeyHex],
  });
  if (timedOut) relayListTimedOutAt.set(pubkeyHex, Date.now());
  else relayListTimedOutAt.delete(pubkeyHex);

  return relayUrlsFromNewestList(events) ?? getEffectiveRelays();
}

/** Relay URLs of the newest dated relay-list event, or null when there are none. */
function relayUrlsFromNewestList(events: Set<{ created_at?: number; tags: string[][] }>): string[] | null {
  if (events.size === 0) return null;

  // Pick newest event
  let newest: { tags: string[][] } | null = null;
  let newestAt = 0;
  for (const ev of events) {
    if ((ev.created_at ?? 0) > newestAt) {
      newestAt = ev.created_at ?? 0;
      newest = { tags: ev.tags };
    }
  }

  if (!newest) return null;

  // Extract relay URLs from 'relay' or 'r' tags
  const relayUrls = newest.tags
    .filter((t) => t[0] === 'relay' || t[0] === 'r')
    .map((t) => t[1])
    .filter(Boolean);

  return relayUrls.length > 0 ? relayUrls : null;
}

/**
 * Look up the relay backup for an identity whose private key the app holds:
 * connect, read the relay list, fetch, decrypt, and validate. Never throws — a
 * failure to connect counts as "unreachable".
 */
export async function lookupBackup(privateKeyHex: string, pubkeyHex: string): Promise<BackupLookup> {
  try {
    const { createPrivateKeySigner } = await import('@/src/lib/marmot/signerAdapter');
    const ndk = await connectNdk(privateKeyHex);
    const relays = await getBackupRelays(ndk, pubkeyHex);
    const lookup = await fetchBackup(createPrivateKeySigner(privateKeyHex), pubkeyHex, ndk, relays);
    if (lookup.status === 'unusable') console.warn('[Backup] relay backup unusable:', lookup.reason);
    return lookup;
  } catch (err) {
    console.warn('[Backup] relay backup lookup failed:', err);
    return { status: 'unreachable' };
  }
}

// ---------------------------------------------------------------------------
// Restore-decision guard
//
// From identity recovery until the user restores or skips the backup found on
// relays, a scheduled backup would replace that (replaceable, kind 30078)
// backup with the device's near-empty state. The guard is persisted so the
// pause survives a reload; the Settings page re-offers the decision.
// ---------------------------------------------------------------------------

export function markRestorePending(pubkeyHex: string): void {
  localStorage.setItem(STORAGE_KEYS.backupRestorePending, pubkeyHex);
}

export function clearRestorePending(): void {
  localStorage.removeItem(STORAGE_KEYS.backupRestorePending);
}

export function isRestorePending(pubkeyHex: string): boolean {
  return localStorage.getItem(STORAGE_KEYS.backupRestorePending) === pubkeyHex;
}

/**
 * Lift the guard once a lookup shows there is nothing worth protecting: no
 * backup, or one that cannot be read. A found backup waits for the user's
 * decision; an unreachable lookup proves nothing; a backup from a newer app
 * version is kept so an older app never overwrites it.
 */
export function settleRestoreGuard(lookup: BackupLookup): void {
  if (
    lookup.status === 'none' ||
    (lookup.status === 'unusable' && lookup.reason === 'unreadable')
  ) {
    clearRestorePending();
  }
}

// ---------------------------------------------------------------------------
// S3: Restore state from backup payload
// ---------------------------------------------------------------------------

/**
 * Restore local state from a backup payload — NON-DESTRUCTIVELY.
 *
 * A backup carries only a subset of device state: settings + userProfile
 * (localStorage), and groups, MLS group state, member profiles, recent group
 * chat (capped at MAX_CHAT_MESSAGES per group), and invite links (IDB). It does
 * NOT carry DM thread history, contacts / contact cache, known peers, relay or
 * signer config, polls, pending join requests, or media blobs.
 *
 * Restore therefore overwrites ONLY the categories the backup carries and leaves
 * everything else untouched. An earlier implementation blanket-cleared every
 * `STORAGE_KEYS` entry and every `few:messages:*` IDB key (including DM
 * threads) before rehydrating the subset, silently destroying DM history,
 * contacts, relay/signer config, polls, and media. Group chat is MERGED rather
 * than overwritten so the per-group MAX_CHAT_MESSAGES cap cannot erase local
 * history beyond the cap. Net effect: restore never deletes data the backup
 * does not contain.
 */
export async function restoreFromBackup(payload: BackupPayload): Promise<void> {
  // IDB writes come first and the localStorage writes last, so an IDB failure
  // mid-restore leaves settings, profile and the backed-up flag untouched.

  // 1. Rehydrate IDB groups (overwrite per group; groups absent from the backup
  //    are left in place — restore adds/updates, never deletes).
  for (const group of payload.groups) {
    await saveGroup(group);
  }

  // 2. Rehydrate MLS state (base64-decoded; overwrite per key).
  const stateBackend = new IdbGroupStateBackend();
  for (const [key, b64] of Object.entries(payload.groupStates)) {
    const bytes = base64ToUint8Array(b64);
    await stateBackend.setItem(key, bytes as never);
  }

  // 3. Rehydrate member profiles (overwrite per group).
  for (const [groupId, profiles] of Object.entries(payload.memberProfiles)) {
    await saveMemberProfiles(groupId, profiles as never[]);
  }

  // 4. MERGE group chat messages by id. The backup truncates each group's chat
  //    to the most recent MAX_CHAT_MESSAGES, so overwriting would erase local
  //    history beyond the cap. Union the backup messages with whatever is
  //    already stored (local wins on id collision), sorted chronologically. DM
  //    threads (`few:messages:dm:*`) are not in the payload and are untouched.
  const { get: idbGet, set: idbSet } = await import('idb-keyval');
  for (const [groupId, backupMessages] of Object.entries(payload.chatMessages)) {
    const key = `few:messages:${groupId}`;
    const existing = (await idbGet<ChatMessage[]>(key)) ?? [];
    const byId = new Map<string, ChatMessage>();
    for (const m of existing) byId.set(m.id, m);
    for (const m of backupMessages as ChatMessage[]) {
      if (!byId.has(m.id)) byId.set(m.id, m);
    }
    const merged = Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
    await idbSet(key, merged);
  }

  // 5. Rehydrate invite links (overwrite per link).
  if (payload.inviteLinks) {
    for (const link of payload.inviteLinks) {
      await saveInviteLink(link);
    }
  }

  // 6. Rehydrate localStorage — overwrite in place; all other keys (contacts,
  //    knownPeers, relays, signerMode, identity, …) are preserved.
  if (payload.settings) {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(payload.settings));
  }
  if (payload.userProfile) {
    localStorage.setItem(STORAGE_KEYS.userProfile, JSON.stringify(payload.userProfile));
  }

  // 7. Mark identity as backed up.
  localStorage.setItem(STORAGE_KEYS.nostrBackedUp, 'true');
}

// ---------------------------------------------------------------------------
// S4: Backup scheduler with debounce
// ---------------------------------------------------------------------------

/** Minimum interval between successful backup publishes (5 minutes). */
const DEBOUNCE_MS = 5 * 60 * 1000;

/** Delays before each retry after a failed publish; the last one repeats. */
const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];

/** Retries after a failure before giving up until the next change. */
const MAX_RETRIES = 5;

/**
 * Delay of the one extra, early retry after a failure before this scheduler's
 * first successful publish (bug: first-relay-backup-cold-start-retry). It
 * fires on the first failure before any success, whenever that happens; the
 * case it is for is start-up, when the relays may still be connecting and an
 * attempt can fail on NDK's tight timeouts (connect 2.5 s, relay-list fetch
 * 8 s, publish 2.5 s) — waiting the regular 30 s would leave a fresh session
 * without a backup for long. It is granted once per scheduler, does not consume the retry budget,
 * and the regular schedule (RETRY_DELAYS_MS) follows unchanged.
 */
const COLD_START_RETRY_MS = 5 * 1000;

/**
 * Debounces backup publishes and retries failed ones.
 *
 * `publishFn` reports failure by resolving `false` or rejecting; anything else
 * counts as success. The debounce window runs from the last *successful*
 * publish; after a failure, retries follow their own backoff and further
 * changes wait for the pending retry rather than bypassing it. The first
 * failure before any success gets one extra early retry (COLD_START_RETRY_MS)
 * ahead of that backoff.
 */
export class BackupScheduler {
  private publishFn: () => Promise<boolean | void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPublishAt = 0;
  private disposed = false;
  private inFlight = false;
  private dirtyDuringFlight = false;
  private retriesLeft = MAX_RETRIES;
  private retryPending = false;
  /** True until the first success, or until the early cold-start retry is spent. */
  private coldStart = true;

  constructor(publishFn: () => Promise<boolean | void>) {
    this.publishFn = publishFn;
  }

  /**
   * Mark the backup as dirty (state has changed).
   * If `immediate` is true, publish as soon as the debounce window allows.
   * Otherwise, schedule a publish after the debounce interval.
   */
  markDirty(immediate?: boolean): void {
    if (this.disposed) return;
    this.retriesLeft = MAX_RETRIES;

    if (this.inFlight) {
      // Publish again once the running attempt settles, so this change is not
      // lost. (Immediacy is moot: a success always opens the debounce window.)
      this.dirtyDuringFlight = true;
      return;
    }

    // After a failure, changes ride along with the pending retry: backoff is
    // not bypassed, so a relay outage is not hammered on every trigger.
    if (this.retryPending) return;

    // Clear any existing scheduled timer (debounce or retry)
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const elapsed = Date.now() - this.lastPublishAt;
    const remaining = DEBOUNCE_MS - elapsed;

    if (immediate && remaining <= 0) {
      // Can publish right now
      void this.doPublish();
    } else {
      // Schedule for when the debounce window expires
      const delay = remaining > 0 ? remaining : DEBOUNCE_MS;
      this.timer = setTimeout(() => void this.doPublish(), delay);
    }
  }

  /** Clean up timers. */
  dispose(): void {
    this.disposed = true;
    this.dirtyDuringFlight = false;
    this.retryPending = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async doPublish(): Promise<void> {
    this.timer = null;
    this.retryPending = false;
    this.inFlight = true;
    let ok: boolean;
    try {
      ok = (await this.publishFn()) !== false;
    } catch (err) {
      console.warn('[BackupScheduler] publish failed:', err);
      ok = false;
    }
    this.inFlight = false;
    if (this.disposed) return;

    if (ok) {
      this.lastPublishAt = Date.now();
      this.coldStart = false;
    }

    const pending = this.dirtyDuringFlight;
    this.dirtyDuringFlight = false;
    if (pending && ok) {
      this.markDirty();
      return;
    }
    // A change made during a failed attempt rides along with the retry (its
    // budget was already reset by markDirty) rather than bypassing the backoff.

    // A failed publish whose outcome is indeterminate (e.g. NDK's publish
    // timeout: a relay may still store it) is treated exactly like a refused
    // one — retried. Republishing is harmless: the backup is a replaceable
    // event, so a duplicate only replaces itself.
    if (!ok && this.coldStart) {
      this.coldStart = false;
      this.retryPending = true;
      this.timer = setTimeout(() => void this.doPublish(), COLD_START_RETRY_MS);
      return;
    }

    if (!ok && this.retriesLeft > 0) {
      const attempt = MAX_RETRIES - this.retriesLeft;
      this.retriesLeft--;
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      this.retryPending = true;
      this.timer = setTimeout(() => void this.doPublish(), delay);
    }
  }
}
