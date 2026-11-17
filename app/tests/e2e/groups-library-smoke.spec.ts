/**
 * TEMPORARY smoke / bundling proof for the @941design/marmot adoption
 * (epic marmot-library-adoption, D15, AC-TEST-7, AC-GATE-1). Deleted in the
 * last story of the epic together with the dev-only `__fewTest.groupLibrary`
 * hook (app/src/lib/testHooks/groupLibrary.ts).
 *
 * It boots the NEW client stack (client/ module: IndexedDB storage, SimplePool
 * transport, real library) in two browser contexts next to the untouched old
 * flow, over the strfry relay, with a throwaway recording HistoryBackend, and
 * verifies the library assumptions the epic's design rests on:
 *
 *   A3  an own message is delivered through the sink after confirmation;
 *   A1  an `append` that throws once is retried and eventually applied;
 *   A2  after a rewind (same-epoch fork) `withdraw` is called with the
 *       kind-445 event id of the message the abandoned branch delivered.
 *
 * Publishing goes through the app's own client (the hook), never a raw
 * WebSocket from the test process. Fresh random identities are used so key
 * packages other specs left on the relay can never be picked for the invite.
 *
 * Requires the strfry relay harness: make e2e-up / make test-e2e-groups.
 * Single-spec run: E2E_GROUPS=1 node scripts/run-e2e.mjs groups-library-smoke
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { suppressErrorOverlay } from './helpers/dismiss-error-overlay';
import { queryRelayForEvents } from './helpers/relay-query';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const RELAY_URL = process.env.E2E_RELAY_URL ?? 'ws://localhost:7777';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

type RetainedRow = { eventId: string; rumorId: string; account: string; content: string };
type AppendCall = { groupId: string; eventId: string; rumorId: string; account: string; threw: boolean };
type WithdrawCall = { groupId: string; eventIds: string[] };

/** Typed access to the dev hook from inside the page. */
const lib = {
  start: (p: Page, privateKeyHex: string) =>
    p.evaluate(
      ({ privateKeyHex, relay }) =>
        (window as any).__fewTest.groupLibrary.start({ privateKeyHex, relays: [relay], historyTimeoutMs: 2000 }) as Promise<{ pubkey: string }>,
      { privateKeyHex, relay: RELAY_URL },
    ),
  createGroup: (p: Page, name: string, admins: string[]) =>
    p.evaluate(({ name, admins }) => (window as any).__fewTest.groupLibrary.createGroup(name, { admins }) as Promise<{ groupId: string }>, { name, admins }),
  invite: (p: Page, groupId: string, pubkey: string) =>
    p.evaluate(({ groupId, pubkey }) => (window as any).__fewTest.groupLibrary.inviteByPubkey(groupId, pubkey) as Promise<{ status: string }[]>, { groupId, pubkey }),
  pendingCount: (p: Page) => p.evaluate(() => (window as any).__fewTest.groupLibrary.pendingCount() as Promise<number>),
  acceptFirstPending: (p: Page) => p.evaluate(() => (window as any).__fewTest.groupLibrary.acceptFirstPending() as Promise<string | null>),
  waitSynced: (p: Page, groupId: string) => p.evaluate((g) => (window as any).__fewTest.groupLibrary.waitSynced(g) as Promise<void>, groupId),
  send: (p: Page, groupId: string, content: string) =>
    p.evaluate(({ groupId, content }) => (window as any).__fewTest.groupLibrary.send(groupId, content) as Promise<{ rumorId: string }>, { groupId, content }),
  retained: (p: Page, groupId: string) => p.evaluate((g) => (window as any).__fewTest.groupLibrary.retained(g) as RetainedRow[], groupId),
  appendCalls: (p: Page) => p.evaluate(() => (window as any).__fewTest.groupLibrary.appendCalls() as AppendCall[]),
  withdrawCalls: (p: Page) => p.evaluate(() => (window as any).__fewTest.groupLibrary.withdrawCalls() as WithdrawCall[]),
  failNextAppends: (p: Page, n: number) => p.evaluate((n) => (window as any).__fewTest.groupLibrary.failNextAppends(n), n),
  setPartition: (p: Page, on: boolean) => p.evaluate((on) => (window as any).__fewTest.groupLibrary.setPartition(on), on),
  renameNoWait: (p: Page, groupId: string, name: string) =>
    p.evaluate(({ groupId, name }) => (window as any).__fewTest.groupLibrary.renameNoWait(groupId, name), { groupId, name }),
  nostrGroupId: (p: Page, groupId: string) => p.evaluate((g) => (window as any).__fewTest.groupLibrary.groupInfo(g).nostrGroupId as string, groupId),
  epoch: (p: Page, groupId: string) => p.evaluate((g) => (window as any).__fewTest.groupLibrary.groupInfo(g).epoch as string, groupId),
};

async function openPage(browser: { newContext: (o: object) => Promise<BrowserContext> }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  await suppressErrorOverlay(context);
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__fewTest?.groupLibrary, undefined, { timeout: 90_000 });
  return { context, page };
}

test.describe.serial('Library smoke: HistoryBackend assumptions A1-A3 (temporary)', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let pubA = '';
  let pubB = '';
  let groupId = '';
  /** Scopes every kind-445 relay query to this test's group (the relay caps unfiltered results). */
  let wireFilter: { kinds: number[]; '#h': string[] } = { kinds: [445], '#h': [] };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    ({ context: ctxA, page: pageA } = await openPage(browser));
    ({ context: ctxB, page: pageB } = await openPage(browser));
    const secretA = hex(generateSecretKey());
    const secretB = hex(generateSecretKey());
    pubA = getPublicKey(Uint8Array.from(Buffer.from(secretA, 'hex')));
    pubB = getPublicKey(Uint8Array.from(Buffer.from(secretB, 'hex')));
    expect((await lib.start(pageA, secretA)).pubkey).toBe(pubA);
    expect((await lib.start(pageB, secretB)).pubkey).toBe(pubB);

    // Both clients published exactly one key package (bootstrap ensure, kind 30443, never 443).
    await expect.poll(async () => (await queryRelayForEvents(pageA, { kinds: [30443], authors: [pubA, pubB] })).length, { timeout: 30_000 }).toBe(2);
    expect(await queryRelayForEvents(pageA, { kinds: [443], authors: [pubA, pubB] })).toHaveLength(0);

    ({ groupId } = await lib.createGroup(pageA, 'Library smoke', [pubB]));
    const outcome = await lib.invite(pageA, groupId, pubB);
    expect(outcome[0].status).toBe('delivered');
    await expect.poll(() => lib.pendingCount(pageB), { timeout: 60_000 }).toBe(1);
    expect(await lib.acceptFirstPending(pageB)).toBe(groupId);
    await lib.waitSynced(pageA, groupId);
    await lib.waitSynced(pageB, groupId);
    wireFilter = { kinds: [445], '#h': [await lib.nostrGroupId(pageA, groupId)] };
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('A3: an own message is delivered through the sink after confirmation, authored by the sender', async () => {
    const { rumorId } = await lib.send(pageA, groupId, 'own echo through the sink');
    await expect.poll(async () => (await lib.retained(pageA, groupId)).map((r) => r.rumorId), { timeout: 30_000 }).toContain(rumorId);
    await expect.poll(async () => (await lib.retained(pageB, groupId)).map((r) => r.rumorId), { timeout: 30_000 }).toContain(rumorId);

    const own = (await lib.retained(pageA, groupId)).find((r) => r.rumorId === rumorId)!;
    expect(own.account).toBe(pubA);
    expect(own.content).toBe('own echo through the sink');
    expect((await lib.retained(pageB, groupId)).find((r) => r.rumorId === rumorId)!.account).toBe(pubA);

    // The sink entry is keyed by the kind-445 event id that carried the rumor.
    expect(own.eventId).not.toBe(rumorId);
    const wire = await queryRelayForEvents(pageA, { ids: [own.eventId] });
    expect(wire.map((e) => e.id)).toContain(own.eventId);
  });

  test('A1: an append that throws once is retried for the same event and eventually applied', async () => {
    await lib.failNextAppends(pageA, 1);
    const { rumorId } = await lib.send(pageA, groupId, 'append fails once');
    await expect.poll(async () => (await lib.retained(pageA, groupId)).map((r) => r.rumorId), { timeout: 60_000 }).toContain(rumorId);

    const calls = (await lib.appendCalls(pageA)).filter((c) => c.rumorId === rumorId);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].threw).toBe(true);
    expect(calls[calls.length - 1].threw).toBe(false);
    expect(new Set(calls.map((c) => c.eventId)).size).toBe(1);
  });

  test('A2: after a same-epoch fork, withdraw is called with the abandoned branch message kind-445 id', async () => {
    expect(await lib.epoch(pageB, groupId)).toBe(await lib.epoch(pageA, groupId));
    const withdrawsBeforeA = (await lib.withdrawCalls(pageA)).length;
    const withdrawsBeforeB = (await lib.withdrawCalls(pageB)).length;
    const withdrawsBefore = withdrawsBeforeA + withdrawsBeforeB;

    const wireBefore = (await queryRelayForEvents(pageA, wireFilter)).length;

    // Stage the fork: both admins commit from the same epoch while neither can hear the other.
    await lib.setPartition(pageA, true);
    await lib.setPartition(pageB, true);
    await lib.renameNoWait(pageA, groupId, 'A-branch');
    await lib.renameNoWait(pageB, groupId, 'B-branch');
    await expect.poll(async () => (await queryRelayForEvents(pageA, wireFilter)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(wireBefore + 2);
    const sentA = await lib.send(pageA, groupId, 'on branch A');
    const sentB = await lib.send(pageB, groupId, 'on branch B');
    await expect.poll(async () => (await lib.retained(pageA, groupId)).map((r) => r.rumorId), { timeout: 30_000 }).toContain(sentA.rumorId);
    await expect.poll(async () => (await lib.retained(pageB, groupId)).map((r) => r.rumorId), { timeout: 30_000 }).toContain(sentB.rumorId);
    const eventIdOf = async (p: Page, rumorId: string) => (await lib.retained(p, groupId)).find((r) => r.rumorId === rumorId)!.eventId;
    const eventIdA = await eventIdOf(pageA, sentA.rumorId);
    const eventIdB = await eventIdOf(pageB, sentB.rumorId);

    await lib.setPartition(pageA, false);
    await lib.setPartition(pageB, false);

    // Exactly one branch loses: its sink is told to withdraw that message's kind-445 id.
    await expect
      .poll(async () => (await lib.withdrawCalls(pageA)).length + (await lib.withdrawCalls(pageB)).length, { timeout: 60_000 })
      .toBe(withdrawsBefore + 1);
    const aLost = (await lib.withdrawCalls(pageA)).length - withdrawsBeforeA === 1;
    const loser = aLost
      ? { page: pageA, before: withdrawsBeforeA, own: eventIdA, ownRumor: sentA.rumorId, otherRumor: sentB.rumorId }
      : { page: pageB, before: withdrawsBeforeB, own: eventIdB, ownRumor: sentB.rumorId, otherRumor: sentA.rumorId };
    const winnerPage = aLost ? pageB : pageA;
    const winnerBefore = aLost ? withdrawsBeforeB : withdrawsBeforeA;

    const call = (await lib.withdrawCalls(loser.page)).slice(loser.before)[0];
    expect(call.groupId).toBe(groupId);
    expect(call.eventIds).toEqual([loser.own]);
    expect((await queryRelayForEvents(pageA, { ids: [loser.own] })).map((e) => e.id)).toContain(loser.own);
    expect((await lib.withdrawCalls(winnerPage)).slice(winnerBefore)).toEqual([]);

    // The withdrawn message left the loser's sink; the winning branch's message reached both.
    await expect.poll(async () => (await lib.retained(loser.page, groupId)).map((r) => r.rumorId), { timeout: 60_000 }).not.toContain(loser.ownRumor);
    await expect.poll(async () => (await lib.retained(loser.page, groupId)).map((r) => r.rumorId), { timeout: 60_000 }).toContain(loser.otherRumor);
    expect((await lib.retained(winnerPage, groupId)).map((r) => r.rumorId)).toContain(loser.otherRumor);
    expect(await lib.epoch(pageA, groupId)).toBe(await lib.epoch(pageB, groupId));
  });
});
