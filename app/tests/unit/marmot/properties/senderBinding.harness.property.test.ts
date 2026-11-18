// @vitest-environment node
import { expect, it } from 'vitest';
import fc from 'fast-check';
import { getEventHash } from 'nostr-tools/pure';
import { startPeer, pairedGroup, inviteInto, SECRET_ALICE, SECRET_MALLORY } from './senderBindingHarness';

it('AC-OBS-7: generated genuine, forged and replayed rumors have exactly the genuine rows at an independent observer', async () => {
  const alice = await startPeer(SECRET_ALICE, 'sender-alice');
  const mallory = await startPeer(SECRET_MALLORY, 'sender-mallory');
  const observer = await startPeer('c3'.repeat(32), 'observer');
  const groupId = await pairedGroup(alice, mallory);
  await inviteInto(alice, observer, await alice.group(groupId));
  let serial = 0;
  const expected: Array<{ id: string; senderPubkey: string; content: string }> = [];
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('genuine', 'forged', 'replay'), { minLength: 1, maxLength: 5 }), async (generated) => {
    const operations = generated;
    for (const operation of operations) {
      const content = `property-${serial++}-${operation}`;
      if (operation === 'genuine') {
        const id = await mallory.send(groupId, content);
        expected.push({ id, senderPubkey: mallory.pubkey, content });
      } else if (operation === 'forged') {
        await mallory.send(groupId, content, alice.pubkey);
      } else {
        const unsigned = { pubkey: alice.pubkey, created_at: Math.floor(Date.now() / 1000), kind: 9, tags: [] as string[][], content };
        const rumor = { ...unsigned, id: getEventHash(unsigned) };
        await (await alice.group(groupId)).send({ type: 'application', rumor });
        expected.push({ id: rumor.id, senderPubkey: alice.pubkey, content });
        await (await mallory.group(groupId)).send({ type: 'application', rumor });
      }
    }
    const content = `control-${serial++}`;
    const id = await mallory.send(groupId, content);
    expected.push({ id, senderPubkey: mallory.pubkey, content });
    await expect.poll(async () => (await observer.rows(groupId)).some(row => row.id === id), { timeout: 15000 }).toBe(true);
    await expect.poll(async () => (await observer.rows(groupId)).length, { timeout: 15000 }).toBe(expected.length);
    const sorted = (rows: typeof expected) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted(await observer.rows(groupId))).toEqual(sorted(expected));
  }), { seed: 19072026, numRuns: 200, examples: [[['genuine', 'forged', 'replay']]], endOnFailure: true });
}, 900_000);
