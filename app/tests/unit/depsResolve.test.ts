// @vitest-environment node
/**
 * AC-DEP-1 (exact pins), AC-DEP-3 (swc-loader include), AC-DEP-4 (resolve check).
 *
 * npm on this host can silently drop random .js files from node_modules, so the
 * resolve check also verifies that every file the new packages' `exports` maps
 * point at exists on disk, and really imports each subpath the app uses.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const APP_ROOT = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));

describe('AC-DEP-1: exact dependency pins', () => {
  it.each([
    ['@941design/marmot', '0.2.0-alpha.0'],
    ['@941design/marmot-engine', '0.2.0-alpha.0'],
    ['@941design/nostr-events', '0.2.0-alpha.0'],
    ['nostr-tools', '2.23.3'],
  ])('%s is pinned to exactly %s (no range operator)', (name, version) => {
    expect(pkg.dependencies[name]).toBe(version);
    expect(pkg.dependencies[name]).not.toMatch(/[\^~><*x]/);
  });

  it('installed versions match the pins', () => {
    for (const name of ['@941design/marmot', '@941design/marmot-engine', '@941design/nostr-events', 'nostr-tools']) {
      const installed = JSON.parse(readFileSync(join(APP_ROOT, 'node_modules', name, 'package.json'), 'utf8'));
      expect(installed.version).toBe(pkg.dependencies[name]);
    }
  });
});

describe('AC-DEP-3: next.config.mjs swc-loader include', () => {
  async function loaderRule() {
    const mod = await import(join(APP_ROOT, 'next.config.mjs'));
    const config = { module: { rules: [] as Array<Record<string, unknown>> } };
    mod.default.webpack(config);
    const rule = config.module.rules.find((r) => Array.isArray(r.include));
    if (!rule) throw new Error('swc-loader rule with an include list not found');
    return { rule, include: rule.include as RegExp[], swcMinify: mod.default.swcMinify as boolean };
  }
  const included = (include: RegExp[], p: string) => include.some((re) => re.test(p));

  it.each([
    'node_modules/@941design/marmot/dist/client/create-client.js',
    'node_modules/@941design/marmot-engine/dist/core/index.js',
    'node_modules/@941design/nostr-events/dist/signer/index.js',
    'node_modules/ts-mls/dist/src/index.js',
    // the library's ts-mls alias lives nested under marmot-engine
    'node_modules/@941design/marmot-engine/node_modules/ts-mls/dist/src/index.js',
  ])('matches %s', async (p) => {
    const { include } = await loaderRule();
    expect(included(include, p)).toBe(true);
  });

  it('does not sweep in unrelated packages', async () => {
    const { include } = await loaderRule();
    expect(included(include, 'node_modules/react/index.js')).toBe(false);
    expect(included(include, 'node_modules/@941designx/other/index.js')).toBe(false);
  });

  it('keeps swcMinify false', async () => {
    const { swcMinify } = await loaderRule();
    expect(swcMinify).toBe(false);
  });
});

describe('AC-DEP-4: resolve check (no "Cannot find module" after install)', () => {
  it.each(['@941design/marmot', '@941design/marmot-engine', '@941design/nostr-events'])(
    '%s: every file its exports map points at exists on disk',
    (name) => {
      const root = join(APP_ROOT, 'node_modules', name);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const missing: string[] = [];
      for (const [subpath, conditions] of Object.entries(manifest.exports as Record<string, Record<string, string>>)) {
        for (const [cond, target] of Object.entries(conditions)) {
          if (!existsSync(join(root, target))) missing.push(`${name}${subpath.slice(1)} [${cond}] -> ${target}`);
        }
      }
      expect(missing).toEqual([]);
    },
  );

  it('the ts-mls fork alias used by marmot-engine is installed', () => {
    const p = join(APP_ROOT, 'node_modules/@941design/marmot-engine/node_modules/ts-mls/package.json');
    expect(existsSync(p) || existsSync(join(APP_ROOT, 'node_modules/ts-mls/package.json'))).toBe(true);
  });

  it('imports each subpath the app uses', async () => {
    const marmot = await import('@941design/marmot');
    expect(typeof marmot.createMarmotClient).toBe('function');
    const mls = await import('@941design/marmot/mls');
    expect(Object.keys(mls).length).toBeGreaterThan(0);
    const engine = await import('@941design/marmot-engine/core');
    expect(Object.keys(engine).length).toBeGreaterThan(0);
    const events = await import('@941design/nostr-events/event');
    expect(events).toBeDefined();
    const signerAdapters = await import('@941design/nostr-events/signer/adapters');
    expect(typeof signerAdapters.fromForeignSigner).toBe('function');
    const simplePool = await import('@941design/nostr-events/transport/simple-pool');
    expect(typeof simplePool.createSimplePoolNetwork).toBe('function');
    const conformance = await import('@941design/nostr-events/transport/contract/conformance');
    expect(typeof conformance.FakeRelay).toBe('function');
    const idb = await import('@941design/marmot/storage/indexeddb');
    expect(typeof idb.createIndexedDbStorage).toBe('function');
    const mem = await import('@941design/marmot/storage/memory');
    expect(typeof mem.createMemoryStorage).toBe('function');
  });
});
