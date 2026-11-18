/**
 * groupGates.ts — roster and admin gates for the handlers, read from the LIVE
 * library group handle (`group.members()` / `group.admins`), never from the
 * app's overlay (architecture.md boundary rule, AC-HIST-11).
 *
 * The group handle comes from an injected `groupOf(groupId)` (backed by
 * `client.groups.get`; reading `groups.get` inside a sink call is safe because
 * the library starts its history drain only after the group runtime is cached).
 *
 *   - `groupOf` resolves `undefined` (the group is no longer held): the gate
 *     FAILS CLOSED — nobody is a member or admin, so the gated effect is not
 *     applied and nothing throws (the sink then marks the row dispatched).
 *   - `groupOf` (or an accessor) rejects/throws: the gate rejects. The handler
 *     must let that propagate so the row stays undispatched and the library
 *     retries; swallowing it would turn a transient failure into a permanent
 *     drop of the gated effect.
 *
 * Pure module: no React, no context, no client construction.
 */
import type { GroupAdminsProvider } from '@/src/lib/messageEdits/api';

/** The part of the library group handle the gates read (both live, synchronous accessors). */
export interface GateGroup {
  members(): readonly string[];
  readonly admins: readonly string[];
}

/** Resolves a held group, or `undefined` when the group is no longer held. */
export type GroupOf = (groupId: string) => Promise<GateGroup | undefined>;

interface GroupGates {
  /** True iff `pubkeyHex` is a current admin of the group (live `group.admins`). */
  isGroupAdmin: (groupId: string, pubkeyHex: string) => Promise<boolean>;
  /** True iff `pubkeyHex` is a current member of the group (live `group.members()`). */
  isGroupMember: (groupId: string, pubkeyHex: string) => Promise<boolean>;
  /** The group's current admins (lowercase hex); `[]` when the group is not held. */
  adminsOf: (groupId: string) => Promise<string[]>;
}

const lower = (hex: string): string => (typeof hex === 'string' ? hex.toLowerCase() : '');

export function createGroupGates(groupOf: GroupOf): GroupGates {
  if (typeof groupOf !== 'function') throw new TypeError('createGroupGates: required port "groupOf" is missing or not a function');
  const adminsOf = async (groupId: string): Promise<string[]> => {
    const group = await groupOf(groupId);
    return group ? group.admins.map(lower) : [];
  };
  return {
    adminsOf,
    async isGroupAdmin(groupId, pubkeyHex) {
      const who = lower(pubkeyHex);
      return who.length > 0 && (await adminsOf(groupId)).includes(who);
    },
    async isGroupMember(groupId, pubkeyHex) {
      const who = lower(pubkeyHex);
      if (who.length === 0) return false;
      const group = await groupOf(groupId);
      return group ? group.members().some((m) => lower(m) === who) : false;
    },
  };
}

/**
 * The provider the delete/edit core consults for the admin-only delete of a
 * group announcement (`messageEdits.registerGroupAdminsProvider`), backed by
 * the live `group.admins`. The core itself fails closed when this rejects.
 */
export function createGroupAdminsProvider(groupOf: GroupOf): GroupAdminsProvider {
  return createGroupGates(groupOf).adminsOf;
}
