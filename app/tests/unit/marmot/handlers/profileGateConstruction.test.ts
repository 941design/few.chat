// @vitest-environment node
/**
 * createProfileGroupHandler uses only its bounded per-group sink gate; no legacy gate is constructed.
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
  it('does not construct the legacy one-shot gate', () => {
    const noop = vi.fn();
    createProfileGroupHandler({
      mergeMemberProfile: vi.fn(async () => undefined),
      noteForwardedInviteProfile: vi.fn(async () => undefined),
      notifyProfileObserved: noop,
      recordRequestAnswered: vi.fn(async () => undefined),
      writeContactEntry: noop,
      setProfileVersion: noop,
      consumePendingDirectInviteMarker: vi.fn(async () => false),
      sendAnnouncement: vi.fn(async () => undefined),
      enqueue: noop,
    } as never);
    expect(constructed.count).toBe(0);
  });
});
