/**
 * chatBoxPollOpenAttribution.test.ts — F1 (Stage-2 review, epic:
 * group-message-author-auth-app-layer S6): the `poll_open` chat
 * announcement's rendered creator must resolve from the protocol-
 * authenticated `msg.senderPubkey`, never from the self-reported
 * `structured.creatorPubkey` payload field — PollStoreContext.tsx sends
 * poll_open carrying `creatorPubkey` in the payload, and any member could
 * previously forge it to make "<victim> created a poll" render for
 * everyone.
 *
 * This repo has NO jsdom / @testing-library / component-render capability
 * (vitest only). Mirrors inviteLifecycleAnnouncement.test.ts's
 * "ChatBox.tsx new branch structural source-scan" convention: extract the
 * branch's source text and assert on it structurally, rather than
 * rendering.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TEST_FILE_DIR, '..', '..', '..'); // app/tests/unit/chat -> app/

function readSrc(...segments: string[]): string {
  return fs.readFileSync(path.join(APP_ROOT, 'src', ...segments), 'utf8');
}

describe('ChatBox.tsx — poll_open render branch attribution (F1)', () => {
  const source = readSrc('components', 'chat', 'ChatBox.tsx');
  // Anchor the span END to the branch's own return JSX (…/>;), matching the
  // invite_lifecycle branch's anchoring rationale: a brace-terminated span
  // can be silently truncated by an inner block or reindentation drift,
  // false-GREENing the creatorPubkey-absence assertion below.
  const branchMatch = source.match(
    /if \(structured\?\.type === 'poll_open'[\s\S]*?return <PollChatAnnouncement[\s\S]*?\/>;/,
  );

  it('the branch exists and was extracted', () => {
    expect(branchMatch).not.toBeNull();
  });

  const branch = branchMatch?.[0] ?? '';

  it('resolves creatorDisplay from msg.senderPubkey (the authenticated sender)', () => {
    expect(branch).toMatch(/creatorDisplay\s*=\s*profileMap\[msg\.senderPubkey\]/);
  });

  it('never reads structured.creatorPubkey for attribution (F1: the spoofable self-reported payload field)', () => {
    expect(branch).not.toMatch(/structured\.creatorPubkey/);
  });

  it('renders PollChatAnnouncement with a creatorName prop and structured.title', () => {
    expect(branch).toMatch(/<PollChatAnnouncement/);
    expect(branch).toMatch(/creatorName=\{creatorDisplay\}/);
    expect(branch).toMatch(/title=\{structured\.title\}/);
  });
});
