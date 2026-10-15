/**
 * IncomingCallWatcher wires the block deny-list into CallManager
 * (BACKLOG gate-incoming-calls-with-block-deny). The deny itself — direct 1:1
 * calls only — is behaviour-tested in callManager.test.ts (T13-block); this
 * file pins the component wiring, which the repo's no-jsdom convention cannot
 * render (same source-assertion approach as the DM watcher's block-set ref).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE = fs.readFileSync(
  path.join(APP_ROOT, 'src', 'components', 'calls', 'IncomingCallWatcher.tsx'),
  'utf8',
);

describe('IncomingCallWatcher — block deny wiring', () => {
  it('passes an isBlockedCaller that reads the live blocked-peers ref', () => {
    expect(SOURCE).toMatch(/isBlockedCaller:\s*\(pk: string\)\s*=>\s*isBlockedPeer\(pk,\s*blockedPeersRef\.current\)/);
  });

  it('refreshes the blocked-peers ref when blockedPeersRevision bumps', () => {
    expect(SOURCE).toMatch(
      /blockedPeersRef\.current = loadBlockedPeers\(\);\s*\},\s*\[groups,\s*knownPeersRevision,\s*blockedPeersRevision\]\)/,
    );
  });
});
