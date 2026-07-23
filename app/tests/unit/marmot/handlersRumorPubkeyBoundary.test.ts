/**
 * Static source-scan guard for epic: group-message-author-auth-app-layer, S2.
 *
 * S2's job was mechanical: every RumorHandler in app/src/lib/marmot/handlers/
 * repointed its attribution/authorization reads from the forgeable
 * `rumor.pubkey` to the dispatcher-resolved `sender.pubkey`
 * (applicationRumorDispatcher.ts's AuthenticatedSender). This test guards
 * against a regression reintroducing a `rumor.pubkey` attribution read —
 * directly (a future edit to one of these files) or indirectly (a new
 * handler file added to this directory without threading `sender` through).
 *
 * Design mirrors app/tests/unit/themes/zodBoundary.test.ts: read real source
 * files from disk, regex-scan them, and include a self-test proving the
 * scanner "has teeth" (i.e. it actually flags a violation, not just a
 * vacuously-true check) against in-memory fixtures — not just the real files.
 *
 * `readdirSync` (not a hardcoded file list) enumerates the handlers
 * directory, so a future new handler file defaults to SCANNED-AND-BLOCKED
 * rather than silently inheriting an exemption (architecture.md's boundary
 * rule for this seam).
 *
 * Comment-awareness: the scanner only flags `rumor.pubkey` appearing in
 * CODE, not inside `//` or `/* *\/` comments. Several handler files carry
 * pre-existing, deliberately-preserved prose (deleteEditHandler.ts's
 * byte-for-byte "trust model" doc comment; profileHandler.ts's own-join gate
 * commentary) that discusses `rumor.pubkey` historically/architecturally
 * without reading it in code — those are correctly ignored, which is why the
 * production allow-list can be EMPTY (the ban is absolute; see ALLOWLIST).
 *
 * Known limitation (accepted): this is a literal-name regression tripwire, not
 * an adversarial guarantee. It matches the textual token `rumor.pubkey`, so it
 * is defeatable by aliasing (`const r = rumor; r.pubkey`), destructuring
 * (`const { pubkey } = rumor`), computed access (`rumor['pubkey']`), or
 * renaming the parameter. It catches the realistic in-repo regression — a
 * direct `rumor.pubkey` attribution read reintroduced by a non-adversarial
 * edit — and is not relied upon to stop a determined author working around it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const handlersDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../src/lib/marmot/handlers');

function readSource(fileName: string): string {
  return readFileSync(path.join(handlersDir, fileName), 'utf8');
}

/** Every `.ts` file directly inside handlers/ — enumerated, never hardcoded. */
function listHandlerFiles(): string[] {
  return readdirSync(handlersDir)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

interface Violation {
  line: number;
  text: string;
}

/**
 * Scans `source` for CODE (non-comment) occurrences of the word-bounded
 * `rumor.pubkey`. Strips `//` line comments and `/* *\/` block comments
 * (stateful across lines, so a multi-line doc comment is fully excluded)
 * before matching, but reports the ORIGINAL line text — including any
 * trailing comment — so a `// scan-allow: ...` marker on the same line as a
 * real code match is still visible to the allow-list check below.
 */
function scanForViolations(source: string): Violation[] {
  const PATTERN = /\brumor\.pubkey\b/;
  const lines = source.split('\n');
  const violations: Violation[] = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    let codePortion = '';
    let cursor = 0;

    while (cursor < originalLine.length) {
      if (inBlockComment) {
        const end = originalLine.indexOf('*/', cursor);
        if (end === -1) {
          cursor = originalLine.length;
          break;
        }
        inBlockComment = false;
        cursor = end + 2;
        continue;
      }
      const lineCommentIdx = originalLine.indexOf('//', cursor);
      const blockCommentIdx = originalLine.indexOf('/*', cursor);
      if (lineCommentIdx === -1 && blockCommentIdx === -1) {
        codePortion += originalLine.slice(cursor);
        break;
      }
      if (blockCommentIdx === -1 || (lineCommentIdx !== -1 && lineCommentIdx < blockCommentIdx)) {
        // Line comment starts first (or is the only one) — rest of line is comment.
        codePortion += originalLine.slice(cursor, lineCommentIdx);
        break;
      }
      // Block comment starts first.
      codePortion += originalLine.slice(cursor, blockCommentIdx);
      inBlockComment = true;
      cursor = blockCommentIdx + 2;
    }

    if (PATTERN.test(codePortion)) {
      violations.push({ line: i + 1, text: originalLine });
    }
  }

  return violations;
}

// ─── Allow-list ──────────────────────────────────────────────────────────────

type AllowEntry = { file: string; lineContains: string; reason: string };

// The ban is ABSOLUTE: after S2's Fable-review remediation (F1), the last
// identity comparison on the forgeable field — chatHandler's own-send guard —
// was repointed to the authenticated `sender.pubkey`, so NO handler reads
// `rumor.pubkey` in code and the production allow-list is empty. A non-empty
// allow-list would be the seam inconsistency this epic exists to remove.
const ALLOWLIST: ReadonlyArray<AllowEntry> = [];

function isAllowed(file: string, violation: Violation, allowlist: ReadonlyArray<AllowEntry> = ALLOWLIST): boolean {
  return allowlist.some((entry) => entry.file === file && violation.text.includes(entry.lineContains));
}

// ─── Real-file assertions ─────────────────────────────────────────────────────

describe('handlers/ rumor.pubkey boundary (epic: group-message-author-auth-app-layer, S2)', () => {
  const files = listHandlerFiles();

  it('discovers the handlers directory non-vacuously (scanner has files to check)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every rumor.pubkey CODE read across handlers/ is either absent or explicitly allow-listed', () => {
    const unallowed: string[] = [];
    for (const file of files) {
      const source = readSource(file);
      for (const violation of scanForViolations(source)) {
        if (!isAllowed(file, violation)) {
          unallowed.push(`${file}:${violation.line}: ${violation.text.trim()}`);
        }
      }
    }
    expect(unallowed, `Unallow-listed rumor.pubkey reads found:\n${unallowed.join('\n')}`).toEqual([]);
  });

  it('every allow-list entry actually matches at least one real line (no stale exemption)', () => {
    for (const entry of ALLOWLIST) {
      const source = readSource(entry.file);
      const violations = scanForViolations(source);
      const matched = violations.some((v) => v.text.includes(entry.lineContains));
      expect(matched, `Allow-list entry for ${entry.file} ("${entry.lineContains}") matched no line`).toBe(true);
    }
  });
});

// ─── Self-test (proves the scanner has teeth) ────────────────────────────────

describe('scanForViolations / isAllowed (self-test — proves the scanner has teeth)', () => {
  it('flags a rumor.pubkey CODE read with no marker (the exact regression this test guards against)', () => {
    const fixture = `const authorPubkey = rumor.pubkey;\n`;
    const violations = scanForViolations(fixture);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(1);
  });

  // The production ALLOWLIST is empty (the ban is absolute). These two tests
  // prove the per-file allow-list MECHANISM still works, using a local demo
  // entry — so if a future exemption ever becomes genuinely necessary, the
  // matching logic is known-correct.
  const DEMO_ALLOWLIST = [
    { file: 'chatHandler.ts', lineContains: 'scan-allow: demo marker', reason: 'demo only' },
  ];

  it('the isAllowed mechanism allows a marked read on the same line, for the matching file (demo allow-list)', () => {
    const fixture = `if (rumor.pubkey !== ctx.selfPubkeyHex) { // scan-allow: demo marker\n`;
    const violations = scanForViolations(fixture);
    expect(violations).toHaveLength(1); // still a raw match...
    expect(isAllowed('chatHandler.ts', violations[0], DEMO_ALLOWLIST)).toBe(true); // ...but allowed for this file
  });

  it('the isAllowed mechanism still flags a marked read when the FILE does not match (per-file, not global)', () => {
    const fixture = `if (rumor.pubkey !== ctx.selfPubkeyHex) { // scan-allow: demo marker\n`;
    const violations = scanForViolations(fixture);
    expect(violations).toHaveLength(1);
    expect(isAllowed('someOtherHandler.ts', violations[0], DEMO_ALLOWLIST)).toBe(false);
  });

  it('the production ALLOWLIST is empty — the handlers/ rumor.pubkey ban is absolute', () => {
    expect(ALLOWLIST).toHaveLength(0);
  });

  it('does NOT flag a near-miss identifier like rumor.pubkeyHex (word-boundary correctness, no substring false positive)', () => {
    const fixture = `const x = rumor.pubkeyHex;\n`;
    expect(scanForViolations(fixture)).toHaveLength(0);
  });

  it('does NOT flag a rumor.pubkey mention inside a `//` line comment', () => {
    const fixture = `// this comment mentions rumor.pubkey but is not code\nconst y = 1;\n`;
    expect(scanForViolations(fixture)).toHaveLength(0);
  });

  it('does NOT flag a rumor.pubkey mention inside a multi-line `/* ... */` block comment', () => {
    const fixture = [
      '/**',
      ' * IMPORTANT: rumor.pubkey is not MLS-authenticated, see doc above.',
      ' * Still talking about rumor.pubkey on this second comment line.',
      ' */',
      'const z = 1;',
      '',
    ].join('\n');
    expect(scanForViolations(fixture)).toHaveLength(0);
  });

  it('DOES flag a rumor.pubkey CODE read on the line immediately after a block comment closes', () => {
    const fixture = ['/** doc mentioning rumor.pubkey */', 'const w = rumor.pubkey;', ''].join('\n');
    const violations = scanForViolations(fixture);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });

  it('flags multiple distinct violation lines independently, each with its own line number', () => {
    const fixture = ['const a = rumor.pubkey;', 'const b = 1;', 'const c = rumor.pubkey;', ''].join('\n');
    const violations = scanForViolations(fixture);
    expect(violations.map((v) => v.line)).toEqual([1, 3]);
  });
});
