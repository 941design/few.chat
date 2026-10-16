/**
 * IndexedDB-backed group state storage using idb-keyval.
 *
 * Stores:
 * - Group metadata list (name, members, relays) in 'few_groups_v1'
 * - MLS group state bytes (passed directly to MarmotClient as groupStateStore)
 * - KeyPackage private material (passed directly as keyPackageStore)
 */

import { createStore, get, set, del, keys, clear } from 'idb-keyval';
import type { Group, MemberProfile } from '@/src/types';
import type { StoredKeyPackage, SerializedClientState } from '@internet-privacy/marmot-ts';
import { clearProfileRequestMemos } from '@/src/lib/marmot/profileRequestStorage';
import { clearAllPendingDirectInvites } from '@/src/lib/marmot/pendingDirectInviteStorage';
import { clearAllRumorJournal } from '@/src/lib/marmot/rumorJournal';
import { clearAllLeftGroupTombstones } from '@/src/lib/marmot/leftGroupTombstones';
import { clearAllPendingRemovals } from '@/src/lib/marmot/pendingRemovalStorage';
import { postStoreChanged } from '@/src/lib/crossTab';
import { sanitizeStoredAvatar } from '@/src/lib/dmProfile/kinds';
// KeyValueStoreBackend is an internal utility type — import directly from subpath
type KeyValueStoreBackend<T> = {
  getItem(key: string): Promise<T | null>;
  setItem(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
};

// ---------------------------------------------------------------------------
// IDB stores (separate IDB object stores for isolation)
// ---------------------------------------------------------------------------

const groupMetaStore = createStore('few-groups-meta', 'groups');
const groupStateStore = createStore('few-groups-state', 'state');
const keyPackageStore = createStore('few-keypackages', 'keypackages');
const memberProfileStore = createStore('few-member-profiles', 'profiles');

// ---------------------------------------------------------------------------
// Group metadata (name, members, relays) — our own overlay, not MLS state
// ---------------------------------------------------------------------------

export async function saveGroup(group: Group): Promise<void> {
  await set(group.id, group, groupMetaStore);
  postStoreChanged('groups', group.id);
}

export async function loadGroup(id: string): Promise<Group | undefined> {
  return get<Group>(id, groupMetaStore);
}

export async function loadAllGroups(): Promise<Group[]> {
  const groupKeys = await keys<string>(groupMetaStore);
  const groups = await Promise.all(
    groupKeys.map((k) => get<Group>(k, groupMetaStore))
  );
  return groups.filter((g): g is Group => g !== undefined);
}

export async function deleteGroup(id: string): Promise<void> {
  await del(id, groupMetaStore);
  postStoreChanged('groups', id);
}

export async function clearAllGroupMeta(): Promise<void> {
  await clear(groupMetaStore);
  postStoreChanged('groups');
}

// ---------------------------------------------------------------------------
// Member profiles
// ---------------------------------------------------------------------------

const memberProfileKey = (groupId: string) => `group:${groupId}`;

export async function loadMemberProfiles(groupId: string): Promise<MemberProfile[]> {
  const stored = await get<unknown>(memberProfileKey(groupId), memberProfileStore);
  if (!Array.isArray(stored)) return [];
  // Bug stored-group-avatars-not-resanitized: rows stored before the avatar-URL
  // check are re-validated on every read (drop an unsafe avatar, keep the rest
  // of the profile). The next write through mergeMemberProfile persists the
  // sanitized row.
  return stored.map((p) =>
    p && typeof p === 'object' ? { ...(p as MemberProfile), avatar: sanitizeStoredAvatar((p as MemberProfile).avatar) } : p,
  ) as MemberProfile[];
}

export async function saveMemberProfiles(groupId: string, profiles: MemberProfile[]): Promise<void> {
  await set(memberProfileKey(groupId), profiles, memberProfileStore);
}

/**
 * Merge an incoming MemberProfile using last-writer-wins by updatedAt timestamp.
 * Returns true if the incoming profile was newer and replaced/added the stored one;
 * false if the stored profile was equally or more recent (no update performed).
 */
export async function mergeMemberProfile(
  groupId: string,
  profile: MemberProfile
): Promise<boolean> {
  const existing = await loadMemberProfiles(groupId);
  const idx = existing.findIndex((p) => p.pubkeyHex === profile.pubkeyHex);

  if (idx === -1) {
    existing.push(profile);
  } else {
    // LWW by ISO timestamp; preserve signedEvent if incoming has none
    if (profile.updatedAt > existing[idx].updatedAt) {
      existing[idx] = {
        ...profile,
        ...(profile.signedEvent ? {} : { signedEvent: existing[idx].signedEvent }),
      };
    } else {
      return false; // stored profile is equally or more recent — no-op, zero IDB write (AC-039)
    }
  }

  await saveMemberProfiles(groupId, existing);
  return true;
}

export async function clearMemberProfiles(groupId: string): Promise<void> {
  await del(memberProfileKey(groupId), memberProfileStore);
}

/**
 * Remove a single member's profile entry from a group's stored profile list.
 * Mirrors mergeMemberProfile's read-filter-rewrite pattern: only writes back
 * to IDB when the target pubkey was actually present (no-op-write avoidance).
 * Never throws when the pubkey has no stored entry, or when the group has no
 * stored profiles at all.
 */
export async function deleteMemberProfile(groupId: string, pubkey: string): Promise<void> {
  const existing = await loadMemberProfiles(groupId);
  const filtered = existing.filter((p) => p.pubkeyHex.toLowerCase() !== pubkey.toLowerCase());

  if (filtered.length !== existing.length) {
    await saveMemberProfiles(groupId, filtered);
  }
}

// ---------------------------------------------------------------------------
// Clear all group data (for resetAllData)
// ---------------------------------------------------------------------------

export async function clearAllGroupData(): Promise<void> {
  await clear(groupMetaStore);
  await clear(groupStateStore);
  await clear(keyPackageStore);
  await clear(memberProfileStore);
  await clearProfileRequestMemos('*'); // clear all — groupId filter handled internally
  await clearAllPendingDirectInvites();
  // Write-ahead rumor journal (rumorJournal.ts): decrypted plaintext of the
  // previous identity's groups must not survive an account clear.
  await clearAllRumorJournal();
  // Left-group tombstones (leftGroupTombstones.ts) belong to the previous
  // identity's groups; its MLS state was cleared above.
  await clearAllLeftGroupTombstones();
  // Durable pending member removals (pendingRemovalStorage.ts) name members of
  // the previous identity's groups.
  await clearAllPendingRemovals();
}

// ---------------------------------------------------------------------------
// KeyValueStoreBackend implementations for marmot-ts
// ---------------------------------------------------------------------------

/** MLS group state backend backed by IndexedDB */
export class IdbGroupStateBackend implements KeyValueStoreBackend<SerializedClientState> {
  async getItem(key: string): Promise<SerializedClientState | null> {
    return (await get<SerializedClientState>(key, groupStateStore)) ?? null;
  }

  async setItem(key: string, value: SerializedClientState): Promise<SerializedClientState> {
    await set(key, value, groupStateStore);
    return value;
  }

  async removeItem(key: string): Promise<void> {
    await del(key, groupStateStore);
  }

  async clear(): Promise<void> {
    await clear(groupStateStore);
  }

  async keys(): Promise<string[]> {
    return keys<string>(groupStateStore);
  }
}

/** KeyPackage private material backend backed by IndexedDB */
export class IdbKeyPackageBackend implements KeyValueStoreBackend<StoredKeyPackage> {
  async getItem(key: string): Promise<StoredKeyPackage | null> {
    return (await get<StoredKeyPackage>(key, keyPackageStore)) ?? null;
  }

  async setItem(key: string, value: StoredKeyPackage): Promise<StoredKeyPackage> {
    await set(key, value, keyPackageStore);
    return value;
  }

  async removeItem(key: string): Promise<void> {
    await del(key, keyPackageStore);
  }

  async clear(): Promise<void> {
    await clear(keyPackageStore);
  }

  async keys(): Promise<string[]> {
    return keys<string>(keyPackageStore);
  }
}
