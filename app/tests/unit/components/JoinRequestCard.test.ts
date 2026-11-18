/**
 * JoinRequestCard.test.ts — unit tests for the S1 name-gate's pure predicates
 * (epic: group-invite-link-onboarding, story S1; AC-GATE-1..7, AC-INTL-1/2).
 *
 * This repo has NO jsdom / @testing-library / component-render / snapshot
 * capability (vitest only — see exploration.json's testing conventions and
 * ProfileHealWatcher.test.ts / ThemeIcon.test.ts's precedent for a component
 * file exporting pure helpers tested with no DOM at all). AC-GATE-4's "renders
 * as today" claim and AC-GATE-6/7's full guard-ordering behavior are verified
 * via e2e in S5 (AC-ETE-1/2), not here — this file covers exactly what a pure
 * function can prove: the gate's on/off predicate (AC-GATE-1/4) and the
 * button's reactive disabled predicate (AC-GATE-3), plus static source-level
 * scope/boundary assertions (VQ-S1-002, VQ-S1-005, VQ-S1-006) and i18n
 * coverage (AC-INTL-1/2).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isNameGateActive, isJoinRequestDisabled } from '@/src/components/groups/JoinRequestCard';
import { getCopy } from '@/src/lib/i18n';

// ── isNameGateActive — gate on/off (AC-GATE-1, AC-GATE-4) ──────────────────

describe('isNameGateActive', () => {
  it('is active (true) for an empty nickname', () => {
    expect(isNameGateActive('')).toBe(true);
  });

  it('is active (true) for a whitespace-only nickname', () => {
    expect(isNameGateActive('   ')).toBe(true);
  });

  it('is inactive (false) for a real nickname — named users see today\'s card (AC-GATE-4)', () => {
    expect(isNameGateActive('Alice')).toBe(false);
  });

  it('is inactive (false) for a nickname with incidental surrounding whitespace', () => {
    expect(isNameGateActive('  Alice  ')).toBe(false);
  });

  it('delegates to hasShareableName\'s exact trim semantics rather than re-deriving "has a name"', () => {
    // hasShareableName trims before checking length — a single non-space
    // control/unicode whitespace character alone must still gate.
    expect(isNameGateActive('\t\n')).toBe(true);
  });
});

// ── isJoinRequestDisabled — reactive button gate (AC-GATE-3) ───────────────

describe('isJoinRequestDisabled', () => {
  it('is always false when the gate is inactive, regardless of draft content', () => {
    expect(isJoinRequestDisabled(false, '')).toBe(false);
    expect(isJoinRequestDisabled(false, '   ')).toBe(false);
    expect(isJoinRequestDisabled(false, 'Bob')).toBe(false);
  });

  it('is true when the gate is active and the draft is empty', () => {
    expect(isJoinRequestDisabled(true, '')).toBe(true);
  });

  it('is true when the gate is active and the draft is whitespace-only', () => {
    expect(isJoinRequestDisabled(true, '   ')).toBe(true);
  });

  it('is false when the gate is active and the draft satisfies hasShareableName', () => {
    expect(isJoinRequestDisabled(true, 'Bob')).toBe(false);
  });

  it('is reactive within one continuous sequence: typing enables, clearing disables again (AC-GATE-3, not evaluated once on mount)', () => {
    // Simulates the same mounted instance's draft value changing across
    // keystrokes — one sequence of calls, not two separate fresh loads.
    const gateActive = true;
    expect(isJoinRequestDisabled(gateActive, '')).toBe(true); // nothing typed yet
    expect(isJoinRequestDisabled(gateActive, 'B')).toBe(false); // first keystroke enables
    expect(isJoinRequestDisabled(gateActive, 'Bo')).toBe(false);
    expect(isJoinRequestDisabled(gateActive, 'Bob')).toBe(false);
    expect(isJoinRequestDisabled(gateActive, '')).toBe(true); // cleared back to nameless: disabled again
  });
});

// ── i18n coverage (AC-INTL-1, AC-INTL-2) ────────────────────────────────────

describe('S1 name-gate i18n keys', () => {
  it('English copy has non-empty joinRequestName* keys under copy.groups', () => {
    const en = getCopy('en');
    expect(typeof en.groups.joinRequestNameLabel).toBe('string');
    expect(en.groups.joinRequestNameLabel.length).toBeGreaterThan(0);
    expect(typeof en.groups.joinRequestNameHelper).toBe('string');
    expect(en.groups.joinRequestNameHelper.length).toBeGreaterThan(0);
    expect(typeof en.groups.joinRequestNameRequiredHint).toBe('string');
    expect(en.groups.joinRequestNameRequiredHint.length).toBeGreaterThan(0);
  });

  it('German copy has non-empty, distinct joinRequestName* keys under copy.groups', () => {
    const de = getCopy('de');
    expect(typeof de.groups.joinRequestNameLabel).toBe('string');
    expect(de.groups.joinRequestNameLabel.length).toBeGreaterThan(0);
    expect(typeof de.groups.joinRequestNameHelper).toBe('string');
    expect(de.groups.joinRequestNameHelper.length).toBeGreaterThan(0);
    expect(typeof de.groups.joinRequestNameRequiredHint).toBe('string');
    expect(de.groups.joinRequestNameRequiredHint.length).toBeGreaterThan(0);

    const en = getCopy('en');
    // Not a translation in name only — guards against a lazy copy-paste of
    // the English string into the German slot.
    expect(de.groups.joinRequestNameLabel).not.toBe(en.groups.joinRequestNameLabel);
    expect(de.groups.joinRequestNameHelper).not.toBe(en.groups.joinRequestNameHelper);
    expect(de.groups.joinRequestNameRequiredHint).not.toBe(en.groups.joinRequestNameRequiredHint);
  });
});

// ── Scope/boundary + no-bypass source assertions (VQ-S1-002/005/006) ───────

describe('JoinRequestCard.tsx — scope and boundary (VQ-S1-002, VQ-S1-005, VQ-S1-006)', () => {
  const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
  const APP_ROOT = path.resolve(TEST_FILE_DIR, '..', '..', '..'); // app/tests/unit/components -> app/
  const CARD_SOURCE = fs.readFileSync(
    path.join(APP_ROOT, 'src', 'components', 'groups', 'JoinRequestCard.tsx'),
    'utf8',
  );

  it('imports only the permitted cross-module exports — saveProfile/useProfile (ProfileContext) and hasShareableName (shareCard) — no new import of joinRequestHandler.ts, welcomeSubscription.ts, or outboundJoinRequests.ts', () => {
    expect(CARD_SOURCE).toMatch(/from ['"]@\/src\/context\/ProfileContext['"]/);
    expect(CARD_SOURCE).toMatch(/from ['"]@\/src\/lib\/shareCard['"]/);
    expect(CARD_SOURCE).not.toMatch(/from ['"][^'"]*joinRequestHandler['"]/);
    expect(CARD_SOURCE).not.toMatch(/from ['"][^'"]*welcomeSubscription['"]/);
    expect(CARD_SOURCE).not.toMatch(/from ['"][^'"]*outboundJoinRequests['"]/);
  });

  it('never redirects to /profile (DD-2 — the field renders in place on the join card)', () => {
    expect(CARD_SOURCE).not.toMatch(/router\.push\([^)]*\/profile/);
    expect(CARD_SOURCE).not.toMatch(/router\.replace\([^)]*\/profile/);
    expect(CARD_SOURCE).not.toMatch(/href=["'`]\/profile/);
  });

  it('writes the nickname exclusively through saveProfile — no second write path', () => {
    const nicknameLines = CARD_SOURCE.split('\n').filter((line) => /nickname/i.test(line));
    expect(nicknameLines.length).toBeGreaterThan(0);
    // Every occurrence of an assignment-shaped write must flow through
    // saveProfile(...); this does not forbid *reading* profile.nickname.
    const suspiciousWrite = nicknameLines.find(
      (line) => /writeUserProfile|localStorage\.setItem/.test(line),
    );
    expect(suspiciousWrite).toBeUndefined();
    expect(CARD_SOURCE).toMatch(/saveProfile\(/);
  });

  it('guards the send handler with the same isJoinRequestDisabled predicate used for the button\'s isDisabled prop (defense-in-depth against a bypassed click/Enter — VQ-S1-006; full runtime coverage is e2e-only, S5)', () => {
    expect(CARD_SOURCE).toMatch(/isDisabled=\{!ready \|\| requestDisabled\}/);
    // The async send handler must early-return when the gate says disabled,
    // not rely solely on the DOM disabled attribute.
    const handlerMatch = CARD_SOURCE.match(/async function handleSendRequest\(\)[\s\S]*?\n\}/);
    expect(handlerMatch).not.toBeNull();
    expect(handlerMatch?.[0]).toMatch(/requestDisabled/);
    expect(handlerMatch?.[0]).toMatch(/if \([^)]*!ready[^)]*\) return;/);
  });
});
