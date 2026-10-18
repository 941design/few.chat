/**
 * Bug subscription-generation-resubscribes-all: after a stale-Welcome replace the
 * current subscription run subscribes only the groups that are missing, instead of
 * a generation bump rebuilding every group's subscription; and a group aborted on
 * its own no longer ends the subscribe loop for the groups after it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { needsSubscription } from '@/src/lib/marmot/subscriptionSelection';

const none = () => false;

describe('needsSubscription', () => {
  it('a group with no live, starting or replace-held subscription needs one', () => {
    expect(needsSubscription('a', { subscribed: none, replacing: none, starting: none })).toBe(true);
  });

  it.each([
    ['live', { subscribed: (id: string) => id === 'a', replacing: none, starting: none }],
    ['being replaced', { subscribed: none, replacing: (id: string) => id === 'a', starting: none }],
    ['already starting in this run', { subscribed: none, replacing: none, starting: (id: string) => id === 'a' }],
  ])('a group %s does not', (_label, state) => {
    expect(needsSubscription('a', state)).toBe(false);
    expect(needsSubscription('b', state)).toBe(true);
  });
});

const src = fs.readFileSync(path.join(__dirname, '../../../src/context/MarmotContext.tsx'), 'utf-8');
const effectStart = src.indexOf('async function subscribeNewGroups(');
const effectEnd = src.indexOf('void subscribeNewGroups(', effectStart);
const loop = src.slice(effectStart, effectEnd);

describe('MarmotContext wiring', () => {
  it('a replace subscribes the missing groups; no generation bump re-runs the whole effect', () => {
    expect(src).not.toMatch(/subscriptionGeneration/);
    expect(src).toMatch(/onAfterReplace: \(groupId\) => \{[\s\S]{0,300}subscribeMissingRef\.current\?\.\(list\);/);
  });

  it('the post-replace pass gets the reloaded list (groupsRef updates only on the next render)', () => {
    expect(src).toMatch(/if \(!isLatestReload\(seq, reloadGroupsSeqRef\.current\)\) return loaded;\s*setGroups\(loaded\);[\s\S]{0,300}groupsRef\.current = loaded;/);
    expect(src).toMatch(/scopeInviteExpiriesToGroups\(loaded\.map\(\(g\) => g\.id\)\);\s*return loaded;/);
    expect(src).toMatch(/void loadAndSetGroups\(\)\.catch\(\(\) => undefined\)\.then\(\(list\) => \{\s*replacingRef\.current\.delete\(groupId\);\s*subscribeMissingRef\.current\?\.\(list\);/);
    expect(src).toMatch(/function subscribeMissing\(list: Group\[\] = groupsRef\.current\) \{\s*void subscribeNewGroups\(list, false\);/);
  });

  it('a purge also clears the in-memory join-request count', () => {
    expect(src).toMatch(/clearPendingJoinRequestsForGroup: async \(groupId\) => \{\s*await clearPendingJoinRequestsForGroup\(groupId\);\s*clearJoinRequestGroup\(groupId\);/);
  });

  it('the subscribe loop skips via needsSubscription and marks the groups it starts', () => {
    expect(loop).toMatch(/if \(!needsSubscription\(group\.id, \{/);
    expect(loop).toMatch(/starting\.add\(group\.id\);/);
    expect(loop).toMatch(/finally \{[\s\S]{0,80}starting\.delete\(group\.id\);/);
  });

  it('a setup aborted on its own asks for another pass once it finished (a replace pass skipped it as starting)', () => {
    expect(loop).toMatch(/finally \{[\s\S]{0,700}if \(groupCtl\.signal\.aborted && isCurrent\(\) && !subsMap\.has\(group\.id\)\) subscribeMissing\(\);/);
  });

  it('a group aborted on its own continues with the next group', () => {
    // The one remaining `return` is inside the history-synced callback, not the loop body.
    expect(loop.match(/if \(!isCurrentGroup\(\)\) return;/g)).toHaveLength(1);
    expect(loop).toMatch(/\(\) => \{\s*if \(!isCurrentGroup\(\)\) return;\s*\/\/ S8-F1/);
    expect(loop.match(/if \(!isCurrentGroup\(\)\) continue;/g)!.length).toBeGreaterThanOrEqual(6);
  });
});
