// @vitest-environment node
/**
 * createProfileGroupHandler builds ONE one-shot gate (the one `createProfileHandler` owns for the legacy path it
 * spreads); the sink path's own gate is the per-group bounded one. An extra, unused construction is dead state.
 */
import { describe, expect, it, vi } from 'vitest';

const { constructed } = vi.hoisted(() => ({ constructed: { count: 0 } }));
vi.mock('@/src/lib/marmot/envelopeVerifier', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/src/lib/marmot/envelopeVerifier')>();
  return {
    ...real,
    createOneShotGate: () => {
      constructed.count += 1;
      return real.createOneShotGate();
    },
  };
});

import { createProfileGroupHandler } from '@/src/lib/marmot/handlers/profileHandler';

describe('createProfileGroupHandler', () => {
  it('constructs exactly one one-shot gate (no unused second one)', () => {
    const noop = vi.fn();
    createProfileGroupHandler({
      mergeMemberProfile: vi.fn(async () => undefined),
      clearPendingDirectInvite: vi.fn(async () => undefined),
      notifyProfileObserved: noop,
      recordRequestAnswered: vi.fn(async () => undefined),
      writeContactEntry: noop,
      setProfileVersion: noop,
      consumePendingDirectInviteMarker: vi.fn(async () => false),
      sendAnnouncement: vi.fn(async () => undefined),
      enqueue: noop,
    } as never);
    expect(constructed.count).toBe(1);
  });
});
