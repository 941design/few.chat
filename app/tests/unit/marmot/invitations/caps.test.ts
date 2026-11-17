/**
 * AC-CAP-1 (unit, stubbed pending list, injected clock and trust predicate): trust-ordered retention.
 * Caps 256 total / 8 per inviter equal to lib/pendingInvitations.ts; stranger TTL 14 days; trusted never expire;
 * a stranger never blocks a trusted invitation; every excess declined silently ({declineRumor:false}).
 */
import { describe, expect, it } from 'vitest';
import type { PendingInvitation } from '@941design/marmot';
import { GLOBAL_CAP, PER_INVITER_CAP } from '@/src/lib/pendingInvitations';
import {
  applyPendingCaps,
  createDenyLayer,
  createPendingInvitationView,
  createTrustedSponsorPredicate,
  PENDING_PER_INVITER_CAP,
  PENDING_TOTAL_CAP,
  STRANGER_INVITATION_TTL_MS,
  type CapContext,
} from '@/src/lib/marmot/invitations';

const DAY = 86_400_000;
const NOW = 1_000 * DAY;
const hex = (n: number) => n.toString(16).padStart(64, '0');
/** Trusted sponsors in these tests are those numbered >= 10_000. */
const TRUSTED_FROM = 10_000;
const isTrusted = (s: string) => parseInt(s.slice(-8), 16) >= TRUSTED_FROM;
const inv = (n: number, sponsor: number, receivedAt = n): PendingInvitation => ({
  id: `inv-${String(n).padStart(5, '0')}`,
  groupId: `g${n}`,
  sponsorAccount: hex(sponsor),
  sponsors: [hex(sponsor)],
  keyPackageRef: `kp${n}`,
  receivedAt,
});
const ctx = (over: Partial<CapContext> = {}): CapContext => ({ isTrusted, now: NOW, ...over });
const ids = (l: Array<{ id: string }>) => l.map((i) => i.id);

function stubInvitations(list: PendingInvitation[]) {
  const declines: Array<{ id: string; options?: { declineRumor?: boolean } }> = [];
  return {
    declines,
    api: {
      pending: async () => list.filter((i) => !declines.some((d) => d.id === i.id)),
      decline: async (id: string, options?: { readonly declineRumor?: boolean }) => {
        declines.push({ id, options });
      },
    },
  };
}

function makeView(api: ReturnType<typeof stubInvitations>['api'], over: { trusted?: (s: string) => boolean; clock?: () => number; blocked?: Set<string> } = {}) {
  return createPendingInvitationView({
    invitations: api,
    denyLayer: createDenyLayer({ loadBlockedPeers: () => over.blocked ?? new Set() }),
    enqueue: (j) => void j(),
    isTrustedSponsor: over.trusted ?? isTrusted,
    now: over.clock ?? (() => NOW),
    onError: (e) => { throw e; },
  });
}

describe('AC-CAP-1: constants', () => {
  it('256 / 8 equal the old module constants; TTL is 14 days', () => {
    expect(PENDING_TOTAL_CAP).toBe(256);
    expect(PENDING_PER_INVITER_CAP).toBe(8);
    expect(PENDING_TOTAL_CAP).toBe(GLOBAL_CAP);
    expect(PENDING_PER_INVITER_CAP).toBe(PER_INVITER_CAP);
    expect(STRANGER_INVITATION_TTL_MS).toBe(14 * 86_400_000);
  });
});

describe('AC-CAP-1: total cap among strangers', () => {
  it('257 strangers (distinct inviters): the newest is declined, 256 retained, silently', async () => {
    const list = Array.from({ length: 257 }, (_, i) => inv(i + 1, i + 1, NOW - 1000 + i));
    const s = stubInvitations(list);
    const v = makeView(s.api);
    const shown = await v.refresh();
    expect(shown).toHaveLength(256);
    expect(s.declines).toEqual([{ id: 'inv-00257', options: { declineRumor: false } }]);
    expect(v.pending().map((i) => i.id)).toEqual(ids(shown));
  });

  it('exactly 256 are all retained, nothing declined; list order is irrelevant', () => {
    const list = Array.from({ length: 256 }, (_, i) => inv(i + 1, i + 1, NOW - 1000 + i));
    expect(applyPendingCaps(list, ctx()).excess).toEqual([]);
    const l257 = [...list, inv(257, 257, NOW - 1)].reverse();
    expect(ids(applyPendingCaps(l257, ctx()).excess)).toEqual(['inv-00257']);
  });
});

describe('AC-CAP-1: per-inviter cap', () => {
  it.each([
    ['stranger', 1],
    ['trusted', TRUSTED_FROM + 1],
  ])('9 from one %s inviter: the 9th is declined, 8 retained, others unaffected', (_n, sponsor) => {
    const list = [...Array.from({ length: 9 }, (_, i) => inv(i + 1, sponsor, NOW - 100 + i)), inv(100, 2, NOW - 5)];
    const { retained, excess } = applyPendingCaps(list, ctx());
    expect(ids(excess)).toEqual(['inv-00009']);
    expect(retained.filter((i) => i.sponsorAccount === hex(sponsor))).toHaveLength(8);
    expect(ids(retained)).toContain('inv-00100');
  });

  it('the per-inviter excess uses no total room', () => {
    // 32 inviters x 8 = 256 fill the total; a 9th from inviter 1 is excess, and 224 others + 8 of inviter 1 ... stays 256 with no stranger displaced
    const list = Array.from({ length: 32 * 8 }, (_, i) => inv(i + 1, 1 + Math.floor(i / 8), NOW - 5000 + i));
    const extra = Array.from({ length: 5 }, (_, i) => inv(1000 + i, 1, NOW - 10 + i));
    const { retained, excess } = applyPendingCaps([...list, ...extra], ctx());
    expect(retained).toHaveLength(256);
    expect(ids(excess).sort()).toEqual(ids(extra).sort());
  });

  it('inviter and trust comparison ignore hex case', () => {
    const upper = hex(TRUSTED_FROM + 5).toUpperCase();
    const mixed = Array.from({ length: 9 }, (_, i) => ({ ...inv(i + 1, 10), sponsorAccount: i % 2 ? upper : hex(TRUSTED_FROM + 5) }));
    expect(ids(applyPendingCaps(mixed, ctx()).excess)).toEqual(['inv-00009']);
    const seen: string[] = [];
    applyPendingCaps(mixed, ctx({ isTrusted: (s) => (seen.push(s), true) }));
    expect(seen.every((s) => s === s.toLowerCase())).toBe(true);
  });
});

describe('AC-CAP-1: trust ordering', () => {
  const strangers32x8 = () => Array.from({ length: 256 }, (_, i) => inv(i + 1, 1 + Math.floor(i / 8), NOW - 5000 + i));

  it('32 inviters x 8 strangers then one trusted: the trusted is retained, the newest stranger displaced, total 256', () => {
    const trusted = inv(900, TRUSTED_FROM + 1, NOW - 1);
    const { retained, excess } = applyPendingCaps([...strangers32x8(), trusted], ctx());
    expect(retained).toHaveLength(256);
    expect(ids(retained)).toContain('inv-00900');
    expect(ids(excess)).toEqual(['inv-00256']);
  });

  it('a trusted invitation is retained regardless of its receivedAt (newest of all, and oldest)', () => {
    for (const at of [NOW, NOW - 12 * DAY, NOW + 5 * DAY]) {
      const { retained } = applyPendingCaps([...strangers32x8(), inv(900, TRUSTED_FROM + 1, at)], ctx());
      expect(ids(retained)).toContain('inv-00900');
    }
  });

  it('257 trusted: the newest trusted is declined and every stranger is declined', () => {
    const trusted = Array.from({ length: 257 }, (_, i) => inv(i + 1, TRUSTED_FROM + 1 + i, NOW - 5000 + i));
    const strangers = Array.from({ length: 4 }, (_, i) => inv(2000 + i, 1 + i, NOW - 9000 + i));
    const { retained, excess } = applyPendingCaps([...strangers, ...trusted], ctx());
    expect(retained).toHaveLength(256);
    expect(ids(retained)).not.toContain('inv-00257');
    expect(ids(excess).sort()).toEqual(['inv-00257', ...ids(strangers)].sort());
  });
});

describe('AC-CAP-1: stranger TTL', () => {
  it('exactly 14 days is retained, 14 days + 1 ms is expired', () => {
    const edge = inv(1, 1, NOW - STRANGER_INVITATION_TTL_MS);
    const over = inv(2, 2, NOW - STRANGER_INVITATION_TTL_MS - 1);
    const { retained, excess } = applyPendingCaps([edge, over], ctx());
    expect(ids(retained)).toEqual(['inv-00001']);
    expect(ids(excess)).toEqual(['inv-00002']);
  });

  it('a trusted invitation never expires (15 days, 10 years)', () => {
    const list = [inv(1, TRUSTED_FROM + 1, NOW - 15 * DAY), inv(2, TRUSTED_FROM + 2, NOW - 3650 * DAY)];
    expect(applyPendingCaps(list, ctx())).toEqual({ retained: [list[1], list[0]], excess: [] });
  });

  it('expired strangers free room: 256 fresh + expired ones never displace anything fresh', () => {
    const fresh = Array.from({ length: 256 }, (_, i) => inv(i + 1, 1 + Math.floor(i / 8), NOW - 5000 + i));
    const expired = Array.from({ length: 10 }, (_, i) => inv(1000 + i, 500 + i, NOW - 20 * DAY));
    const { retained, excess } = applyPendingCaps([...fresh, ...expired], ctx());
    expect(retained).toHaveLength(256);
    expect(ids(excess).sort()).toEqual(ids(expired).sort());
    // and with fewer fresh, a new stranger fits where expired ones would have taken room
    const fewer = fresh.slice(0, 255);
    const newer = inv(2000, 900, NOW - 1);
    expect(ids(applyPendingCaps([...fewer, ...expired, newer], ctx()).retained)).toContain('inv-02000');
  });
});

describe('AC-CAP-1: retention stability (already shown entries keep their place)', () => {
  it('cap full of shown strangers, a new stranger with a SMALLER receivedAt is the excess', () => {
    const shown = Array.from({ length: 256 }, (_, i) => inv(i + 1, 1 + Math.floor(i / 8), NOW - 5000 + i));
    const arrival = inv(900, 999, NOW - 9000);
    const split = applyPendingCaps([arrival, ...shown], ctx({ keepFirst: new Set(ids(shown)) }));
    expect(ids(split.excess)).toEqual(['inv-00900']);
    // without the shown-set the older arrival would win (documents what keepFirst changes)
    expect(ids(applyPendingCaps([arrival, ...shown], ctx()).excess)).toEqual(['inv-00256']);
  });

  it('the same holds per inviter', () => {
    const shown = Array.from({ length: 8 }, (_, i) => inv(i + 1, 1, NOW - 100 + i));
    const arrival = inv(50, 1, NOW - 500);
    expect(ids(applyPendingCaps([arrival, ...shown], ctx({ keepFirst: new Set(ids(shown)) })).excess)).toEqual(['inv-00050']);
  });

  it('a trusted arrival still displaces the newest retained stranger', () => {
    const shown = Array.from({ length: 256 }, (_, i) => inv(i + 1, 1 + Math.floor(i / 8), NOW - 5000 + i));
    const trusted = inv(900, TRUSTED_FROM + 1, NOW - 9000);
    const split = applyPendingCaps([trusted, ...shown], ctx({ keepFirst: new Set(ids(shown)) }));
    expect(ids(split.excess)).toEqual(['inv-00256']);
  });
});

describe('applyPendingCaps properties (seeded random)', () => {
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  it('within caps, partition, idempotent, permutation-deterministic, trusted-first, stranger TTL', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const n = Math.floor(r() * 450);
      const list = Array.from({ length: n }, (_, i) =>
        inv(i + 1, r() < 0.3 ? TRUSTED_FROM + Math.floor(r() * 40) : 1 + Math.floor(r() * 60), NOW - Math.floor(r() * 20 * DAY)));
      const keep = new Set(list.filter(() => r() < 0.3).map((i) => i.id));
      const c = ctx({ keepFirst: keep });
      const { retained, excess } = applyPendingCaps(list, c);
      expect(retained.length).toBeLessThanOrEqual(256);
      const per = new Map<string, number>();
      for (const i of retained) per.set(i.sponsorAccount, (per.get(i.sponsorAccount) ?? 0) + 1);
      for (const k of per.values()) expect(k).toBeLessThanOrEqual(8);
      expect(ids([...retained, ...excess]).sort()).toEqual(ids(list).sort());
      for (const i of retained) expect(isTrusted(i.sponsorAccount) || NOW - i.receivedAt <= STRANGER_INVITATION_TTL_MS).toBe(true);
      expect(applyPendingCaps(retained, c)).toEqual({ retained, excess: [] });
      expect(ids(applyPendingCaps([...list].reverse(), c).retained)).toEqual(ids(retained));
      // a stranger is retained only if no trusted invitation was cut for total room
      if (retained.some((i) => !isTrusted(i.sponsorAccount))) {
        expect(excess.some((e) => isTrusted(e.sponsorAccount) && (per.get(e.sponsorAccount) ?? 0) < 8)).toBe(false);
      }
    }
  });
});

describe('createTrustedSponsorPredicate', () => {
  it('own account (any case) or a known peer; the known set is read on every call', () => {
    const known = new Set<string>();
    const t = createTrustedSponsorPredicate('AB'.repeat(32), (p) => known.has(p));
    expect(t('ab'.repeat(32))).toBe(true);
    expect(t('cd'.repeat(32))).toBe(false);
    known.add('cd'.repeat(32));
    expect(t('CD'.repeat(32))).toBe(true);
    expect(() => createTrustedSponsorPredicate('')).toThrow(TypeError);
  });
});

describe('AC-CAP-1: the view applies retention', () => {
  it('expired and over-cap entries get a silent decline and never an arrival', async () => {
    const list = [inv(1, 1, NOW - 20 * DAY)];
    const s = stubInvitations(list);
    const v = makeView(s.api);
    await v.seed();
    const arrivals: string[] = [];
    v.onArrival((i) => arrivals.push(i.id));
    list.push(inv(2, 2, NOW - 30 * DAY), ...Array.from({ length: 9 }, (_, i) => inv(10 + i, 3, NOW - 100 + i)));
    await v.refresh();
    expect(s.declines.map((d) => d.id).sort()).toEqual(['inv-00001', 'inv-00002', 'inv-00018']);
    expect(s.declines.every((d) => d.options?.declineRumor === false)).toBe(true);
    expect(arrivals).toHaveLength(8);
    expect(arrivals).not.toContain('inv-00018');
  });

  it('displacement: a trusted arrival into a full list fires onArrival and the displaced stranger is declined silently', async () => {
    const list = Array.from({ length: 256 }, (_, i) => inv(i + 1, 1 + Math.floor(i / 8), NOW - 5000 + i));
    const s = stubInvitations(list);
    const v = makeView(s.api);
    await v.seed();
    const arrivals: string[] = [];
    let changes = 0;
    v.onArrival((i) => arrivals.push(i.id));
    v.onChange(() => changes++);
    list.push(inv(900, TRUSTED_FROM + 1, NOW - 1));
    await v.refresh();
    expect(arrivals).toEqual(['inv-00900']);
    expect(s.declines).toEqual([{ id: 'inv-00256', options: { declineRumor: false } }]);
    expect(v.isVisible('inv-00900')).toBe(true);
    expect(v.isVisible('inv-00256')).toBe(false);
    expect(v.pending()).toHaveLength(256);
    expect(changes).toBe(1);
  });

  it('a sponsor promoted to known peer between refreshes is trusted next time (no cache)', async () => {
    const known = new Set<string>();
    const trusted = (s: string) => known.has(s);
    const list = Array.from({ length: 256 }, (_, i) => inv(i + 1, 1 + Math.floor(i / 8), NOW - 5000 + i));
    const late = inv(900, 777, NOW - 1);
    const s = stubInvitations(list);
    const v = makeView(s.api, { trusted });
    await v.seed();
    list.push(late);
    await v.refresh();
    expect(v.isVisible('inv-00900')).toBe(false); // stranger over the cap
    list.push(inv(901, 777, NOW - 1)); // same sponsor again, still stranger
    known.add(hex(778));
    list.push(inv(902, 778, NOW - 1));
    await v.refresh();
    expect(v.isVisible('inv-00902')).toBe(true);
  });

  it('a block beats trust', async () => {
    const s = stubInvitations([inv(1, TRUSTED_FROM + 1)]);
    const v = makeView(s.api, { blocked: new Set([hex(TRUSTED_FROM + 1)]) });
    expect(await v.refresh()).toEqual([]);
    expect(s.declines).toEqual([{ id: 'inv-00001', options: { declineRumor: false } }]);
  });

  it('a failed decline of an expired entry keeps it hidden and retries it on the next refresh', async () => {
    let fail = true;
    const attempts: string[] = [];
    const errors: unknown[] = [];
    const v = createPendingInvitationView({
      invitations: { pending: async () => [inv(1, 1, NOW - 20 * DAY)], decline: async (id) => { attempts.push(id); if (fail) throw new Error('x'); } },
      denyLayer: createDenyLayer({ loadBlockedPeers: () => new Set() }),
      enqueue: (j) => void j(),
      isTrustedSponsor: isTrusted,
      now: () => NOW,
      onError: (e) => errors.push(e),
    });
    expect(await v.refresh()).toEqual([]);
    fail = false;
    expect(await v.refresh()).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(attempts).toEqual(['inv-00001', 'inv-00001']);
  });

  it('the clock is read per refresh: an entry that was fresh expires later', async () => {
    let t = NOW;
    const s = stubInvitations([inv(1, 1, NOW - 13 * DAY)]);
    const v = makeView(s.api, { clock: () => t });
    expect(await v.refresh()).toHaveLength(1);
    t = NOW + 2 * DAY;
    expect(await v.refresh()).toHaveLength(0);
    expect(s.declines).toHaveLength(1);
  });

  it('missing isTrustedSponsor / now throws at construction', () => {
    const ok = { invitations: { pending: async () => [], decline: async () => undefined }, denyLayer: createDenyLayer({ loadBlockedPeers: () => new Set() }), enqueue: () => undefined, isTrustedSponsor: isTrusted, now: () => NOW };
    expect(() => createPendingInvitationView({ ...ok, isTrustedSponsor: undefined } as never)).toThrow(/isTrustedSponsor/);
    expect(() => createPendingInvitationView({ ...ok, now: undefined } as never)).toThrow(/now/);
  });

  it('retention stability in the view: a later arrival with a smaller receivedAt is the one declined', async () => {
    const list = Array.from({ length: 256 }, (_, i) => inv(i + 1, 1 + Math.floor(i / 8), NOW - 5000 + i));
    const s = stubInvitations(list);
    const v = makeView(s.api);
    await v.seed();
    list.push(inv(900, 999, NOW - 9000));
    await v.refresh();
    expect(s.declines).toEqual([{ id: 'inv-00900', options: { declineRumor: false } }]);
    expect(v.isVisible('inv-00256')).toBe(true);
  });
});
