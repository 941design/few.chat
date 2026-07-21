/**
 * Unit tests for the retain-while-pending behavior of the inbound-DM watcher
 * (epic: pending-contact-notification, story S5 —
 * `subscribeDirectMessageNotifications` in `directMessageNotifications.ts`).
 *
 * Covers AC-DM-1 (a pending peer's DM does NOT ring the pill/bell) and AC-DM-2
 * (it IS retained via `chatPersistence.appendMessage`, keyed by the stable
 * message id so a later re-delivery / chat-open re-append is a no-op — the
 * watcher's half of the AC-DM-4 dedup contract). Also asserts a confirmed
 * (non-pending) peer keeps the pre-existing behavior: the bell increments and
 * the watcher does NOT persist (ContactChat persists on open, not the watcher).
 *
 * Conventions mirror directMessageNotifications-block-suppression.test.ts:
 * real `contacts.ts` + a hand-rolled localStorage mock so `pendingConfirmationSince`
 * is genuinely observable; `unreadStore`, `chatPersistence`, and
 * `directMessages` are partial-mocked (real module spread, targeted overrides)
 * so the retention wiring is exercised against the REAL parse/thread-id logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

type FakeSub = {
  filter: object;
  handlers: Array<(ev: object) => void>;
  stop: () => void;
  on: (event: string, handler: (ev: object) => void) => void;
};
type FakeNdk = { subscribe: (filter: object) => FakeSub };

function makeFakeNdk(): FakeNdk & { subs: FakeSub[] } {
  const subs: FakeSub[] = [];
  const ndk = {
    subs,
    subscribe: (filter: object) => {
      const sub: FakeSub = {
        filter,
        handlers: [],
        stop: vi.fn(),
        on(event: string, handler: (ev: object) => void) { this.handlers.push(handler); },
      };
      subs.push(sub);
      return sub;
    },
  } as FakeNdk & { subs: FakeSub[] };
  return ndk;
}

async function emitEvent(sub: FakeSub, event: object) {
  await Promise.all(sub.handlers.map(async (handler) => {
    const result = handler(event);
    if (result instanceof Promise) await result;
  }));
}

function kind4Sub(ndk: { subs: FakeSub[] }) {
  return ndk.subs.find((s) => JSON.stringify(s.filter).includes('"kinds":[4]'))!;
}
function kind1059Sub(ndk: { subs: FakeSub[] }) {
  return ndk.subs.find((s) => JSON.stringify(s.filter).includes('"kinds":[1059]'))!;
}

const OWN_PRIV = 'bceef655b5a034911f1c3718ce056531b45ef03b4c7b1f15629e867294011a7d';
const OWN_PUB = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

vi.mock('@/src/lib/directMessages', async () => {
  const mod = await vi.importActual<typeof import('@/src/lib/directMessages')>('@/src/lib/directMessages');
  return {
    ...mod,
    unwrapAndOpen: vi.fn(),
    // Override the crypto path so kind-4 retention can be tested without real
    // nip04 keys — the parse/thread-id logic under test stays real.
    decryptDirectPayload: vi.fn(),
  };
});

vi.mock('@/src/lib/unreadStore', async () => {
  const mod = await vi.importActual<typeof import('@/src/lib/unreadStore')>('@/src/lib/unreadStore');
  return {
    ...mod,
    getDirectMessageLastReadAt: vi.fn(() => 0),
    incrementDirectMessage: vi.fn(),
  };
});

vi.mock('@/src/lib/marmot/chatPersistence', async () => {
  const mod = await vi.importActual<typeof import('@/src/lib/marmot/chatPersistence')>('@/src/lib/marmot/chatPersistence');
  return {
    ...mod,
    appendMessage: vi.fn(async () => {}),
  };
});

const { unwrapAndOpen, decryptDirectPayload, directConversationId } = await import('@/src/lib/directMessages');
const { incrementDirectMessage } = await import('@/src/lib/unreadStore');
const { appendMessage } = await import('@/src/lib/marmot/chatPersistence');
const { subscribeDirectMessageNotifications } = await import('@/src/lib/directMessageNotifications');
const { rememberContact, rememberPendingContact, confirmContact } = await import('@/src/lib/contacts');

function subscribe(ndk: FakeNdk) {
  subscribeDirectMessageNotifications({
    ndk: ndk as unknown as never,
    ownPubkeyHex: OWN_PUB,
    privateKeyHex: OWN_PRIV,
    isAllowedSender: () => true, // isolate the pending/retain logic from the walled garden
  });
}

beforeEach(() => {
  localStorageMock.clear();
  vi.mocked(unwrapAndOpen).mockReset();
  vi.mocked(decryptDirectPayload).mockReset();
  vi.mocked(incrementDirectMessage).mockReset();
  vi.mocked(appendMessage).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kind-1059 — retain while pending (AC-DM-1/2)', () => {
  it('a pending peer\'s gift-wrapped DM is retained but does NOT ring the bell', async () => {
    rememberPendingContact(PEER, '2021-01-01T00:00:00.000Z');

    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'rumor-held-1',
      pubkey: PEER,
      kind: 14,
      content: JSON.stringify({ type: 'text', text: 'held while pending' }),
      tags: [['p', OWN_PUB]],
      created_at: 1_800_000_000,
    });

    const ndk = makeFakeNdk();
    subscribe(ndk);
    await emitEvent(kind1059Sub(ndk), { id: 'wrap-1', kind: 1059, pubkey: 'ephemeral' });

    // AC-DM-1: bell suppressed.
    expect(incrementDirectMessage).not.toHaveBeenCalled();
    // AC-DM-2: retained with the stable rumor id + correct thread + content.
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      directConversationId(PEER),
      expect.objectContaining({
        id: 'rumor-held-1',
        content: 'held while pending',
        senderPubkey: PEER,
        groupId: directConversationId(PEER),
        createdAt: 1_800_000_000 * 1000,
      }),
    );
  });

  it('a re-delivery of the same rumor id is not retained twice (watcher dedup — AC-DM-4)', async () => {
    rememberPendingContact(PEER, '2021-01-01T00:00:00.000Z');
    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'rumor-dup', pubkey: PEER, kind: 14,
      content: JSON.stringify({ type: 'text', text: 'x' }),
      tags: [['p', OWN_PUB]], created_at: 1_800_000_000,
    });

    const ndk = makeFakeNdk();
    subscribe(ndk);
    await emitEvent(kind1059Sub(ndk), { id: 'wrap-a', kind: 1059, pubkey: 'ephemeral' });
    await emitEvent(kind1059Sub(ndk), { id: 'wrap-b', kind: 1059, pubkey: 'ephemeral' }); // same rumor id inside

    expect(appendMessage).toHaveBeenCalledTimes(1);
  });

  it('a confirmed (non-pending) peer rings the bell and is NOT persisted by the watcher', async () => {
    rememberPendingContact(PEER, '2021-01-01T00:00:00.000Z');
    confirmContact(PEER); // clears pendingConfirmationSince → no longer pending

    vi.mocked(unwrapAndOpen).mockResolvedValue({
      id: 'rumor-normal', pubkey: PEER, kind: 14,
      content: JSON.stringify({ type: 'text', text: 'normal' }),
      tags: [['p', OWN_PUB]], created_at: 1_800_000_000,
    });

    const ndk = makeFakeNdk();
    subscribe(ndk);
    await emitEvent(kind1059Sub(ndk), { id: 'wrap-n', kind: 1059, pubkey: 'ephemeral' });

    expect(incrementDirectMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage).not.toHaveBeenCalled();
  });
});

describe('kind-4 — retain while pending (AC-DM-1/2)', () => {
  it('a pending peer\'s kind-4 DM is decrypted, retained, and does NOT ring the bell', async () => {
    rememberPendingContact(PEER, '2021-01-01T00:00:00.000Z');
    vi.mocked(decryptDirectPayload).mockResolvedValue({ content: 'held-4' });

    const ndk = makeFakeNdk();
    subscribe(ndk);
    await emitEvent(kind4Sub(ndk), {
      id: 'evt-4', pubkey: PEER, created_at: 1_800_000_000, content: 'ciphertext',
    });

    expect(incrementDirectMessage).not.toHaveBeenCalled();
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      directConversationId(PEER),
      expect.objectContaining({ id: 'evt-4', content: 'held-4', senderPubkey: PEER, createdAt: 1_800_000_000 * 1000 }),
    );
  });

  it('a confirmed peer\'s kind-4 DM rings the bell and is NOT persisted by the watcher', async () => {
    rememberContact(PEER, '2021-01-01T00:00:00.000Z');
    // not pending
    const ndk = makeFakeNdk();
    subscribe(ndk);
    await emitEvent(kind4Sub(ndk), { id: 'evt-4b', pubkey: PEER, created_at: 1_800_000_000, content: 'ciphertext' });

    expect(incrementDirectMessage).toHaveBeenCalledTimes(1);
    expect(decryptDirectPayload).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
