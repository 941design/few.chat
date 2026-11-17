/**
 * Kind registry (AC-KIND-1, AC-KIND-2, AC-KIND-3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RUMOR_KINDS } from '@941design/marmot';
import {
  APP_INBOX_KINDS,
  APP_RUMOR_KINDS,
  RESERVED_KINDS,
  RETIRED_KINDS,
  assertNoKindCollisions,
  flattenInboxKinds,
} from '@/src/lib/marmot/kinds';

const clean = {
  appRumorKinds: [0, 5, 7, 9],
  appInboxKinds: [21059, 21064],
  retiredKinds: [13, 21063],
  reservedKinds: [444, 4460, 4461, 4462],
};

describe('AC-KIND-2 registry contents', () => {
  it('exports the exact app, inbox and retired kinds', () => {
    expect([...APP_RUMOR_KINDS]).toEqual([0, 5, 7, 9, 10, 11, 12, 30]);
    expect(APP_INBOX_KINDS).toEqual({
      joinRequest: 21059,
      pairingAck: 21060,
      dmProfile: [21061, 21062],
      inviteContext: 21064,
    });
    expect([...RETIRED_KINDS]).toEqual([13, 21063]);
  });

  it('takes reserved kinds from the library RUMOR_KINDS', () => {
    expect([...RESERVED_KINDS].sort((a, b) => a - b)).toEqual(Object.values(RUMOR_KINDS).sort((a, b) => a - b));
    expect(RESERVED_KINDS.length).toBeGreaterThan(0);
  });

  it('has no 4460/4461/4462 literals anywhere under app/src', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && /\b446[012]\b/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(join(__dirname, '../../../src'));
    expect(hits).toEqual([]);
  });
});

describe('AC-KIND-3 invite-context kind', () => {
  it('is 21064 and outside 4460-4462 and 21059-21063', () => {
    const k: number = APP_INBOX_KINDS.inviteContext;
    expect(k).toBe(21064);
    expect(k < 4460 || k > 4462).toBe(true);
    expect(k < 21059 || k > 21063).toBe(true);
  });
});

describe('AC-KIND-1 collision check', () => {
  afterEach(() => {
    vi.doUnmock('@941design/marmot');
    vi.resetModules();
  });

  it('does not throw for the real registry or a clean input', async () => {
    expect(() => assertNoKindCollisions(clean)).not.toThrow();
    await expect(import('@/src/lib/marmot/kinds')).resolves.toBeDefined();
  });

  it('throws naming the kinds when two app kinds are equal', () => {
    expect(() => assertNoKindCollisions({ ...clean, appInboxKinds: [21059, 9] })).toThrow(/duplicate.*\b9\b/);
    expect(() => assertNoKindCollisions({ ...clean, appRumorKinds: [0, 5, 5] })).toThrow(/duplicate.*\b5\b/);
  });

  it('throws naming the kinds when an app kind equals a retired kind', () => {
    expect(() => assertNoKindCollisions({ ...clean, appRumorKinds: [0, 13] })).toThrow(/\b13\b.*retired/);
    expect(() => assertNoKindCollisions({ ...clean, appInboxKinds: [21063] })).toThrow(/\b21063\b.*retired/);
  });

  it('throws naming the kinds when an app kind equals a RUMOR_KINDS value', () => {
    expect(() => assertNoKindCollisions({ ...clean, appInboxKinds: [4461] })).toThrow(/RUMOR_KINDS.*\b4461\b|\b4461\b.*RUMOR_KINDS/);
  });

  it('throws at import when the library reserves an app kind', async () => {
    vi.resetModules();
    vi.doMock('@941design/marmot', () => ({ RUMOR_KINDS: { WELCOME: 444, X: 21064 } }));
    await expect(import('@/src/lib/marmot/kinds')).rejects.toThrow(/21064/);
  });

  it('throws at import when the library reserves an app RUMOR kind (rumor list is wired)', async () => {
    vi.resetModules();
    vi.doMock('@941design/marmot', () => ({ RUMOR_KINDS: { WELCOME: 444, X: 9 } }));
    await expect(import('@/src/lib/marmot/kinds')).rejects.toThrow(/\b9\b/);
  });

  it('validates every list at import: rumor, inbox, retired and reserved inputs are all wired', async () => {
    vi.resetModules();
    vi.doUnmock('@941design/marmot');
    const k = await import('@/src/lib/marmot/kinds');
    expect(k.REGISTRY_INPUTS.appRumorKinds).toBe(k.APP_RUMOR_KINDS);
    expect(k.REGISTRY_INPUTS.appInboxKinds).toEqual(k.flattenInboxKinds(k.APP_INBOX_KINDS));
    expect(k.REGISTRY_INPUTS.retiredKinds).toBe(k.RETIRED_KINDS);
    expect(k.REGISTRY_INPUTS.reservedKinds).toBe(k.RESERVED_KINDS);
  });

  it('flattens the inbox kinds including the dmProfile pair', () => {
    expect(flattenInboxKinds(APP_INBOX_KINDS)).toEqual([21059, 21060, 21061, 21062, 21064]);
  });
});
