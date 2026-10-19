/**
 * Source scan (no jsdom harness): MarmotContext's background KeyPackage task
 * republishes when the relays hold no event backed by a local KeyPackage (bug
 * invite-fresh-peer-fails-with-has). It runs after the stale-event cleanup,
 * which deletes relay events that no local KeyPackage backs, so an event the
 * cleanup removes is never counted as presence.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../../src/context/MarmotContext.tsx'), 'utf8');
const cleanup = src.indexOf('// Non-fatal: stale KP cleanup is best-effort');
const start = src.indexOf('await ensureKeyPackagesOnRelays({');
const block = src.slice(start, src.indexOf('});', src.indexOf('publish: async () =>', start)));

describe('KeyPackage relay check wiring', () => {
  it('runs once, in the background task, after the stale-event cleanup', () => {
    expect(cleanup).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(cleanup);
    expect(src.split('ensureKeyPackagesOnRelays({').length - 1).toBe(1);
    expect(start).toBeGreaterThan(src.indexOf('// --- Background: key package readiness'));
    expect(start).toBeLessThan(src.indexOf('// Publish kind 30051 relay list', cleanup));
  });

  it('fetches our own KeyPackage kinds from the effective relays and reports a timeout', () => {
    expect(block).toContain('fetchEventsWithTimeout(');
    expect(block).toContain('{ kinds: [443 as any, 30443 as any], authors: [pubkeyHex] }');
    expect(block).toContain('NDKRelaySet.fromRelayUrls(effectiveRelays, ndk)');
    expect(block).not.toContain('limit');
  });

  it('counts only relay events backed by a local KeyPackage', () => {
    expect(block).toContain('countBackedKeyPackageEvents(events, await client.keyPackages.list())');
  });

  it('republishes one KeyPackage to the effective relays, not after the init was cancelled', () => {
    expect(block).toContain('cancelled ? 0 : publishKeyPackages(client.keyPackages, 1, effectiveRelays)');
  });
});
