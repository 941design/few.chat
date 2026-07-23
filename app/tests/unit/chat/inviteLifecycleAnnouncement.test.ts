/**
 * inviteLifecycleAnnouncement.test.ts — unit tests for the S4 invite-lifecycle
 * chat announcement (epic: group-invite-lifecycle, story S4;
 * AC-RENDER-1/2/3, and the render-side half of AC-STRUCT-5's trust
 * boundary jointly exercised with S1's parse-side test).
 *
 * This repo has NO jsdom / @testing-library / component-render capability
 * (vitest only). Mirrors JoinRequestCard.test.ts (pure-function import from a
 * .tsx file + i18n key assertions + source-scan structural assertions) and
 * noGreyedOutPeople.test.ts (readSrc/APP_ROOT source-scan helper).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  resolveInviteLifecycleSubjectDisplay,
  selectInviteLifecycleCopy,
  type InviteLifecycleEvent,
} from '@/src/components/groups/InviteLifecycleChatAnnouncement';
import { getCopy } from '@/src/lib/i18n';

const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TEST_FILE_DIR, '..', '..', '..'); // app/tests/unit/chat -> app/

function readSrc(...segments: string[]): string {
  return fs.readFileSync(path.join(APP_ROOT, 'src', ...segments), 'utf8');
}

// ── i18n key trio (AC-RENDER-2, VQ-S4-008) ─────────────────────────────────

describe('invite_lifecycle i18n keys', () => {
  it('English copy exposes the 3 keys as functions with exact returned strings', () => {
    const en = getCopy('en');
    expect(typeof en.groups.inviteLifecycleInvited).toBe('function');
    expect(typeof en.groups.inviteLifecycleAccepted).toBe('function');
    expect(typeof en.groups.inviteLifecycleDeclined).toBe('function');

    expect(en.groups.inviteLifecycleInvited('Alice')).toBe('Alice was invited');
    expect(en.groups.inviteLifecycleAccepted('Alice')).toBe('Alice joined the group');
    expect(en.groups.inviteLifecycleDeclined('Alice')).toBe('Alice declined the invitation');
  });

  it('German copy exposes the 3 keys as functions with exact returned strings', () => {
    const de = getCopy('de');
    expect(typeof de.groups.inviteLifecycleInvited).toBe('function');
    expect(typeof de.groups.inviteLifecycleAccepted).toBe('function');
    expect(typeof de.groups.inviteLifecycleDeclined).toBe('function');

    expect(de.groups.inviteLifecycleInvited('Alice')).toBe('Alice wurde eingeladen');
    expect(de.groups.inviteLifecycleAccepted('Alice')).toBe('Alice ist der Gruppe beigetreten');
    expect(de.groups.inviteLifecycleDeclined('Alice')).toBe('Alice hat die Einladung abgelehnt');
  });

  it('the 3 EN strings are pairwise distinct from each other', () => {
    const en = getCopy('en');
    const invited = en.groups.inviteLifecycleInvited('Alice');
    const accepted = en.groups.inviteLifecycleAccepted('Alice');
    const declined = en.groups.inviteLifecycleDeclined('Alice');
    expect(invited).not.toBe(accepted);
    expect(invited).not.toBe(declined);
    expect(accepted).not.toBe(declined);
  });

  it('the 3 DE strings are pairwise distinct from each other', () => {
    const de = getCopy('de');
    const invited = de.groups.inviteLifecycleInvited('Alice');
    const accepted = de.groups.inviteLifecycleAccepted('Alice');
    const declined = de.groups.inviteLifecycleDeclined('Alice');
    expect(invited).not.toBe(accepted);
    expect(invited).not.toBe(declined);
    expect(accepted).not.toBe(declined);
  });

  it('each DE string is distinct from its EN counterpart (guards a copy-paste of the English string into the German slot)', () => {
    const en = getCopy('en');
    const de = getCopy('de');
    expect(de.groups.inviteLifecycleInvited('Alice')).not.toBe(en.groups.inviteLifecycleInvited('Alice'));
    expect(de.groups.inviteLifecycleAccepted('Alice')).not.toBe(en.groups.inviteLifecycleAccepted('Alice'));
    expect(de.groups.inviteLifecycleDeclined('Alice')).not.toBe(en.groups.inviteLifecycleDeclined('Alice'));
  });
});

// ── resolveInviteLifecycleSubjectDisplay (AC-RENDER-1) ─────────────────────

describe('resolveInviteLifecycleSubjectDisplay', () => {
  it('resolves a known profile\'s nickname, not the raw hex pubkey', () => {
    const profileMap = { aliceHex: { nickname: 'Alice' } };
    const result = resolveInviteLifecycleSubjectDisplay(
      'aliceHex',
      profileMap,
      (pk) => `trunc:${pk}`,
    );
    expect(result).toBe('Alice');
    expect(result).not.toBe('aliceHex');
  });

  it('falls back to the truncate callback\'s result when no profile entry matches (fallback path genuinely exercised, not hardcoded)', () => {
    const profileMap = {};
    const result = resolveInviteLifecycleSubjectDisplay(
      'unknownHex',
      profileMap,
      (pk) => `trunc:${pk}`,
    );
    expect(result).toBe('trunc:unknownHex');
  });

  // AC-STRUCT-5 render-time consequence (VQ-S4-005): S1's own test
  // (app/tests/unit/marmot/parseStructured.test.ts, "resolveCancellerDisplay
  // — trust boundary" describe block) covers the parse-side half of this
  // trust boundary in isolation. This is the joint render-side half: the
  // subject display must be anchored strictly to the payload pubkey
  // argument, never to a distinct sender/author pubkey that happens to be
  // present in the same profileMap.
  it('resolves strictly from the payload pubkey argument, never from an unrelated sender/author pubkey present in the same profileMap (AC-STRUCT-5 render-time consequence)', () => {
    const payloadPubkeyB = 'bobHex';
    const senderPubkeyC = 'malloryHex';
    const profileMap = {
      [payloadPubkeyB]: { nickname: 'Bob' },
      [senderPubkeyC]: { nickname: 'Mallory' },
    };
    const result = resolveInviteLifecycleSubjectDisplay(
      payloadPubkeyB,
      profileMap,
      (pk) => `trunc:${pk}`,
    );
    expect(result).toBe('Bob');
    expect(result).not.toBe('Mallory');
  });
});

// ── selectInviteLifecycleCopy (AC-RENDER-2, VQ-S4-006) ─────────────────────

describe('selectInviteLifecycleCopy', () => {
  const copy = getCopy('en');

  it('selects inviteLifecycleInvited copy for the invited event', () => {
    expect(selectInviteLifecycleCopy(copy, 'invited', 'Alice')).toBe(
      copy.groups.inviteLifecycleInvited('Alice'),
    );
  });

  it('selects inviteLifecycleAccepted copy for the accepted event', () => {
    expect(selectInviteLifecycleCopy(copy, 'accepted', 'Alice')).toBe(
      copy.groups.inviteLifecycleAccepted('Alice'),
    );
  });

  it('selects inviteLifecycleDeclined copy for the declined event', () => {
    expect(selectInviteLifecycleCopy(copy, 'declined', 'Alice')).toBe(
      copy.groups.inviteLifecycleDeclined('Alice'),
    );
  });

  it('the 3 returned strings for the same memberDisplay are pairwise distinct', () => {
    const invited = selectInviteLifecycleCopy(copy, 'invited', 'Alice');
    const accepted = selectInviteLifecycleCopy(copy, 'accepted', 'Alice');
    const declined = selectInviteLifecycleCopy(copy, 'declined', 'Alice');
    expect(invited).not.toBe(accepted);
    expect(invited).not.toBe(declined);
    expect(accepted).not.toBe(declined);
  });

  it('defensively returns memberDisplay (not undefined, not a throw) for an event value outside the 3-member enum', () => {
    const bogusEvent = 'revoked' as unknown as InviteLifecycleEvent;
    expect(() => selectInviteLifecycleCopy(copy, bogusEvent, 'Alice')).not.toThrow();
    expect(selectInviteLifecycleCopy(copy, bogusEvent, 'Alice')).toBe('Alice');
  });
});

// ── InviteLifecycleChatAnnouncement.tsx structural source-scan (AC-RENDER-3) ─

describe('InviteLifecycleChatAnnouncement.tsx — stable testid, no avatar, no edit/delete/reaction affordances', () => {
  const source = readSrc('components', 'groups', 'InviteLifecycleChatAnnouncement.tsx');

  it('renders the exact stable testid literal (not a dynamic/templated id)', () => {
    expect(source).toMatch(/data-testid="invite-lifecycle-announcement"/);
  });

  it('does not reference an avatar', () => {
    expect(source).not.toMatch(/Avatar/);
  });

  it('does not import or render any edit/delete/reaction affordance', () => {
    expect(source).not.toMatch(/IconButton/);
    expect(source).not.toMatch(/onDelete/);
    expect(source).not.toMatch(/onEdit/);
    expect(source).not.toMatch(/Reaction/);
  });
});

// ── ChatBox.tsx new branch structural source-scan (VQ-S4-002/003/005) ──────

describe('ChatBox.tsx — invite_lifecycle render branch', () => {
  const source = readSrc('components', 'chat', 'ChatBox.tsx');
  // Anchor the span END to the branch's own return JSX (…/>;), not to the first
  // 4-space-indented closing brace. A brace-terminated span can be silently
  // truncated by an inner block or reindentation drift, false-GREENing the
  // senderPubkey-absence assertion below (this source-scan is the sole guard on
  // the ChatBox call-site AC-STRUCT-5 wiring). The return-JSX anchor cannot be
  // truncated by an inner brace, so it captures the whole resolution body.
  const branchMatch = source.match(
    /if \(structured\?\.type === 'invite_lifecycle'[\s\S]*?return <InviteLifecycleChatAnnouncement[\s\S]*?\/>;/,
  );

  it('the branch exists and was extracted', () => {
    expect(branchMatch).not.toBeNull();
  });

  const branch = branchMatch?.[0] ?? '';

  it('calls resolveInviteLifecycleSubjectDisplay with structured.pubkey as the first argument', () => {
    expect(branch).toMatch(/resolveInviteLifecycleSubjectDisplay\(\s*structured\.pubkey/);
  });

  it('never sources author identity from msg.senderPubkey or any senderPubkey reference within this branch', () => {
    expect(branch).not.toMatch(/msg\.senderPubkey/);
    expect(branch).not.toMatch(/senderPubkey/);
  });

  it('renders InviteLifecycleChatAnnouncement with event={structured.event} and a memberDisplay prop', () => {
    expect(branch).toMatch(/<InviteLifecycleChatAnnouncement/);
    expect(branch).toMatch(/event=\{structured\.event\}/);
    expect(branch).toMatch(/memberDisplay=/);
  });
});
