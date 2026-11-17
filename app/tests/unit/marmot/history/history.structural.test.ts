/**
 * Structural guards for the history module (AC-HIST-8, AC-HIST-2, boundary
 * rules): source scans over every file under src/lib/marmot/history/.
 *
 *  - no idb-keyval `update()` (the repo-wide ban also covers this directory;
 *    this pins it locally and proves the scanner flags the import forms);
 *  - the sender is never read from the rumor's own pubkey field;
 *  - imports stay inside the boundary: no React / context, no NDK, no ts-mls or
 *    marmot-ts, no client construction, and no other app module besides the
 *    kind registry (the AppKinds seam).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = resolve(__dirname, '../../../../src/lib/marmot/history');
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
const source = (f: string) => strip(readFileSync(join(DIR, f), 'utf8'));

const USES_UPDATE = (src: string) =>
  /\bimport\s*\{[^}]*\bupdate\b[^}]*\}\s*from\s*['"]idb-keyval['"]/.test(src) ||
  /\bidb\.update\s*\(/.test(src) ||
  /\bupdate\s*\(\s*['"`\w]/.test(src);

describe('history module structure', () => {
  it('covers the four planned files plus the index', () => {
    expect(files.sort()).toEqual(['historyBackend.ts', 'historyStore.ts', 'index.ts', 'sweep.ts']);
  });

  it('never uses idb-keyval update() (AC-HIST-8)', () => {
    for (const f of files) expect(USES_UPDATE(source(f)), f).toBe(false);
  });

  it('the update() scanner flags the import forms it is meant to catch', () => {
    expect(USES_UPDATE(`import { get, update } from 'idb-keyval';`)).toBe(true);
    expect(USES_UPDATE(`await update(key, (v) => v, store);`)).toBe(true);
    expect(USES_UPDATE(`import { get, set, del } from 'idb-keyval';`)).toBe(false);
  });

  it('never reads the sender from the rumor pubkey (AC-HIST-2)', () => {
    for (const f of files) expect(source(f), f).not.toMatch(/rumor\s*\??\.\s*pubkey/);
    expect(source('historyBackend.ts')).toMatch(/orderingKey\.account/);
  });

  it('imports only within its boundary', () => {
    const allowedRelative = new Set(['./historyBackend', './historyStore', './sweep', '../kinds']);
    const forbidden = /^(react|react-dom|ts-mls|@internet-privacy\/|@nostr-dev-kit\/|ndk|@\/src\/context)/;
    for (const f of files) {
      const specs = [...source(f).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of specs) {
        expect(spec, `${f}: ${spec}`).not.toMatch(forbidden);
        if (spec.startsWith('.')) expect(allowedRelative.has(spec), `${f}: ${spec}`).toBe(true);
      }
      expect(source(f), f).not.toMatch(/createMarmotClient|openForWrite/);
    }
  });
});
