/** IndexedDB-backed app overlays for groups and member profiles. */
import { createStore, get, set, del, keys, clear } from 'idb-keyval';
import type { Group, MemberProfile } from '@/src/types';
import { clearProfileRequestMemos } from '@/src/lib/marmot/profileRequestStorage';
import { clearAllPendingDirectInvites } from '@/src/lib/marmot/pendingDirectInviteStorage';
import { sanitizeStoredAvatar } from '@/src/lib/dmProfile/kinds';
// ---------------------------------------------------------------------------
// IDB stores (separate IDB object stores for isolation)
// ---------------------------------------------------------------------------

const groupMetaStore = createStore('few-groups-meta', 'groups');
const memberProfileStore = createStore('few-member-profiles', 'profiles');
const groupKey = (id: string, owner?: string) => owner ? `${owner}:${id}` : id;

// ---------------------------------------------------------------------------
// Group metadata (name, members, relays) — our own overlay, not MLS state
// ---------------------------------------------------------------------------

export async function saveGroup(group: Group): Promise<void> {
  await set(groupKey(group.id, group.accountPubkey), group, groupMetaStore);
  if (!group.accountPubkey) return;
  const previous = await get<Group>(group.id, groupMetaStore);
  if (previous && (!previous.accountPubkey || previous.accountPubkey === group.accountPubkey)) {
    await del(group.id, groupMetaStore);
  }
}

export async function loadGroup(id: string, owner?: string): Promise<Group | undefined> {
  const current = await get<Group>(groupKey(id, owner), groupMetaStore);
  if (current || !owner) return current;
  const previous = await get<Group>(id, groupMetaStore);
  return previous && (!previous.accountPubkey || previous.accountPubkey === owner) ? previous : undefined;
}

export async function loadAllGroups(): Promise<Group[]> {
  const groupKeys = await keys<string>(groupMetaStore);
  const groups = await Promise.all(
    groupKeys.map((k) => get<Group>(k, groupMetaStore))
  );
  return groups.filter((g): g is Group => g !== undefined);
}

/** Whether another account has an explicit owner-scoped overlay for this group. */
export async function hasOtherGroupOwner(id: string, owner: string): Promise<boolean> {
  const groupKeys = await keys<string>(groupMetaStore);
  const suffix = `:${id}`;
  const candidates = groupKeys.filter((key) => typeof key === 'string' && key.endsWith(suffix));
  const groups = await Promise.all(candidates.map((key) => get<Group>(key, groupMetaStore)));
  return groups.some((group, index) => !!group?.accountPubkey && group.id === id &&
    candidates[index] === groupKey(id, group.accountPubkey) &&
    group.accountPubkey.toLowerCase() !== owner.toLowerCase());
}

export async function deleteGroup(id: string, owner?: string): Promise<void> {
  await del(groupKey(id, owner), groupMetaStore);
  if (!owner) return;
  const previous = await get<Group>(id, groupMetaStore);
  if (previous && (!previous.accountPubkey || previous.accountPubkey === owner)) await del(id, groupMetaStore);
}

export async function clearAllGroupMeta(): Promise<void> {
  await clear(groupMetaStore);
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

export async function clearAllGroupData(sponsorPubkey?: string): Promise<void> {
  await clear(groupMetaStore);
  await clear(memberProfileStore);
  await clearProfileRequestMemos('*'); // clear all — groupId filter handled internally
  if (sponsorPubkey === undefined) await clearAllPendingDirectInvites();
  else await clearAllPendingDirectInvites(sponsorPubkey);
}
