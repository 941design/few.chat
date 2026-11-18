import { expect, type Page } from '@playwright/test';
import { nip44 } from 'nostr-tools';
import { queryRelayForEvents } from './relay-query';

export async function waitForProfileBackup(page: Page, pubkey: string, nickname: string, newerThan: number): Promise<void> {
  const secret = await page.evaluate(() => JSON.parse(localStorage.getItem('lp_nostrIdentity_v1') ?? '{}').privateKeyHex as string);
  const key = nip44.getConversationKey(Buffer.from(secret, 'hex'), pubkey);
  await expect.poll(async () => {
    const events = await queryRelayForEvents(page, { kinds: [30078], authors: [pubkey] });
    const event = events.find(({ created_at, tags }) =>
      created_at > newerThan && tags.some(([name, value]) => name === 'd' && value === 'few'));
    if (!event) return null;
    const payload = JSON.parse(nip44.decrypt(event.content, key));
    expect(Object.keys(payload).sort()).toEqual(['createdAt', 'settings', 'userProfile', 'version']);
    return payload.userProfile?.nickname;
  }, { timeout: 90_000 }).toBe(nickname);
}
