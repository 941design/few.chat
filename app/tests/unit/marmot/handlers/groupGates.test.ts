// @vitest-environment node
/**
 * groupGates.ts: the live-accessor roster/admin gates behind groupOf (AC-HIST-11).
 */
import { describe, expect, it, vi } from 'vitest';
import { createGroupAdminsProvider, createGroupGates, type GateGroup, type GroupOf } from '@/src/lib/marmot/handlers/groupGates';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);

const held = (members: string[], admins: string[]): GroupOf => async () => ({ members: () => members, admins }) as GateGroup;

describe('createGroupGates', () => {
  it('answers from the live accessors, case-insensitively', async () => {
    const gates = createGroupGates(held([A, B.toUpperCase()], [A.toUpperCase()]));
    expect(await gates.isGroupMember('g', A)).toBe(true);
    expect(await gates.isGroupMember('g', B)).toBe(true);
    expect(await gates.isGroupMember('g', C)).toBe(false);
    expect(await gates.isGroupAdmin('g', A)).toBe(true);
    expect(await gates.isGroupAdmin('g', B)).toBe(false);
    expect(await gates.adminsOf('g')).toEqual([A]);
  });

  it('reads the accessors at every call (a roster change is seen at once)', async () => {
    const members = [A];
    const gates = createGroupGates(async () => ({ members: () => members, admins: [] }));
    expect(await gates.isGroupMember('g', B)).toBe(false);
    members.push(B);
    expect(await gates.isGroupMember('g', B)).toBe(true);
  });

  it('fails closed when the group is no longer held, and for an empty key', async () => {
    const gates = createGroupGates(async () => undefined);
    expect(await gates.isGroupMember('g', A)).toBe(false);
    expect(await gates.isGroupAdmin('g', A)).toBe(false);
    expect(await gates.adminsOf('g')).toEqual([]);
    const live = createGroupGates(held([A], [A]));
    expect(await live.isGroupMember('g', '')).toBe(false);
    expect(await live.isGroupAdmin('g', '')).toBe(false);
  });

  it('propagates a groupOf rejection and an accessor failure (the handler must reject, never read it as "no")', async () => {
    const failing = createGroupGates(vi.fn().mockRejectedValue(new Error('groups.get failed')));
    await expect(failing.isGroupAdmin('g', A)).rejects.toThrow('groups.get failed');
    await expect(failing.isGroupMember('g', A)).rejects.toThrow('groups.get failed');
    const throwing = createGroupGates(async () => ({ members: () => { throw new Error('state gone'); }, admins: [] }));
    await expect(throwing.isGroupMember('g', A)).rejects.toThrow('state gone');
  });

  it('refuses construction without a groupOf function', () => {
    expect(() => createGroupGates(undefined as never)).toThrow(/"groupOf"/);
  });
});

describe('createGroupAdminsProvider', () => {
  it('is the live admin list (lowercase hex) or [] when the group is not held', async () => {
    expect(await createGroupAdminsProvider(held([], [A.toUpperCase(), B]))('g')).toEqual([A, B]);
    expect(await createGroupAdminsProvider(async () => undefined)('g')).toEqual([]);
  });
});
