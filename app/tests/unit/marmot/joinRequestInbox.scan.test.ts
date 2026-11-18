// @vitest-environment node
/**
 * Structural checks of S12 (source scans over app/src, comments stripped):
 *
 *  AC-AUTO-2   auto-accept has exactly one mechanism: no `keyPackages.offer` and no `expectWelcome` call exists in app/src.
 *  AC-INBOX-2  kind 21063 is neither sent nor handled anywhere in app/src: it appears only as the retired-kind registry
 *              entry (kinds.ts).
 *  AC-JOIN-1   the inbox join-request path uses `sendInboxRumor` / `registerInboxHandler(21059)` and not a raw WebSocket publish.
 *  AC-BOUND-1  the join-request modules import no React and no React context.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const APP_ROOT = resolve(__dirname, '../../..');
const SRC = join(APP_ROOT, 'src');
const MARMOT = join(SRC, 'lib/marmot');

function listSrc(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSrc(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const code = (file: string) => stripComments(readFileSync(file, 'utf8'));
const rel = (f: string) => relative(SRC, f);
const files = listSrc(SRC);

describe('AC-AUTO-2: one auto-accept mechanism', () => {
  it('scans a non-trivial source tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });
  it('no keyPackages.offer and no expectWelcome in app/src', () => {
    const offenders = files.filter((f) => /\bkeyPackages\s*\.\s*offer\b|\bexpectWelcome\b/.test(code(f))).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('AC-INBOX-2: kind 21063', () => {
  it('appears nowhere in app/src code except the retired-kind registry entry', () => {
    const offenders = files
      .filter((f) => /\b21063\b/.test(code(f)))
      .map(rel)
      .filter((f) => f !== 'lib/marmot/kinds.ts');
    expect(offenders).toEqual([]);
  });
  it('kinds.ts carries it only inside RETIRED_KINDS', () => {
    const src = code(join(MARMOT, 'kinds.ts'));
    const hits = src.split('\n').filter((l) => /\b21063\b/.test(l));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/RETIRED_KINDS/);
  });

});

describe('AC-JOIN-1 / AC-BOUND-1: the join-request modules', () => {
  const JOIN_MODULES = ['joinRequestHandler.ts', 'joinRequestSender.ts', 'joinRequestStorage.ts', 'joinRequestApproval.ts', 'outboundJoinRequests.ts', 'invitations/autoAccept.ts'];
  it.each(JOIN_MODULES)('%s imports no React and no React context', (name) => {
    const src = code(join(MARMOT, name));
    expect(src).not.toMatch(/from\s+['"]react(\/|['"])/);
    expect(src).not.toMatch(/from\s+['"][^'"]*\/context\//);
  });
  it('the inbox sender publishes through sendInboxRumor, never through a raw WebSocket', () => {
    const src = code(join(MARMOT, 'joinRequestSender.ts'));
    const start = src.indexOf('export function createJoinRequestSender');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nexport ', start + 1);
    const body = src.slice(start, end === -1 ? undefined : end);
    expect(body).toMatch(/sendInboxRumor/);
    expect(body).not.toMatch(/WebSocket|rawPublish/);
  });
  it('the inbox handler holds no client reference (no groups.get / groupOf / invite / sendInboxRumor in joinRequestHandler.ts)', () => {
    expect(code(join(MARMOT, 'joinRequestHandler.ts'))).not.toMatch(/groups\s*\.\s*get|\bgroupOf\b|\.invite\(|sendInboxRumor/);
  });
  it('never calls idb-keyval update()', () => {
    for (const name of JOIN_MODULES) expect(code(join(MARMOT, name))).not.toMatch(/\bupdate\(\s*['"`]/);
  });
});
