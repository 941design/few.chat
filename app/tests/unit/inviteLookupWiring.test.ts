/**
 * Source scan (no jsdom harness): the only thing a scan is needed for is that
 * inviteByNpub delegates to the lookup helper and passes a real verifier and a
 * raw-socket listed-relay request, and never puts listed relays in the NDK pool.
 * Behaviour lives in marmot/inviteeKeyPackageLookup.test.ts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../../src/context/MarmotContext.tsx'), 'utf8');
const start = src.indexOf('const inviteByNpub = useCallback(');
const body = src.slice(start, src.indexOf('// Out-of-band leave', start));

describe('inviteByNpub wiring', () => {
  it('delegates to the helper with a real verifier and a raw-socket listed-relay request', () => {
    expect(body).toContain('lookupInviteeKeyPackages(');
    expect(body).toContain('verifyEvent: verifyRelayEvent');
    expect(body).toContain('requestRelayOnce');
  });

  it('covers only what the pool request really asks: connected permanent relays, not saved or effective relays', () => {
    const dep = body.slice(body.indexOf('coveredRelayUrls:'), body.indexOf('},', body.indexOf('coveredRelayUrls:')));
    expect(dep).toContain('permanentAndConnectedRelays()');
    expect(dep).not.toContain('getEffectiveRelays');
    expect(dep).not.toContain('pool.relays');
  });

  it('never adds a listed relay to the NDK pool', () => {
    expect(body).not.toContain('NDKRelaySet');
    expect(body).not.toContain('pool.addRelay');
    expect(body).not.toContain('pool.removeRelay');
    expect(body).not.toContain('saveRelays');
  });
});
