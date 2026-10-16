/**
 * Unit tests for the ATTACHMENTS_ENABLED feature toggle (app/src/config/features.ts).
 *
 * Message attachments are being deprecated. The feature code is retained; the
 * toggle removes every entry point that can COMPOSE a new attachment. ChatBox
 * is the single composer behind all three surfaces (contacts/DM, groups, and
 * the developer/feedback channel), and it has three distinct attach entry
 * points — the attach button, drag/drop, and clipboard paste.
 *
 * Those three drifting apart is this feature's known failure mode: the
 * block-contact epic shipped a gate that covered the button but not paste/drop
 * (see contactChat-block-gating.test.ts and feedback-block-gating.test.ts's own
 * doc comments). This file exists to make a partial gate fail loudly, by
 * proving all three consult ONE derived flag rather than re-deriving their own.
 *
 * Convention (no jsdom/@testing-library in this repo — see
 * contactChat-block-gating.test.ts): ChatBox.tsx is a Chakra/React component
 * that cannot be mounted here, so its wiring is proved by a source assertion,
 * and the gate expression itself is proved behaviorally against the real
 * exported constant.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ATTACHMENTS_ENABLED } from '@/src/config/features';

const __filename_ = fileURLToPath(import.meta.url);
const CHATBOX_PATH = path.resolve(path.dirname(__filename_), '../../src/components/chat/ChatBox.tsx');
const chatBoxSource = fs.readFileSync(CHATBOX_PATH, 'utf8');

describe('ATTACHMENTS_ENABLED (feature toggle)', () => {
  it('is OFF — attachments are deprecated and must not be composable on any surface', () => {
    expect(ATTACHMENTS_ENABLED).toBe(false);
  });
});

describe('ChatBox attach entry points are gated by the toggle', () => {
  it('derives one effective flag from ATTACHMENTS_ENABLED and the caller prop', () => {
    expect(chatBoxSource).toMatch(
      /const imageAttachmentsAllowed = ATTACHMENTS_ENABLED && allowImageAttachments;/,
    );
  });

  it('gates the drag/drop and paste handlers on the effective flag', () => {
    const gateCount = (chatBoxSource.match(/if \(!imageAttachmentsAllowed\) return;/g) ?? []).length;
    expect(gateCount).toBe(2); // handleDrop + handlePaste
  });

  it('gates the attach button render on the effective flag', () => {
    expect(chatBoxSource).toMatch(/\{imageAttachmentsAllowed && !editingMessage \?/);
  });

  it('no entry point gates on the raw caller prop, which would bypass the toggle', () => {
    expect(chatBoxSource).not.toMatch(/if \(!allowImageAttachments\) return;/);
    expect(chatBoxSource).not.toMatch(/\{allowImageAttachments &&/);
  });
});

/**
 * The gate expression itself. `imageAttachmentsAllowed` lives inside a React
 * component body and cannot be imported, so this mirrors its exact one-line
 * shape (asserted verbatim in the source test above) and drives it against the
 * REAL constant — proving the toggle can only ever REMOVE the attach surface
 * and never grant it to a caller that opted out (the sealed feedback channel).
 */
const effectiveGate = (allowImageAttachments: boolean) => ATTACHMENTS_ENABLED && allowImageAttachments;

describe('effective attach gate', () => {
  it('is off for a surface that allows attachments (contacts, groups) while the toggle is off', () => {
    expect(effectiveGate(true)).toBe(false);
  });

  it('is off for a surface that opts out (developer/feedback channel)', () => {
    expect(effectiveGate(false)).toBe(false);
  });

  it('keeps the caller opt-out ANDed in, so re-enabling the toggle cannot resurrect attachments on the sealed feedback channel', () => {
    // The `&& allowImageAttachments` conjunct is what preserves ContactChat's
    // `allowImageAttachments={!isFeedback}` contract when the toggle
    // flips back on. Asserted on the source (the gate lives in a component
    // body and cannot be re-evaluated here with a different constant).
    expect(chatBoxSource).toMatch(/ATTACHMENTS_ENABLED && allowImageAttachments/);
  });
});
