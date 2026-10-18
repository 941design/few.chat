/**
 * Source scan (no jsdom): the subscription callbacks of MarmotContext run their
 * async work through runTracked, so a stale-Welcome replace waits for it (bug
 * replace-does-not-await-onmemberschanged). Behaviour is covered by
 * replaceTeardown.test.ts and membersChangedSync.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '../../../src/context/MarmotContext.tsx'), 'utf-8');

describe('MarmotContext subscription callbacks are tracked per group', () => {
  it('onMembersChanged runs syncOnMembersChanged through runTracked and logs failures', () => {
    expect(src).toMatch(
      /\(currentMembers\) =>\s*void runTracked\(pendingDrainRef\.current, group\.id, \(\) =>\s*syncOnMembersChanged\(currentMembers,[\s\S]*?\)\.catch\(/,
    );
  });

  it('the auto-commit is gated on the replace marker, not only on the current run', () => {
    expect(src).toMatch(/mayCommit: \(\) => clientRef\.current === client && !replacingRef\.current\.has\(group\.id\)/);
  });

  it('the history-synced profile send runs through runTracked', () => {
    expect(src).toMatch(
      /profilePublishInFlightRef\.current\.add\(group\.id\);[\s\S]{0,200}void runTracked\(pendingDrainRef\.current, group\.id, async \(\) => \{/,
    );
    expect(src).not.toMatch(/void \(async \(\) => \{\s*try \{\s*\/\/ AC-SEND-10/);
  });
});
