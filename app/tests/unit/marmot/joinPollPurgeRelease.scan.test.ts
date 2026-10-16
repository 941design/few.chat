/**
 * Source scan (finding poll-pending-queues-recreated-after-purge, remediation
 * round 1): a leave sets an in-memory poll purge mark (pollPersistence
 * clearPollData); every successful (re-)join must release it. Rather than a
 * call per accept path (invite accept, join-request auto-accept, pull-only
 * invitations, with or without a pre-join group id), the release sits at the
 * single choke point every join goes through: welcomeSubscription.joinAndPersist,
 * right after the overlay is saved. This pins that the choke point stays the
 * only place a Welcome is joined. Kept in its own file: it reads raw source,
 * which mutation-testing instrumentation changes.
 */
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

describe('join choke point releases the poll purge mark', () => {
  it('scan: the app joins a Welcome in exactly one place, joinAndPersist, which releases the mark after saving the overlay', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const srcDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../src');
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const f = path.join(d, n);
      return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(n) ? [f] : [];
    });
    const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const callers = walk(srcDir).filter((f) => /\.joinGroupFromWelcome\s*\(/.test(code(f)));
    expect(callers.map((f) => path.relative(srcDir, f))).toEqual([path.join('lib', 'marmot', 'welcomeSubscription.ts')]);
    const ws = code(callers[0]);
    expect(ws.match(/\.joinGroupFromWelcome\s*\(/g)).toHaveLength(1);
    const body = ws.slice(ws.indexOf('async function joinAndPersist('));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toMatch(/\.joinGroupFromWelcome\s*\(/);
    expect(fn).toMatch(/await saveGroup\(joinedGroup\);\s*releasePollPurgeMark\(joinedGroup\.id\);/);
  });
});
