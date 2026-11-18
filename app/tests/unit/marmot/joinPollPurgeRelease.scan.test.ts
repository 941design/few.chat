/**
 * A group purge suppresses pending poll writes until the group is attached
 * again. Keep that release in the shared invitation attachment path.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('join choke point releases the poll purge mark', () => {
  it('releases the group poll mark when the leased session attaches an accepted group', () => {
    const membership = readFileSync(
      new URL('../../../src/lib/marmot/groupSessionMembership.ts', import.meta.url),
      'utf8',
    );
    expect(membership).toMatch(/const attachGroup = \(group: MarmotGroup[^]*?assertLease\(\);\s*releasePollPurgeMark\(id\);/);
    expect(membership).toMatch(/createInvitationActions\(\{[^}]*\battachGroup\b/);
  });
});
