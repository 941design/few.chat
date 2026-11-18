// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import NDK, { NDKEvent } from '@nostr-dev-kit/ndk';
import { verifyEvent } from 'nostr-tools/pure';
import { createGroupRumorSender, createOwnRowTracker } from '@/src/lib/marmot/send';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createGroupProfileActions } from '@/src/lib/marmot/groupSessionProfile';
import { parseProfilePayload } from '@/src/lib/marmot/profileSync';
import { buildReactionRumor } from '@/src/lib/reactions/rumor';
import { POLL_OPEN_KIND, serialisePollOpen, parsePollOpen } from '@/src/lib/marmot/pollSync';
import { createJoinRequestSender } from '@/src/lib/marmot/joinRequestSender';
import { createGroupImageService, type GroupMediaGroup } from '@/src/lib/media/imageMessage';
import { clearAllMedia, groupMediaCachePort } from '@/src/lib/marmot/mediaPersistence';
import { publishBackup } from '@/src/lib/backup/relayBackup';
import { getEffectiveRelays, saveRelays } from '@/src/lib/relay';
import { STORAGE_KEYS } from '@/src/types';
import { attempts, cleanup, inviteWithContext, rebuild, SECRETS, startPeer, startRelay } from './privacyHarness';

const operations = ['chat', 'reaction', 'poll', 'image', 'profile', 'join', 'decline', 'backup', 'relays', 'create', 'invite-accept'] as const;
const hex = fc.hexaString({ minLength: 12, maxLength: 20 });

function localStore(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(),
    getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, String(v)); },
    removeItem: k => { values.delete(k); }, key: i => [...values.keys()][i] ?? null,
  };
}

afterEach(() => vi.restoreAllMocks());

it('AC-OBS-6: generated real-client flow sequences keep profiles out of published events', async () => {
  await fc.assert(fc.asyncProperty(
    hex, hex,
    fc.array(fc.constantFrom(...operations), { minLength: 1, maxLength: 10 }),
    async (nickSuffix, avatarSuffix, order) => {
      const nickname = `private-nick-${nickSuffix}`;
      const avatar = `https://example.test/private-avatar-${avatarSuffix}.png`;
      const profile = { nickname, avatar: { imageUrl: avatar } };
      const tracker = createOwnRowTracker({ ports: { setStatus: () => undefined } });
      vi.stubGlobal('localStorage', localStore());
      try {
        const { url } = await startRelay();
        const { url: newUrl } = await startRelay();
        saveRelays([url]);
        localStorage.setItem(STORAGE_KEYS.userProfile, JSON.stringify(profile));
        const alice = await startPeer(SECRETS.a, [url]);
        const bob = await startPeer(SECRETS.b, [url]);
        const carol = await startPeer(SECRETS.c, [url]);
        const { group } = await inviteWithContext(alice, bob, `private group ${nickSuffix}`);
        await expect.poll(() => bob.view.pending().length, { timeout: 15000 }).toBe(1);
        await expect.poll(() => bob.cards(), { timeout: 15000 }).toEqual([`private group ${nickSuffix}`]);
        let joined = await bob.actions.accept(bob.view.pending()[0].id);
        await group.synced();
        await joined.synced();
        const sender = createGroupRumorSender({ ownPubkey: alice.pubkey, tracker });
        const target = await sender.sendGroupRumor(group, 9, 'reaction target', []);
        await expect.poll(async () => (await bob.history.list(group.id)).some(e => e.rumor.id === target.id), { timeout: 15000 }).toBe(true);
        const signer = createPrivateKeySigner(SECRETS.a);
        const profileActions = createGroupProfileActions({ pubkey: alice.pubkey, signer, sender, writable: () => alice.account.handle.leaseHeld(), groupOf: async id => id === group.id ? group : undefined, profile: () => profile });
        const uploads: Uint8Array[] = [];
        const image = createGroupImageService({
          sender, cache: groupMediaCachePort, blossomServers: ['https://blossom.example.test'],
          upload: async bytes => { uploads.push(bytes); return `https://blossom.example.test/${createHash('sha256').update(bytes).digest('hex')}`; },
          download: async attachment => { const bytes = uploads.find(blob => createHash('sha256').update(blob).digest('hex') === attachment.ciphertextSha256); if (!bytes) throw new Error('missing Blossom blob'); return bytes; },
        });
        const ndk = new NDK({ explicitRelayUrls: [url] });
        // Capture the signed NDKEvent at its real publish boundary, then forward it over
        // the same real transport as the clients. The backup code constructs/signs it.
        const backupPublish = vi.spyOn(NDKEvent.prototype, 'publish').mockImplementation(async function (this: NDKEvent) {
          const event = { id: this.id, pubkey: this.pubkey, sig: this.sig!, kind: this.kind!, created_at: this.created_at!, tags: this.tags, content: this.content };
          expect(verifyEvent(event)).toBe(true);
          attempts.push(structuredClone(event));
          const result = await alice.account.transport.publish(getEffectiveRelays(), event);
          expect(Object.values(result).some(value => value.ok)).toBe(true);
          return new Set();
        });
        let configuredRelays = [url];
        for (const [index, operation] of order.entries()) {
          if (operation === 'chat' || operation === 'reaction' || operation === 'poll') {
            let result: { id: string };
            if (operation === 'reaction') {
              const draft = buildReactionRumor({ emoji: '+', targetMessageId: target.id, targetMessageKind: 9, selfPrivKeyHex: SECRETS.a, isRemoval: false });
              result = await sender.prepare(group, draft.kind, draft.content, draft.tags, { createdAt: draft.created_at + index }).send();
            } else if (operation === 'poll') {
              const content = serialisePollOpen({ id: `poll-${nickSuffix}-${index}`, title: 'Lunch?', options: [{ id: 'A', label: 'yes' }, { id: 'B', label: 'no' }], pollType: 'singlechoice', creatorPubkey: alice.pubkey });
              expect(parsePollOpen(content)).not.toBeNull();
              result = await sender.sendGroupRumor(group, POLL_OPEN_KIND, content, []);
            } else {
              result = await sender.sendGroupRumor(group, 9, `hello ${index}`, []);
            }
            await expect.poll(async () => (await bob.history.list(group.id)).some(e => e.rumor.id === result.id), { timeout: 15000 }).toBe(true);
          } else if (operation === 'image') {
            const full = Uint8Array.from({ length: 512 }, (_, i) => i % 251);
            const thumb = Uint8Array.from({ length: 128 }, (_, i) => (i * 3) % 251);
            const uploaded = uploads.length;
            const sent = await image.sendImage(group as unknown as GroupMediaGroup, { caption: 'image', full: { bytes: full, dim: '16x16' }, thumb: { bytes: thumb, dim: '4x4' }, baseName: 'privacy' });
            expect(uploads).toHaveLength(uploaded + 2);
            expect(Buffer.from(uploads[uploaded]).equals(Buffer.from(full))).toBe(false);
            expect(Buffer.from(uploads[uploaded + 1]).equals(Buffer.from(thumb))).toBe(false);
            await expect.poll(async () => (await bob.history.list(group.id)).some(e => e.rumor.id === sent.rumorId && e.rumor.tags.filter(t => t[0] === 'imeta').length === 2), { timeout: 15000 }).toBe(true);
            await clearAllMedia();
            expect(Buffer.from((await image.loadImage(joined, { imeta: sent.full.imeta })).bytes)).toEqual(Buffer.from(full));
            expect(Buffer.from((await image.loadImage(joined, { imeta: sent.thumb.imeta })).bytes)).toEqual(Buffer.from(thumb));
          } else if (operation === 'profile') {
            await profileActions.sendOwnProfile(group.id);
            await expect.poll(async () => (await bob.history.list(group.id)).some(e => { const p = e.rumor.kind === 0 && parseProfilePayload(e.rumor.content); return !!p && p.nickname === nickname && p.avatar?.imageUrl === avatar; }), { timeout: 15000 }).toBe(true);
          } else if (operation === 'join') {
            const saved: unknown[] = [];
            const join = createJoinRequestSender({ inbox: carol.account.handle.client.extensions, ownPubkey: carol.pubkey, now: Date.now, saveOutbound: async r => { saved.push(r); } });
            const before = attempts.length;
            await join.send({ adminPubkeyHex: alice.pubkey, nonce: `nonce-${nickSuffix}-${index}`, groupName: 'private group', requesterName: nickname });
            expect(saved).toHaveLength(1);
            expect(attempts.slice(before).some(e => e.kind === 1059)).toBe(true);
          } else if (operation === 'decline') {
            await inviteWithContext(alice, carol, `decline ${nickSuffix} ${index}`);
            await expect.poll(() => carol.view.pending().length, { timeout: 15000 }).toBe(1);
            const before = attempts.length;
            await carol.actions.decline(carol.view.pending()[0].id);
            await expect.poll(() => carol.view.pending().length, { timeout: 15000 }).toBe(0);
            expect(attempts.slice(before).some(e => e.kind === 1059)).toBe(true);
          } else if (operation === 'relays') {
            const before = attempts.length;
            const nextRelays = configuredRelays.length === 1 ? [url, newUrl] : [url];
            saveRelays(nextRelays);
            expect(localStorage.getItem(STORAGE_KEYS.relays)).toBe(JSON.stringify(nextRelays));
            await rebuild(bob, nextRelays, configuredRelays);
            configuredRelays = nextRelays;
            expect(attempts.slice(before).some(e => e.kind === 10050)).toBe(true);
            const reopened = await bob.account.handle.client.groups.get(group.id);
            if (!reopened) throw new Error('joined group missing after relay rebuild');
            joined = reopened;
            await joined.synced();
          } else if (operation === 'create') {
            const group = await alice.account.handle.client.groups.create(`created ${index}`);
            expect(group.id).toBeTruthy();
          } else if (operation === 'invite-accept') {
            const { group: extra } = await inviteWithContext(alice, bob, `extra ${index}`);
            await expect.poll(() => bob.view.pending().length, { timeout: 15000 }).toBe(1);
            expect((await bob.actions.accept(bob.view.pending()[0].id)).id).toBe(extra.id);
          } else {
            const before = backupPublish.mock.calls.length;
            expect(await publishBackup(signer, alice.pubkey, ndk)).toEqual({ ok: true });
            expect(backupPublish.mock.calls.length).toBe(before + 1);
            const backup = attempts.filter(e => e.kind === 30078).at(-1)!;
            expect(backup).toBeDefined();
            expect(Buffer.from(backup.content, 'base64')[0]).toBe(2);
            expect(JSON.parse(await signer.nip44!.decrypt(alice.pubkey, backup.content)).userProfile).toEqual(profile);
          }
        }
        for (const event of attempts) {
          expect(event.kind).not.toBe(0);
          expect(event.kind).not.toBe(21064);
          if (event.kind !== 1059 && event.kind !== 445) {
            expect(JSON.stringify(event)).not.toContain(nickname);
            expect(JSON.stringify(event)).not.toContain(avatar);
          }
        }
        expect(attempts.some(e => e.kind === 30078)).toBe(order.includes('backup'));
        expect(attempts.some(e => e.kind === 30443)).toBe(true);
        expect(attempts.some(e => e.kind === 10050)).toBe(true);
        backupPublish.mockRestore();
      } finally {
        tracker.dispose();
        await cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  ), { seed: 19062026, numRuns: 200, examples: [['123456789abc', '23456789abcd', [...operations]]], endOnFailure: true });
}, 1_200_000);
