/**
 * Structural import-boundary checks (AC-BOUND-1, AC-TRANS-1 import-graph half,
 * architecture boundary rules).
 *
 * - Pure modules under src/lib/marmot/** never import src/context/** (React
 *   contexts). New module directories additionally never import 'react'.
 * - The client module's transitive import graph reaches no NDK, no
 *   @internet-privacy/marmot-ts, no ts-mls, and none of the old NDK-transport
 *   modules; it never uses idb-keyval.
 *
 * Extend NEW_MODULE_DIRS as later stories add module directories.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const APP_ROOT = resolve(__dirname, '../../../..');
const MARMOT_DIR = join(APP_ROOT, 'src/lib/marmot');
/** Directories (relative to src/lib/marmot) written for the library adoption. */
const NEW_MODULE_DIRS = ['client'];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(file: string): string[] {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const specs: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) specs.push(m[1] ?? m[2]);
  return specs;
}

function resolveLocal(from: string, spec: string): string | undefined {
  const base = spec.startsWith('@/') ? join(APP_ROOT, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : undefined;
  if (!base) return undefined;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return undefined;
}

function importGraph(entryDir: string): { files: string[]; externals: Set<string> } {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const stack = listTs(entryDir);
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of specifiersOf(f)) {
      const local = resolveLocal(f, spec);
      if (local) stack.push(local);
      else externals.add(spec);
    }
  }
  return { files: [...seen], externals };
}

describe('AC-BOUND-1: pure modules do not import React contexts', () => {
  const files = listTs(MARMOT_DIR);
  it('scans a non-trivial set of files including the new client module', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.includes('/client/createClient.ts'))).toBe(true);
  });

  it('no file under src/lib/marmot imports src/context', () => {
    const offenders = files.filter((f) =>
      specifiersOf(f).some((s) => /(^|\/)src\/context(\/|$)/.test(s) || /(^|\/)context\/[A-Za-z]/.test(s)),
    );
    expect(offenders.map((f) => relative(APP_ROOT, f))).toEqual([]);
  });

  it('new module directories do not import react', () => {
    for (const dir of NEW_MODULE_DIRS) {
      for (const f of listTs(join(MARMOT_DIR, dir))) {
        expect(specifiersOf(f).filter((s) => s === 'react' || s.startsWith('react/') || s.startsWith('react-dom'))).toEqual([]);
      }
    }
  });

  it('no file anywhere under src/lib/marmot imports react (the old exemption for outboundJoinRequests.ts is gone: its hook lives in src/hooks)', () => {
    const offenders = files
      .filter((f) => specifiersOf(f).some((s) => s === 'react' || s.startsWith('react/') || s.startsWith('react-dom')))
      .map((f) => relative(MARMOT_DIR, f));
    expect(offenders).toEqual([]);
  });
});

describe('client module import graph (AC-TRANS-1, boundary rules)', () => {
  const { files, externals } = importGraph(join(MARMOT_DIR, 'client'));
  const externalList = [...externals];

  it('reaches the library packages it is built on', () => {
    expect(externalList).toContain('@941design/marmot');
    expect(externalList).toContain('@941design/nostr-events/transport/simple-pool');
    expect(externalList).toContain('@941design/nostr-events/signer/adapters');
    expect(externalList).toContain('nostr-tools/pool');
  });

  it('reaches no NDK, no marmot-ts fork, no ts-mls, no idb-keyval', () => {
    const banned = externalList.filter(
      (s) => s.startsWith('@nostr-dev-kit/') || s.startsWith('@internet-privacy/') || s === 'ts-mls' || s.startsWith('ts-mls/') || s === 'idb-keyval' || s === 'applesauce-core' || s.startsWith('applesauce-core/'),
    );
    expect(banned).toEqual([]);
  });

  it('stays inside src/lib/marmot/client (imports no old flow module, no ndkClient)', () => {
    // The AppKinds registry (kinds.ts) is the one sanctioned module outside client/.
    const outside = files.filter(
      (f) => !f.startsWith(join(MARMOT_DIR, 'client') + '/') && f !== join(MARMOT_DIR, 'kinds.ts'),
    );
    expect(outside.map((f) => relative(APP_ROOT, f))).toEqual([]);
  });

  it('never calls idb-keyval update() and never imports a verifier', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/\bupdate\(\s*['"`]/);
      expect(src).not.toMatch(/verifier\s*:/);
    }
  });

  it('keeps the client importable only from its own surface in feature modules (marmot-ts/ts-mls absent from every client file)', () => {
    for (const f of files) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/from\s+['"](ts-mls|@internet-privacy\/marmot-ts)/);
    }
  });
});
