/**
 * OutboundJoinRequestCard.test.ts — source-scan unit tests for the S4 dimmed
 * outbound-join-request card (epic: invite-link-awaiting-landing, story S4;
 * AC-CARD-1..3, AC-REACT-2).
 *
 * This repo has NO jsdom / @testing-library / component-render capability
 * (vitest only) — mirrors JoinRequestCard.test.ts's precedent of reading the
 * built `.tsx` source as a string and asserting against it with regexes.
 * There is no non-trivial pure logic to extract here (the wiring in
 * groups.tsx is a plain `.map()`), so a source-scan is the right and
 * sufficient level for this component.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getCopy } from '@/src/lib/i18n';

const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TEST_FILE_DIR, '..', '..', '..'); // app/tests/unit/components -> app/

const CARD_SOURCE = fs.readFileSync(
  path.join(APP_ROOT, 'src', 'components', 'groups', 'OutboundJoinRequestCard.tsx'),
  'utf8',
);

// Comment-stripped view for negative "does not reference X" assertions: doc
// comments legitimately NAME the forbidden symbols they explain the absence of
// (e.g. "deleteOutboundJoinRequest swallows storage errors"), so a whole-file
// regex would false-positive on the explanation. Scope those checks to code.
// (Retro carried from S4: negative source-scans must exclude comments.)
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^:])\/\/.*$/gm, '$1');
const CARD_CODE = stripComments(CARD_SOURCE);

const GROUPS_PAGE_SOURCE = fs.readFileSync(path.join(APP_ROOT, 'pages', 'groups.tsx'), 'utf8');
const GROUPS_PAGE_CODE = stripComments(GROUPS_PAGE_SOURCE);

// ── AC-CARD-3 / DD-4 — cancel is the only sanctioned mutation, no relay signal ──

describe('OutboundJoinRequestCard.tsx — cancel path (AC-CARD-3, DD-4)', () => {
  it('calls cancelOutboundJoinRequest(', () => {
    expect(CARD_SOURCE).toMatch(/cancelOutboundJoinRequest\(/);
  });

  it('does not import or reference deleteOutboundJoinRequest directly', () => {
    expect(CARD_CODE).not.toMatch(/deleteOutboundJoinRequest/);
  });

  it('does not import idb-keyval', () => {
    expect(CARD_CODE).not.toMatch(/idb-keyval/);
  });

  it('does not attempt any relay-publish-shaped call (publish/sendJoinRequest/retract) — cancel never re-signals the admin', () => {
    expect(CARD_CODE).not.toMatch(/\bpublish\(/);
    expect(CARD_CODE).not.toMatch(/sendJoinRequest\(/);
    expect(CARD_CODE).not.toMatch(/retract/i);
  });
});

// ── AC-CARD-2 — plain, non-navigating card ─────────────────────────────────

describe('OutboundJoinRequestCard.tsx — non-interactive card body (AC-CARD-2)', () => {
  it('does not import LinkBox or LinkOverlay from @chakra-ui/react', () => {
    const importBlock = CARD_SOURCE.match(/import\s*\{[^}]*\}\s*from ['"]@chakra-ui\/react['"]/);
    expect(importBlock).not.toBeNull();
    expect(importBlock?.[0]).not.toMatch(/\bLinkBox\b/);
    expect(importBlock?.[0]).not.toMatch(/\bLinkOverlay\b/);
  });

  it('does not construct an href or NextLink targeting /groups?id=', () => {
    expect(CARD_SOURCE).not.toMatch(/\/groups\?id=/);
    expect(CARD_SOURCE).not.toMatch(/NextLink/);
  });
});

// ── Badge/copy sourcing ─────────────────────────────────────────────────────

describe('OutboundJoinRequestCard.tsx — badge and copy sourcing', () => {
  it('references copy.groups.awaitingBadgeLabel and copy.groups.cancelOutboundRequestLabel (real i18n keys, not hardcoded strings)', () => {
    expect(CARD_SOURCE).toMatch(/copy\.groups\.awaitingBadgeLabel/);
    expect(CARD_SOURCE).toMatch(/copy\.groups\.cancelOutboundRequestLabel/);
  });

  it('renders the Badge with the decorative BADGE_ACCENT.awaiting colorScheme and variant="subtle"', () => {
    const badgeMatch = CARD_SOURCE.match(/<Badge[\s\S]*?>/);
    expect(badgeMatch).not.toBeNull();
    // Badge color leans on the theme via the shared decorative palette, not a
    // hardcoded semantic scheme (see app/src/lib/badgeAccent.ts).
    expect(badgeMatch?.[0]).toMatch(/colorScheme=\{BADGE_ACCENT\.awaiting\}/);
    expect(badgeMatch?.[0]).toMatch(/variant="subtle"/);
  });
});

// ── i18n smoke check (keys already exist from S1) ──────────────────────────

describe('S4 outbound-request card i18n keys', () => {
  it('English copy has non-empty awaitingBadgeLabel and cancelOutboundRequestLabel', () => {
    const en = getCopy('en');
    expect(typeof en.groups.awaitingBadgeLabel).toBe('string');
    expect(en.groups.awaitingBadgeLabel.length).toBeGreaterThan(0);
    expect(typeof en.groups.cancelOutboundRequestLabel).toBe('string');
    expect(en.groups.cancelOutboundRequestLabel.length).toBeGreaterThan(0);
  });

  it('German copy has non-empty awaitingBadgeLabel and cancelOutboundRequestLabel', () => {
    const de = getCopy('de');
    expect(typeof de.groups.awaitingBadgeLabel).toBe('string');
    expect(de.groups.awaitingBadgeLabel.length).toBeGreaterThan(0);
    expect(typeof de.groups.cancelOutboundRequestLabel).toBe('string');
    expect(de.groups.cancelOutboundRequestLabel.length).toBeGreaterThan(0);
  });
});

// ── groups.tsx wiring (Task 2) ──────────────────────────────────────────────

describe('groups.tsx — OutboundJoinRequestCard wiring', () => {
  it('imports OutboundJoinRequestCard from the new component file', () => {
    expect(GROUPS_PAGE_SOURCE).toMatch(
      /import OutboundJoinRequestCard from ['"]@\/src\/components\/groups\/OutboundJoinRequestCard['"]/,
    );
  });

  it('calls useOutboundJoinRequests()', () => {
    expect(GROUPS_PAGE_SOURCE).toMatch(/useOutboundJoinRequests\(\)/);
  });

  it('renders <OutboundJoinRequestCard inside the list block via outboundRecords.map(', () => {
    expect(GROUPS_PAGE_SOURCE).toMatch(/outboundRecords\.map\(/);
    expect(GROUPS_PAGE_SOURCE).toMatch(/<OutboundJoinRequestCard\b/);
  });

  it("the empty-state Alert's condition requires both no groups and no outbound records", () => {
    // Robust to extra leading conjuncts (e.g. the `outboundLoaded` gate): assert
    // the stable core conjunction rather than anchoring on the full condition.
    expect(GROUPS_PAGE_CODE).toMatch(/groups\.length === 0 && outboundRecords\.length === 0/);
  });

  it('gates the empty state on outboundLoaded so awaiting-only state does not flash empty (Codex P2)', () => {
    // The empty-state block must not treat an empty outbound set as authoritative
    // until the async outbound store has loaded.
    const emptyStateBlock = GROUPS_PAGE_CODE.match(
      /ready &&[^(]*groups\.length === 0[^(]*outboundRecords\.length === 0[^(]*\(/,
    );
    expect(emptyStateBlock).not.toBeNull();
    expect(emptyStateBlock?.[0]).toMatch(/outboundLoaded/);
  });

  it('the list-render condition includes outboundRecords.length > 0 alongside groups.length > 0', () => {
    const listMatch = GROUPS_PAGE_SOURCE.match(
      /\(ready \|\| waitingForLease\) && \(groups\.length > 0[^)]*\)/,
    );
    expect(listMatch).not.toBeNull();
    expect(listMatch?.[0]).toMatch(/outboundRecords\.length > 0/);
  });
});
