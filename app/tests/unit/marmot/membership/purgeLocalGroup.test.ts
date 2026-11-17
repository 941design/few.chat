// @vitest-environment node
/**
 * S13 / AC-MEM-4 (purge contract of the GroupDataPurger seam), over recording fakes: ORDER, abort-before-delete on an
 * `abandon()` failure, overlay-last retry key, idempotence, shared in-flight run, re-join guard and construction-time
 * port validation. The real stores are exercised in purgeLocalGroup.realStores.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createGroupRemovalHandlers, createLocalGroupPurger, PurgeError, type AbandonableGroup, type PurgeLocalGroupDeps } from '@/src/lib/marmot/membership';

const OWN = 'a1'.repeat(32);
const BOB = 'b2'.repeat(32);
const G = 'ab'.repeat(32);

const DATA_STEPS = [
  'clearMessages',
  'clearMessageEdits',
  'clearReactions',
  'purgeHeldReactions',
  'clearPollData',
  'clearGroupMedia',
  'clearMemberProfiles',
  'clearProfileRequestMemos',
  'clearUnread',
  'clearPendingJoinRequests',
  'clearInviteLinks',
  'clearInviteExpiries',
  'clearPendingDirectInvites',
  'clearInviteContexts',
] as const;

function fixture(overrides: Partial<PurgeLocalGroupDeps> = {}, group: AbandonableGroup | undefined | 'absent' = undefined) {
  const trace: string[] = [];
  const live: { group: AbandonableGroup | undefined } = {
    group:
      group === 'absent'
        ? undefined
        : (group ?? {
            abandon: async () => {
              trace.push('abandon');
              live.group = undefined; // the library drops the group once abandoned
            },
          }),
  };
  const step = (name: string) => async () => void trace.push(name);
  const deps: PurgeLocalGroupDeps = {
    ownPubkey: OWN,
    getGroup: async () => {
      trace.push('getGroup');
      return live.group;
    },
    history: { purge: async () => void trace.push('history.purge') },
    tracker: { forgetGroup: () => void trace.push('tracker.forgetGroup') },
    clearMessages: step('clearMessages'),
    clearMessageEdits: step('clearMessageEdits'),
    clearReactions: step('clearReactions'),
    purgeHeldReactions: step('purgeHeldReactions'),
    clearPollData: step('clearPollData'),
    clearGroupMedia: step('clearGroupMedia'),
    clearMemberProfiles: step('clearMemberProfiles'),
    clearProfileRequestMemos: step('clearProfileRequestMemos'),
    clearUnread: () => void trace.push('clearUnread'),
    clearPendingJoinRequests: step('clearPendingJoinRequests'),
    clearInviteLinks: step('clearInviteLinks'),
    clearInviteExpiries: () => void trace.push('clearInviteExpiries'),
    clearPendingDirectInvites: step('clearPendingDirectInvites'),
    clearInviteContexts: step('clearInviteContexts'),
    removeOverlay: step('removeOverlay'),
    onPurged: () => void trace.push('onPurged'),
    onError: () => undefined,
    ...overrides,
  };
  return { deps, trace, live, purger: createLocalGroupPurger(deps) };
}

describe('purgeLocalGroup order and completeness', () => {
  it('forgets the tracker rows, abandons, purges the sink, deletes every app-side store, removes the overlay LAST, then reloads the UI', async () => {
    const { purger, trace } = fixture();
    await purger.purgeLocalGroup(G);
    expect(trace.slice(0, 4)).toEqual(['getGroup', 'tracker.forgetGroup', 'abandon', 'history.purge']);
    for (const name of DATA_STEPS) expect(trace, name).toContain(name);
    // exactly once each: the purge never double-deletes
    for (const name of [...DATA_STEPS, 'removeOverlay', 'abandon', 'history.purge']) expect(trace.filter((t) => t === name), name).toHaveLength(1);
    const overlayAt = trace.indexOf('removeOverlay');
    for (const name of DATA_STEPS) expect(trace.indexOf(name), name).toBeLessThan(overlayAt);
    expect(trace.at(-2)).toBe('removeOverlay');
    expect(trace.at(-1)).toBe('onPurged');
  });

  it('a group the library does not hold: no abandon, the sink and every app-side store are still purged', async () => {
    const { purger, trace } = fixture({}, 'absent');
    await purger.purgeLocalGroup(G);
    expect(trace).not.toContain('abandon');
    expect(trace).toContain('history.purge');
    for (const name of [...DATA_STEPS, 'removeOverlay']) expect(trace, name).toContain(name);
  });

  it('is idempotent: a second call after the library group is gone repeats only the harmless deletes and never throws', async () => {
    const { purger, trace } = fixture();
    await purger.purgeLocalGroup(G);
    trace.length = 0;
    await expect(purger.purgeLocalGroup(G)).resolves.toBeUndefined();
    expect(trace).not.toContain('abandon');
    expect(trace).toContain('removeOverlay');
  });

  it('abandon() on an already-gone group (library code not-a-member) is the goal state, not a failure', async () => {
    const gone = { abandon: async () => Promise.reject(Object.assign(new Error('left'), { code: 'not-a-member' })) };
    const { purger, trace } = fixture({}, gone);
    await expect(purger.purgeLocalGroup(G)).resolves.toBeUndefined();
    expect(trace).toContain('removeOverlay');
  });

  it('concurrent calls for one group share ONE run (event + startup check + finishing leave overlap)', async () => {
    const { purger, trace } = fixture();
    await Promise.all([purger.purgeLocalGroup(G), purger.purgeLocalGroup(G), purger.purgeLocalGroup(G)]);
    expect(trace.filter((t) => t === 'abandon')).toHaveLength(1);
    expect(trace.filter((t) => t === 'removeOverlay')).toHaveLength(1);
    // a call AFTER completion runs again (idempotent)
    await purger.purgeLocalGroup(G);
    expect(trace.filter((t) => t === 'removeOverlay')).toHaveLength(2);
  });

  it('different groups are independent runs', async () => {
    const { purger, trace } = fixture();
    await Promise.all([purger.purgeLocalGroup(G), purger.purgeLocalGroup('cd'.repeat(32))]);
    expect(trace.filter((t) => t === 'removeOverlay')).toHaveLength(2);
  });
});

describe('failure handling', () => {
  it('an abandon() failure ABORTS before any app-side deletion: the group stays intact (overlay kept) and PurgeError names the step', async () => {
    const boom = new Error('store closed');
    const { purger, trace } = fixture({}, { abandon: async () => Promise.reject(boom) });
    const failure = await purger.purgeLocalGroup(G).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PurgeError);
    expect((failure as PurgeError).failures).toEqual([{ step: 'abandon', error: boom }]);
    for (const name of [...DATA_STEPS, 'removeOverlay', 'history.purge']) expect(trace, name).not.toContain(name);
    expect(trace).toContain('onPurged'); // the UI is told either way
  });

  it('a failing app-side step does not stop the others, but the overlay row (the retry key) is kept', async () => {
    const { purger, trace } = fixture({
      clearPollData: async () => Promise.reject(new Error('idb quota')),
    });
    const failure = (await purger.purgeLocalGroup(G).catch((e: unknown) => e)) as PurgeError;
    expect(failure).toBeInstanceOf(PurgeError);
    expect(failure.failures.map((f) => f.step)).toEqual(['polls']);
    for (const name of DATA_STEPS.filter((n) => n !== 'clearPollData')) expect(trace, name).toContain(name);
    expect(trace).not.toContain('removeOverlay');
    // the retry (next startup / reconcile) completes it
    trace.length = 0;
    const retry = fixture({}, 'absent');
    await retry.purger.purgeLocalGroup(G);
    expect(retry.trace).toContain('removeOverlay');
  });

  it('a failing sink purge keeps the overlay too (rows of the group may remain) and is reported as step `history`', async () => {
    const { purger, trace } = fixture({ history: { purge: async () => Promise.reject(new Error('sink disposed')) } });
    const failure = (await purger.purgeLocalGroup(G).catch((e: unknown) => e)) as PurgeError;
    expect(failure.failures.map((f) => f.step)).toEqual(['history']);
    expect(trace).toContain('clearMessages');
    expect(trace).not.toContain('removeOverlay');
  });

  it('a getGroup rejection (client torn down) fails the purge before anything is deleted', async () => {
    const { purger, trace } = fixture({ getGroup: async () => Promise.reject(Object.assign(new Error('disposed'), { code: 'disposed' })) });
    const failure = (await purger.purgeLocalGroup(G).catch((e: unknown) => e)) as PurgeError;
    expect(failure.failures[0].step).toBe('get-group');
    expect(trace).not.toContain('clearMessages');
  });

  it('a throwing onPurged / onError never breaks the purge', async () => {
    const { purger, trace } = fixture({
      onPurged: () => {
        throw new Error('ui');
      },
      onError: () => {
        throw new Error('reporter');
      },
      clearGroupMedia: async () => Promise.reject(new Error('media')),
    });
    await expect(purger.purgeLocalGroup(G)).rejects.toBeInstanceOf(PurgeError);
    expect(trace).toContain('clearUnread');
  });

  it('rejects an empty group id', async () => {
    const { purger } = fixture();
    await expect(purger.purgeLocalGroup('')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('re-join guard', () => {
  it('a Welcome accepted while the purge runs (the library holds the group again with the own account): the new data is NOT deleted', async () => {
    const { purger, trace, live } = fixture();
    const rejoined: AbandonableGroup = { abandon: async () => undefined, members: () => [OWN, BOB] };
    // the library group appears right after the abandon
    const original = live.group!;
    live.group = {
      abandon: async () => {
        await original.abandon();
        live.group = rejoined;
      },
    };
    await purger.purgeLocalGroup(G);
    expect(trace).toContain('history.purge');
    for (const name of [...DATA_STEPS, 'removeOverlay']) expect(trace, name).not.toContain(name);
    expect(trace.at(-1)).toBe('onPurged');
  });

  it('an unreadable roster on the re-checked group does NOT count as re-joined: the purge is not skipped because a read threw', async () => {
    const { purger, trace, live } = fixture();
    const corrupt: AbandonableGroup = {
      abandon: async () => undefined,
      members: () => {
        throw new Error('corrupt group state');
      },
    };
    const original = live.group!;
    live.group = {
      abandon: async () => {
        await original.abandon();
        live.group = corrupt;
      },
    };
    await purger.purgeLocalGroup(G);
    expect(trace).toContain('removeOverlay');
  });

  it('a re-checked group that lacks the own account (still tombstoned) is purged', async () => {
    const { purger, trace, live } = fixture();
    const original = live.group!;
    live.group = {
      abandon: async () => {
        await original.abandon();
        live.group = { abandon: async () => undefined, members: () => [BOB] };
      },
    };
    await purger.purgeLocalGroup(G);
    expect(trace).toContain('removeOverlay');
  });
});

describe('construction: every port is required and validated (omitting one fails loudly, never "purges less")', () => {
  const base = fixture().deps;
  const required = [
    'getGroup',
    'history',
    'tracker',
    'clearMessages',
    'clearReactions',
    'purgeHeldReactions',
    'clearPollData',
    'clearGroupMedia',
    'clearMemberProfiles',
    'clearProfileRequestMemos',
    'clearUnread',
    'clearPendingJoinRequests',
    'clearInviteLinks',
    'clearInviteExpiries',
    'clearPendingDirectInvites',
    'removeOverlay',
    'onPurged',
  ] as const;
  it.each(required)('missing %s throws a TypeError naming it', (name) => {
    const deps = { ...base } as Record<string, unknown>;
    delete deps[name];
    expect(() => createLocalGroupPurger(deps as unknown as PurgeLocalGroupDeps)).toThrowError(new RegExp(`'${name}'`));
  });
  it('object ports must carry their member (history.purge, tracker.forgetGroup)', () => {
    expect(() => createLocalGroupPurger({ ...base, history: {} as never })).toThrowError(/history\.purge/);
    expect(() => createLocalGroupPurger({ ...base, tracker: {} as never })).toThrowError(/tracker\.forgetGroup/);
  });
  it('ownPubkey is required', () => {
    expect(() => createLocalGroupPurger({ ...base, ownPubkey: '' })).toThrowError(/ownPubkey/);
  });
});

describe('the purge makes no network call of its own', () => {
  it('uses only the injected ports (a purge in a fixture without any transport completes)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { purger } = fixture();
      await purger.purgeLocalGroup(G);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('re-join safety BEFORE anything is touched', () => {
  const rejoinedGroup = (trace: string[]): AbandonableGroup => ({
    abandon: async () => void trace.push('abandon'),
    members: () => [OWN, BOB],
  });

  it('a group the library holds with the own account in a readable roster is left completely untouched (no tracker, no abandon, no sink, no store)', async () => {
    const trace: string[] = [];
    const { purger, trace: t } = fixture({}, rejoinedGroup(trace));
    await purger.purgeLocalGroup(G);
    expect(trace).toEqual([]); // abandon never called
    expect(t).not.toContain('tracker.forgetGroup');
    expect(t).not.toContain('history.purge');
    for (const name of [...DATA_STEPS, 'removeOverlay']) expect(t, name).not.toContain(name);
  });

  it('only the sole-member abandon (ownAccountIsMember) may purge a group whose roster holds the own account', async () => {
    const { purger, trace, live } = fixture({}, { abandon: async () => undefined, members: () => [OWN] });
    const held = live.group!;
    live.group = {
      ...held,
      abandon: async () => {
        trace.push('abandon');
        live.group = undefined;
      },
    };
    await purger.purgeLocalGroup(G, { ownAccountIsMember: true });
    expect(trace).toContain('abandon');
    expect(trace).toContain('removeOverlay');
  });

  it('every caller is covered: the removal event, the startup check and a finished leave never abandon a re-joined group', async () => {
    const abandons: string[] = [];
    const rejoined: AbandonableGroup & { id: string } = {
      id: G,
      abandon: async () => void abandons.push('abandon'),
      members: () => [OWN, BOB],
    };
    const { purger, trace } = fixture({}, rejoined);
    const jobs: Array<() => Promise<void>> = [];
    const handlers = createGroupRemovalHandlers({ ownPubkey: OWN, purger, enqueue: (j) => void jobs.push(j), removalSettleMs: 0 });
    // removal event path
    handlers.onGroupRemoved({ groupId: G });
    for (const j of jobs) await j();
    // startup check over a stale snapshot that still lacked the own account
    let stale = true;
    await handlers.checkListedGroups([{ id: G, members: () => (stale ? [BOB] : [OWN, BOB]) }]);
    stale = false;
    // a finishing leave
    await purger.purgeLocalGroup(G);
    expect(abandons).toEqual([]);
    expect(trace).not.toContain('removeOverlay');
  });
});

describe('undeletable group: a persistent non-teardown getGroup rejection', () => {
  it('purges the app-side data, KEEPS the overlay row (retry key) marked `unloadable`, skips the library step and does NOT claim success', async () => {
    const reported: Array<{ step: string }> = [];
    const marked: string[] = [];
    const { purger, trace } = fixture({
      getGroup: async () => Promise.reject(Object.assign(new Error('state unloadable'), { code: 'store-failed' })),
      markUnloadable: async (g) => void marked.push(g),
      onError: (_g, f) => void reported.push(f),
    });
    const failure = (await purger.purgeLocalGroup(G).catch((e: unknown) => e)) as PurgeError;
    expect(failure).toBeInstanceOf(PurgeError);
    expect(failure.unloadable).toBe(true);
    expect(failure.failures.map((f) => f.step)).toEqual(['get-group']);
    expect(trace).not.toContain('abandon');
    for (const name of DATA_STEPS) expect(trace, name).toContain(name);
    expect(trace).not.toContain('removeOverlay'); // the retry key survives
    expect(marked).toEqual([G]);
    expect(reported.map((f) => f.step)).toContain('get-group');
    expect(trace.at(-1)).toBe('onPurged');
  });

  it('a purge of a loadable group is NOT marked unloadable', async () => {
    const marked: string[] = [];
    const { purger } = fixture({ markUnloadable: async (g) => void marked.push(g) });
    await purger.purgeLocalGroup(G);
    expect(marked).toEqual([]);
  });

  it('a failing markUnloadable port is one more reported failure (unloadable stays true), never a success', async () => {
    const { purger, trace } = fixture({
      getGroup: async () => Promise.reject(new Error('state unloadable')),
      markUnloadable: async () => Promise.reject(new Error('idb')),
    });
    const failure = (await purger.purgeLocalGroup(G).catch((e: unknown) => e)) as PurgeError;
    expect(failure.unloadable).toBe(true);
    expect(failure.failures.map((f) => f.step)).toEqual(['get-group', 'mark-unloadable']);
    expect(trace).not.toContain('removeOverlay');
  });

  it('a transient rejection (the retry succeeds) is a normal purge, not an unloadable group', async () => {
    let calls = 0;
    const reported: string[] = [];
    const { purger, trace } = fixture({
      getGroup: async () => {
        if (calls++ === 0) throw new Error('blip');
        return undefined;
      },
      onError: (_g, f) => void reported.push(f.step),
    });
    await purger.purgeLocalGroup(G);
    expect(reported).toEqual([]);
    expect(trace).toContain('removeOverlay');
  });

  it('a teardown rejection (code disposed) still aborts untouched', async () => {
    const { purger, trace } = fixture({ getGroup: async () => Promise.reject(Object.assign(new Error('x'), { code: 'disposed' })) });
    const failure = (await purger.purgeLocalGroup(G).catch((e: unknown) => e)) as PurgeError;
    expect(failure).toBeInstanceOf(PurgeError);
    expect(trace).not.toContain('removeOverlay');
    expect(trace).not.toContain('tracker.forgetGroup');
  });
});

describe('message-edits and invite-contexts are their own purge steps (a failure keeps the overlay retry key)', () => {
  it.each([
    ['clearMessageEdits', 'message-edits'],
    ['clearInviteContexts', 'invite-contexts'],
  ] as const)('%s failing: PurgeError names %s, every other step ran, the overlay row is KEPT', async (port, step) => {
    const { purger, trace } = fixture({ [port]: async () => Promise.reject(new Error('idb')) } as Partial<PurgeLocalGroupDeps>);
    const failure = (await purger.purgeLocalGroup(G).catch((e: unknown) => e)) as PurgeError;
    expect(failure.failures.map((f) => f.step)).toEqual([step]);
    expect(trace).not.toContain('removeOverlay');
    expect(trace).toContain('clearPendingDirectInvites');
    expect(trace.at(-1)).toBe('onPurged');
  });
});

describe('isPurging / whenPurged (accept and purge are mutually exclusive per group id)', () => {
  it('whenPurged waits for a running purge, isPurging reflects it, other group ids are unaffected', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { purger } = fixture({ clearMessages: async () => gate });
    expect(purger.isPurging(G)).toBe(false);
    await purger.whenPurged(G); // idle: immediate
    const run = purger.purgeLocalGroup(G);
    await Promise.resolve();
    expect(purger.isPurging(G)).toBe(true);
    expect(purger.isPurging('other')).toBe(false);
    let done = false;
    const waited = purger.whenPurged(G).then(() => (done = true));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(done).toBe(false);
    release();
    await run;
    await waited;
    expect(purger.isPurging(G)).toBe(false);
  });

  it('whenPurged never rejects, even when the purge failed', async () => {
    const { purger } = fixture({ clearMessages: async () => Promise.reject(new Error('quota')) });
    const run = purger.purgeLocalGroup(G).catch(() => undefined);
    await expect(purger.whenPurged(G)).resolves.toBeUndefined();
    await run;
  });
});
