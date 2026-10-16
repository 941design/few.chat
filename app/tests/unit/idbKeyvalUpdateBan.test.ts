/**
 * Static source-scan guard: idb-keyval's `update()` must never be used
 * (finding idb-keyval-update-lint-ban).
 *
 * Why: in idb-keyval 6.2.2 `update()` is not transaction-bound. It wires only
 * the get's `onsuccess`, so a get error or a transaction abort before success
 * leaves its promise pending forever. A caller awaiting it (e.g. the rumor
 * journal on the MLS ingest path) hangs. Round 1 of bug run
 * journal-and-removal-robustness introduced exactly this hang in putRumor.
 * Read-modify-write goes through a store callback in ONE readwrite transaction
 * and `promisifyRequest(os.transaction)` instead (see rumorJournal.putRumor,
 * pollPersistence.pollTxn, messageEdits modifyPinsAtomically).
 *
 * The project has no eslint; `make test` runs vitest, so the ban lives here.
 * Same design as marmot/handlersRumorPubkeyBoundary.test.ts: readdirSync
 * enumeration (a new file is scanned by default), comment stripping, and a
 * self-test proving the scanner flags every import form.
 *
 * Known limitation (accepted): a literal-name tripwire against the realistic
 * regression, not an adversarial guarantee (e.g. `m['update']` or passing the
 * module object around escapes it).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const SCAN_ROOTS = ['src', 'pages'];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Replace comments with spaces (newlines kept, so offsets map to lines).
 * String and template literals are skipped intact, so `'wss://…'` is not
 * mistaken for a line comment.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j++;
        else if (c !== '`' && source[j] === '\n') break;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const MOD = String.raw`['"]idb-keyval['"]`;

/** Imported (not local) names of a `{ a, b as c, type d }` / `{ a, b: c }` list. */
function importedNames(specifiers: string): string[] {
  return specifiers
    .split(',')
    .map((s) => s.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((s) => s.split(/\s+as\s+|\s*:\s*/)[0].trim());
}

interface Violation {
  line: number;
  form: string;
}

/** Every use of idb-keyval's update() in `source` (comments ignored). */
function scanForUpdate(source: string): Violation[] {
  const code = stripComments(source);
  const found: Violation[] = [];
  const lineAt = (index: number) => code.slice(0, index).split('\n').length;
  const add = (index: number, form: string) => found.push({ line: lineAt(index), form });

  // import { update } / import x, { update as u } / export { update } from 'idb-keyval'
  const named = new RegExp(String.raw`\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*${MOD}`, 'g');
  for (const m of code.matchAll(named)) {
    if (importedNames(m[1]).includes('update')) add(m.index!, 'named import');
  }
  // const { update } = await import('idb-keyval')
  const dynDestructure = new RegExp(String.raw`\{([^}]*)\}\s*=\s*(?:await\s+)?import\(\s*${MOD}\s*\)`, 'g');
  for (const m of code.matchAll(dynDestructure)) {
    if (importedNames(m[1]).includes('update')) add(m.index!, 'dynamic import destructure');
  }
  // (await import('idb-keyval')).update
  const dynMember = new RegExp(String.raw`import\(\s*${MOD}\s*\)\s*\)?\s*\.\s*update\b`, 'g');
  for (const m of code.matchAll(dynMember)) add(m.index!, 'dynamic import member');
  // import * as N from 'idb-keyval' / const N = await import('idb-keyval'), then N.update
  const namespaces = new Set<string>();
  const nsStatic = new RegExp(String.raw`import\s+\*\s+as\s+([\w$]+)\s+from\s*${MOD}`, 'g');
  const nsDynamic = new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?import\(\s*${MOD}\s*\)`, 'g');
  for (const m of code.matchAll(nsStatic)) namespaces.add(m[1]);
  for (const m of code.matchAll(nsDynamic)) namespaces.add(m[1]);
  for (const ns of namespaces) {
    const use = new RegExp(String.raw`(?<![\w$.])${ns.replace(/\$/g, '\\$')}\s*\.\s*update\b`, 'g');
    for (const m of code.matchAll(use)) add(m.index!, 'namespace member');
  }
  return found.sort((a, b) => a.line - b.line);
}

describe('idb-keyval update() ban (finding idb-keyval-update-lint-ban)', () => {
  const files = SCAN_ROOTS.flatMap((root) => listSourceFiles(path.join(appDir, root)));

  it('scans a non-trivial tree that really imports idb-keyval', () => {
    expect(files.length).toBeGreaterThan(50);
    const importers = files.filter((f) => /['"]idb-keyval['"]/.test(readFileSync(f, 'utf8')));
    expect(importers.length).toBeGreaterThan(10);
  });

  it('no file under app/src or app/pages uses idb-keyval update()', () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const v of scanForUpdate(readFileSync(file, 'utf8'))) {
        hits.push(`${path.relative(appDir, file)}:${v.line} (${v.form})`);
      }
    }
    expect(hits, `idb-keyval update() is banned (may never settle); use a store-callback transaction:\n${hits.join('\n')}`).toEqual([]);
  });
});

describe('scanForUpdate (self-test: the scanner has teeth)', () => {
  it.each([
    ["import { update } from 'idb-keyval';", 'named import'],
    ['import { get, update, set } from "idb-keyval";', 'named import'],
    ["import { get,\n  update as idbUpdate,\n} from 'idb-keyval';", 'named import'],
    ["import def, { update } from 'idb-keyval';", 'named import'],
    ["export { update } from 'idb-keyval';", 'named import'],
    ["const { update } = await import('idb-keyval');", 'dynamic import destructure'],
    ["const { get, update: u } = await import('idb-keyval');", 'dynamic import destructure'],
    ["await (await import('idb-keyval')).update('k', f);", 'dynamic import member'],
    ["import * as idb from 'idb-keyval';\nidb.update('k', f);", 'namespace member'],
    ["const kv = await import('idb-keyval');\nawait kv.update('k', f);", 'namespace member'],
  ])('flags %j', (fixture, form) => {
    const hits = scanForUpdate(fixture);
    expect(hits).toHaveLength(1);
    expect(hits[0].form).toBe(form);
  });

  it('reports the line of the offending statement', () => {
    expect(scanForUpdate("const a = 1;\n\nimport { update } from 'idb-keyval';\n")[0].line).toBe(3);
  });

  it.each([
    ["import { get, set } from 'idb-keyval';"],
    ["import { updateGroup } from 'idb-keyval';"],
    ["import { update } from './local';"],
    ["import { get as update } from 'idb-keyval';"],
    ["const { get: idbGet } = await import('idb-keyval');\nobj.update(1);"],
    ["// import { update } from 'idb-keyval';"],
    ["/* const { update } = await import('idb-keyval'); */"],
    ["const url = 'wss://x'; import { get } from 'idb-keyval';"],
    ["import * as idb from 'idb-keyval';\nfoo.idb.update(1); idb.updateX();"],
  ])('does not flag %j', (fixture) => {
    expect(scanForUpdate(fixture)).toEqual([]);
  });

  it('stripComments keeps strings that contain comment markers', () => {
    expect(stripComments("const u = 'a//b'; // c")).toBe("const u = 'a//b';     ");
  });
});
