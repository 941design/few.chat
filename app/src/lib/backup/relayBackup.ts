/**
 * Relay backup — payload assembly, serialization, encryption, and publishing.
 *
 * Collects settings and the account profile from localStorage,
 * encrypts them with NIP-44 self-encryption,
 * and publishes/fetches it as a kind 30078 replaceable event.
 */

import { STORAGE_KEYS } from '@/src/types';
import { getEffectiveRelays } from '@/src/lib/relay';
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

export async function collectBackupPayload(): Promise<BackupPayload> {
  return {
    version: 1,
    createdAt: Math.floor(Date.now() / 1000),
    settings: readJsonItem<BackupPayload['settings']>(STORAGE_KEYS.settings),
    userProfile: readJsonItem<BackupPayload['userProfile']>(STORAGE_KEYS.userProfile),
  };
}

/** Kind 30078 is a parameterized replaceable event (NIP-78: application data). */
const BACKUP_EVENT_KIND = 30078;
const BACKUP_D_TAG = 'few';

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
 *
 * `mayPublish` is asked as the very last step, right before the network
 * publish (after collection and signing); when it says no the
 * event is dropped unpublished and the result is `{ ok: false, skipped: true }`
 * (not a failure to retry).
 */
export async function publishBackup(
  signer: EventSigner,
  pubkeyHex: string,
  ndk: NDK,
  mayPublish?: () => boolean,
): Promise<{ ok: boolean; error?: string; skipped?: true }> {
  try {
    const payload = await collectBackupPayload();
    const eventTemplate = await createBackupEvent(payload, signer, pubkeyHex);
    const signedEvent = await signer.signEvent(eventTemplate);

    const { NDKEvent, NDKRelaySet } = await import('@nostr-dev-kit/ndk');
    const relayUrls = getBackupRelays();
    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk);

    const ndkEvent = new NDKEvent(ndk);
    ndkEvent.kind = signedEvent.kind;
    ndkEvent.content = signedEvent.content;
    ndkEvent.tags = signedEvent.tags;
    ndkEvent.created_at = signedEvent.created_at;
    ndkEvent.pubkey = signedEvent.pubkey;
    ndkEvent.id = signedEvent.id;
    ndkEvent.sig = signedEvent.sig;

    // Signing may take long enough for a wipe or identity replacement.
    if (mayPublish && !mayPublish()) return { ok: false, skipped: true };
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

/** Parse the settings and profile from v1 backups, including those with retired group sections. */
export function parseBackupPayload(raw: unknown): BackupPayload | null {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.createdAt !== 'number') return null;

  const { settings, userProfile } = raw;
  if (settings != null && !isRecord(settings)) return null;
  if (userProfile != null && (!isRecord(userProfile) || typeof userProfile.nickname !== 'string')) return null;

  return {
    version: 1,
    createdAt: raw.createdAt,
    settings: (settings ?? null) as BackupPayload['settings'],
    userProfile: (userProfile ?? null) as BackupPayload['userProfile'],
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

export function getBackupRelays(): string[] {
  return getEffectiveRelays();
}

/** Look up and decrypt the identity's backup using the configured relays. */
export async function lookupBackup(privateKeyHex: string, pubkeyHex: string): Promise<BackupLookup> {
  try {
    const { createPrivateKeySigner } = await import('@/src/lib/marmot/signerAdapter');
    const ndk = await connectNdk(privateKeyHex);
    const relays = getBackupRelays();
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

/** Apply the backed-up settings and own profile alongside existing device data. */
export async function restoreFromBackup(payload: BackupPayload): Promise<void> {
  if (payload.settings) {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(payload.settings));
  }
  if (payload.userProfile) {
    localStorage.setItem(STORAGE_KEYS.userProfile, JSON.stringify(payload.userProfile));
  }

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
 * attempt can fail on NDK's tight connection and publish timeouts — waiting the regular 30 s would leave a fresh session
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
