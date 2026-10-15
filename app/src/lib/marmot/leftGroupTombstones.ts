/**
 * Left-group tombstones (bug: left-groups-keep-mls-state-forever).
 *
 * Leaving a group purges its overlay record at once, but its MLS state (keys,
 * history, snapshots) is destroyed only after the departure announcement has
 * been sent (leaveGroupImpl). A tombstone `{groupId, leftAt}` is written
 * BEFORE the overlay is deleted and removed once the MLS state is destroyed,
 * so an interruption anywhere in between (reload, crash, failed destroy) is
 * finished by the startup sweep (welcomeSubscription.sweepLeftGroups).
 *
 * The tombstone is the sweep's discriminator: "MLS state, no overlay" alone
 * also describes an interrupted create or an in-flight accept, which must not
 * be destroyed — only a tombstoned group is.
 *
 * Local-only, per-device: never part of the relay backup (relayBackup reads
 * it only to EXCLUDE tombstoned groups' MLS state), never published, and
 * cleared by clearAllGroupData.
 */

import { createStore, set, del, entries, clear } from 'idb-keyval';

export type LeftGroupTombstone = { groupId: string; leftAt: number };

const tombstoneStore = createStore('few-left-groups', 'tombstones');

export async function putLeftGroupTombstone(groupId: string, leftAt: number = Date.now()): Promise<void> {
  const row: LeftGroupTombstone = { groupId, leftAt };
  await set(groupId, row, tombstoneStore);
}

export async function deleteLeftGroupTombstone(groupId: string): Promise<void> {
  await del(groupId, tombstoneStore);
}

function isTombstone(key: IDBValidKey, value: unknown): value is LeftGroupTombstone {
  const row = value as Partial<LeftGroupTombstone> | null | undefined;
  return row?.groupId === key && typeof row.leftAt === 'number';
}

/** All well-formed tombstones; malformed rows are ignored. */
export async function listLeftGroupTombstones(): Promise<LeftGroupTombstone[]> {
  const rows = await entries<IDBValidKey, unknown>(tombstoneStore);
  return rows
    .filter(([key, value]) => isTombstone(key, value))
    .map(([, value]) => {
      const { groupId, leftAt } = value as LeftGroupTombstone;
      return { groupId, leftAt };
    });
}

export async function listLeftGroupIds(): Promise<Set<string>> {
  return new Set((await listLeftGroupTombstones()).map((t) => t.groupId));
}

/** Account-scoped clear (clearAllGroupData). */
export async function clearAllLeftGroupTombstones(): Promise<void> {
  await clear(tombstoneStore);
}
