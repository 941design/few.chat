/**
 * buildDmProfileMap — the shared two-entry (self + one peer) MemberProfile map
 * every 1:1 DM surface (contact detail view, feedback page) hands to
 * ContactChat. Extracted from two verbatim copies in pages/contacts.tsx and
 * pages/feedback.tsx; these tests pin the pre-extraction semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDmProfileMap } from '@/src/lib/contacts';
import { pubkeyToNpub, truncateNpub } from '@/src/lib/nostrKeys';

const SELF = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const NOW = '2026-10-16T12:00:00.000Z';
const AVATAR = { imageUrl: 'https://example.invalid/a.png' };

describe('buildDmProfileMap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds exactly the self and peer entries', () => {
    const map = buildDmProfileMap({
      selfHex: SELF,
      selfProfile: { nickname: 'Me', avatar: AVATAR },
      peerHex: PEER,
      peerNickname: 'Peer',
      peerAvatar: null,
      peerUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(map).toEqual({
      [SELF]: { pubkeyHex: SELF, nickname: 'Me', avatar: AVATAR, updatedAt: NOW },
      [PEER]: { pubkeyHex: PEER, nickname: 'Peer', avatar: null, updatedAt: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('falls back to the truncated own npub when the own nickname is empty', () => {
    const map = buildDmProfileMap({
      selfHex: SELF,
      selfProfile: { nickname: '', avatar: null },
      peerHex: PEER,
      peerNickname: 'Peer',
      peerAvatar: null,
    });
    expect(map[SELF].nickname).toBe(truncateNpub(pubkeyToNpub(SELF)));
    expect(map[SELF].nickname).not.toBe('');
  });

  it.each([
    ['omitted', undefined, NOW],
    ['provided', '2025-05-05T05:05:05.000Z', '2025-05-05T05:05:05.000Z'],
  ])('peer updatedAt %s → %s; self updatedAt is always the build time', (_label, peerUpdatedAt, expected) => {
    const map = buildDmProfileMap({
      selfHex: SELF,
      selfProfile: { nickname: 'Me', avatar: null },
      peerHex: PEER,
      peerNickname: 'Peer',
      peerAvatar: AVATAR,
      peerUpdatedAt,
    });
    expect(map[PEER].updatedAt).toBe(expected);
    expect(map[PEER].avatar).toBe(AVATAR);
    expect(map[SELF].updatedAt).toBe(NOW);
  });

  it('passes the caller-resolved peer nickname through untouched (no own fallback applied to the peer)', () => {
    const map = buildDmProfileMap({
      selfHex: SELF,
      selfProfile: { nickname: 'Me', avatar: null },
      peerHex: PEER,
      peerNickname: '',
      peerAvatar: null,
    });
    expect(map[PEER].nickname).toBe('');
  });

  it('self === peer collapses to one entry and the peer entry wins (object-literal order)', () => {
    const map = buildDmProfileMap({
      selfHex: SELF,
      selfProfile: { nickname: 'Me', avatar: AVATAR },
      peerHex: SELF,
      peerNickname: 'AsPeer',
      peerAvatar: null,
      peerUpdatedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(Object.keys(map)).toEqual([SELF]);
    expect(map[SELF]).toEqual({
      pubkeyHex: SELF,
      nickname: 'AsPeer',
      avatar: null,
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
  });
});
