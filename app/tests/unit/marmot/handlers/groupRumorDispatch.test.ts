// @vitest-environment node
/**
 * S4: the chat / reaction / delete-edit handlers on the history-sink path.
 *
 *  AC-HIST-10  message-store bumps come from handler completion inside the sink's
 *              append/withdraw; group notifications drive only member/admin/name/disband
 *              resync (a `message` notification leaves the message stores alone).
 *  AC-WDR-1   the unit of withdrawal is (groupId, eventId): carriers (also: carrier registration is
 *              atomic with the insert-if-absent; a withdrawn poll_close announcement is dropped from the hold queue)
 *  AC-WDR-6    withdraw keeps effects already emitted (bell, known peers) and shows no notice.
 *  AC-FORGE-1  (unit half) attribution is the sink's `sender`, never the rumor's own pubkey.
 *  AC-OWN-1    (handler half) the sink echo of an own message confirms the optimistic row by
 *              rumor.id: one row, no unread, no bell.
 *  AC-HIST-12  handlers take the `{groupId, eventId, rumor, sender}` input.
 *
 * Real collaborators: the app HistoryBackend (idb store), chatPersistence and knownPeers
 * over fake-indexeddb / an in-memory localStorage. The reactions / edit-reconciliation cores are
 * fixtures here (their real behaviour is covered by the reactionHold / deleteEditRetract suites and
 * domainHandlers.test.ts); the handler logic around them is the SUT.
 *
 * S5 additions: AC-HIST-11 (announcement gates read the live group handle through groupOf),
 * reactions held until their target lands, and the purged-retract rule (a late retract after leave removes an own row instead of failed/retry).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '@941design/marmot';
import { createHistoryBackend, createIdbHistoryStore, type AppHistoryBackend } from '@/src/lib/marmot/history';
import {
  createGroupNotificationRouter,
  createGroupRumorDispatch,
  type GroupKindHandler,
  type GroupResyncTargets,
} from '@/src/lib/marmot/handlers/groupRumorDispatch';
import { createChatGroupHandler, createChatHandler, createPollCloseAnnouncementReplayer, type ChatGroupHandlerDeps, type ChatHandlerDeps } from '@/src/lib/marmot/handlers/chatHandler';
import type { GateGroup } from '@/src/lib/marmot/handlers/groupGates';
import { createReactionGroupHandler, type ReactionGroupHandlerDeps } from '@/src/lib/marmot/handlers/reactionHandler';
import { createDeleteEditGroupHandler, type DeleteEditGroupHandlerDeps } from '@/src/lib/marmot/handlers/deleteEditHandler';
import { appendMessage, appendOrAddCarrier, hasMessage, loadMessages, removeMessages, retractMessageCarrier, type ChatMessage } from '@/src/lib/marmot/chatPersistence';
import { isKnownPeer, rememberKnownPeer } from '@/src/lib/knownPeers';
import type { ApplicationRumor } from '@/src/lib/marmot/handlers/types';
import type { PendingCloseAnnouncement, Poll } from '@/src/lib/marmot/pollPersistence';

const SELF = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const MALLORY = 'cc'.repeat(32);
const ALICE = 'dd'.repeat(32);
let groupCounter = 0;
let G: string;

// localStorage stand-in (knownPeers is pure localStorage)
const lsMap = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsMap.get(k) ?? null,
  setItem: (k: string, v: string) => void lsMap.set(k, v),
  removeItem: (k: string) => void lsMap.delete(k),
});

function entry(over: { eventId: string; kind?: number; rumorId?: string; pubkey?: string; account: string; content?: string; tags?: string[][] }): HistoryEntry {
  return {
    groupId: G,
    eventId: over.eventId,
    rumor: {
      id: over.rumorId ?? `rumor-${over.eventId}`,
      pubkey: over.pubkey ?? over.account,
      created_at: 1_700_000_000,
      kind: over.kind ?? 9,
      tags: over.tags ?? [],
      content: over.content ?? `hello ${over.eventId}`,
    },
    orderingKey: { account: over.account, leafIndex: 0, epoch: 1n, generation: 0, acceptedDigest: 'dd' },
  };
}

const unexpected = (name: string) => () => {
  throw new Error(`unexpected dep call: ${name}`);
};

function build(opts: { activeGroup?: string | null } = {}) {
  const calls: string[] = [];
  const track = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => {
    calls.push(name);
    return fn(...a);
  };
  const versions = { chat: 0, reactions: 0 };
  const failure = { appendMessage: false };
  // one-shot hook fired synchronously right after the sink path invokes the carrier-aware write
  const hooks: { afterAppend?: () => void } = {};
  const reactionStore = new Map<string, { id: string; sender: string; target: string }>();
  // reactions held until their target lands (fixture of the reactions hold queue)
  const heldReactions = new Map<string, { rumor: ApplicationRumor; sender: string }>();
  // the live library group handle the announcement gates read; `held:false` = the group is no longer held
  const live: { held: boolean; admins: string[]; members: string[]; failure: boolean } = { held: true, admins: [], members: [], failure: false };
  const groupOf = vi.fn(async (): Promise<GateGroup | undefined> => {
    if (live.failure) throw new Error('groups.get failed');
    return live.held ? { admins: live.admins, members: () => live.members } : undefined;
  });

  const chatDeps: ChatGroupHandlerDeps = {
    appendMessage: track('appendMessage', async (g, m) => {
      if (failure.appendMessage) throw new Error('storage down');
      return appendMessage(g, m);
    }),
    incrementUnread: vi.fn(track('incrementUnread', () => undefined)),
    markAsRead: vi.fn(track('markAsRead', () => undefined)),
    setChatVersion: track('setChatVersion', (u) => void (versions.chat = u(versions.chat))),
    applyDeleteEditSignal: vi.fn(async () => ({ thread: { kind: 'group' as const, groupId: G }, slotId: null, kind: 'noop' as const })),
    resolvePendingSignalsForSlot: track('resolvePendingSignalsForSlot', async () => ({ thread: { kind: 'group', groupId: G } as never, slotId: null, kind: 'noop' as const })),
    groupOf,
    getPoll: unexpected('getPoll') as never,
    loadVotes: unexpected('loadVotes') as never,
    saveVoteIfNewer: unexpected('saveVoteIfNewer') as never,
    loadPendingVotes: unexpected('loadPendingVotes') as never,
    removePendingVotes: unexpected('removePendingVotes') as never,
    queuePendingCloseAnnouncement: unexpected('queuePendingCloseAnnouncement') as never,
    loadPendingCloseAnnouncements: unexpected('loadPendingCloseAnnouncements') as never,
    removePendingCloseAnnouncements: unexpected('removePendingCloseAnnouncements') as never,
    appendOrAddCarrier: track('appendOrAddCarrier', async (g, m, e) => {
      if (failure.appendMessage) throw new Error('storage down');
      const pending = appendOrAddCarrier(g, m, e);
      const hook = hooks.afterAppend;
      hooks.afterAppend = undefined;
      hook?.();
      return pending;
    }),
    retractMessageCarrier: track('retractMessageCarrier', (g, r, e, snd) => retractMessageCarrier(g, r, e, snd)),
    removeMessages: track('removeMessages', (g, ids) => removeMessages(g, ids)),
    releaseHeldReactions: vi.fn(async (_g: string, messageId: string) => reactionDepsRelease(messageId)),
    setReactionsVersion: (u: (v: number) => number) => void (versions.reactions = u(versions.reactions)),
    hasMessage: (g, id) => hasMessage(g, id),
    recomputeUnread: vi.fn(track('recomputeUnread', () => undefined)),
    rememberKnownPeer: track('rememberKnownPeer', (hex) => rememberKnownPeer(hex)),
    onOwnEcho: vi.fn(track('onOwnEcho', () => undefined)),
    onOwnWithdrawn: vi.fn(track('onOwnWithdrawn', () => undefined)),
    recomputeSlot: vi.fn(async () => undefined),
    recomputeMessageReactions: vi.fn(async () => false),
  };
  // applies the held reactions of a landed target, like reactions/api releaseHeldReactions
  const reactionDepsRelease = (messageId: string): boolean => {
    let changed = false;
    for (const [id, held] of [...heldReactions]) {
      if (held.rumor.tags.find((t) => t[0] === 'e')?.[1] !== messageId) continue;
      heldReactions.delete(id);
      reactionStore.set(id, { id, sender: held.sender, target: messageId });
      changed = true;
    }
    return changed;
  };
  const reactionDeps: ReactionGroupHandlerDeps = {
    loadMessages: (g) => loadMessages(g),
    holdReaction: vi.fn(async (_t, rumor, sender) => void heldReactions.set(rumor.id, { rumor: rumor as ApplicationRumor, sender: sender.pubkey })),
    releaseHeldReactions: vi.fn(async (_t, messageId) => reactionDepsRelease(messageId)),
    applyInboundRumor: vi.fn(async (_t, rumor, sender) => {
      const target = rumor.tags.find((t: string[]) => t[0] === 'e')![1];
      if (reactionStore.has(rumor.id)) return null; // dedup by rumor id, like the real core
      reactionStore.set(rumor.id, { id: rumor.id, sender: sender.pubkey, target });
      return { id: rumor.id };
    }),
    setReactionsVersion: track('setReactionsVersion', (u) => void (versions.reactions = u(versions.reactions))),
    // recompute fixture: reset the target's rows and held entries, then fold the surviving signals
    recomputeMessageReactions: vi.fn(async (_t, target, signals) => {
      const ids = () => [...reactionStore.values()].filter((r) => r.target === target).map((r) => r.id).sort().join();
      const before = ids();
      for (const [id, r] of [...reactionStore]) if (r.target === target) reactionStore.delete(id);
      for (const [id, h] of [...heldReactions]) if (h.rumor.tags.find((t) => t[0] === 'e')?.[1] === target) heldReactions.delete(id);
      for (const sig of signals) {
        if (sig.rumor.tags.find((t: string[]) => t[0] === 'e')?.[1] === target) reactionStore.set(sig.rumor.id, { id: sig.rumor.id, sender: sig.sender, target });
      }
      return ids() !== before;
    }),
  };
  const deleteEditDeps: DeleteEditGroupHandlerDeps = {
    applyDeleteEditSignal: chatDeps.applyDeleteEditSignal,
    setChatVersion: chatDeps.setChatVersion,
    recomputeSlot: chatDeps.recomputeSlot,
  };
  const handlers: GroupKindHandler[] = [
    createChatGroupHandler(chatDeps),
    createReactionGroupHandler(reactionDeps),
    createDeleteEditGroupHandler(deleteEditDeps),
  ];
  const dispatcher = createGroupRumorDispatch({
    handlers,
    env: { selfPubkeyHex: SELF, getActiveGroupId: () => opts.activeGroup ?? null },
  });
  const sink: AppHistoryBackend = createHistoryBackend({ handlers: dispatcher, store: createIdbHistoryStore(`s4-${G}`) });
  return { sink, dispatcher, chatDeps, reactionDeps, deleteEditDeps, versions, failure, hooks, reactionStore, heldReactions, live, groupOf, calls };
}

let sinks: AppHistoryBackend[] = [];
beforeEach(() => {
  G = `${(++groupCounter).toString(16).padStart(2, '0')}`.repeat(32).slice(0, 64);
  lsMap.clear();
  sinks = [];
});
afterEach(async () => {
  for (const s of sinks) await s.dispose();
});
const make = (o?: Parameters<typeof build>[0]) => {
  const app = build(o);
  sinks.push(app.sink);
  return app;
};
const rows = async () => (await loadMessages(G)).messages;
// the legacy (old-dispatcher) factory still takes isGroupAdmin/isGroupMember instead of groupOf
const legacyDeps = (deps: ChatGroupHandlerDeps): ChatHandlerDeps => ({ ...deps, isGroupAdmin: unexpected('isGroupAdmin') as never, isGroupMember: unexpected('isGroupMember') as never });

describe('AC-HIST-10: message-store bumps are driven from handler completion', () => {
  it('a sink append of a peer chat message bumps the chat version once, rings the bell once and stores one row', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e1', account: BOB, content: 'hi' }));
    expect(app.versions.chat).toBe(1);
    expect(app.chatDeps.incrementUnread).toHaveBeenCalledTimes(1);
    expect(app.chatDeps.incrementUnread).toHaveBeenCalledWith(G);
    const stored = await rows();
    expect(stored.map((m) => [m.id, m.senderPubkey, m.content])).toEqual([['rumor-e1', BOB, 'hi']]);
  });

  it('a sink append of a reaction bumps the reactions version, of a delete signal the chat version', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e1', account: BOB, content: 'target' }));
    const chatBefore = app.versions.chat;
    await app.sink.append(entry({ eventId: 'e2', kind: 7, account: ALICE, content: '+', tags: [['e', 'rumor-e1']] }));
    expect(app.versions.reactions).toBe(1);
    expect(app.versions.chat).toBe(chatBefore);
    await app.sink.append(entry({ eventId: 'e3', kind: 5, account: BOB, tags: [['e', 'rumor-e1']] }));
    expect(app.versions.chat).toBe(chatBefore + 1);
    expect(app.deleteEditDeps.applyDeleteEditSignal).toHaveBeenCalledTimes(1);
  });

  describe('group notifications drive only member / admin / name / disband resync', () => {
    const targets = () => {
      const t: Record<keyof GroupResyncTargets, ReturnType<typeof vi.fn>> = {
        members: vi.fn(),
        admins: vi.fn(),
        name: vi.fn(),
        disband: vi.fn(),
      };
      return { t, route: createGroupNotificationRouter(t as unknown as GroupResyncTargets) };
    };
    const message = { type: 'message', eventId: 'e1', rumor: entry({ eventId: 'e1', account: BOB }).rumor, orderingKey: entry({ eventId: 'e1', account: BOB }).orderingKey } as never;

    it('a `message` notification only leaves the message stores and every resync target unchanged', async () => {
      const app = make();
      const { t, route } = targets();
      route(G, message);
      route(G, { type: 'message-withdrawn', eventId: 'e1', acceptedDigest: 'dd' } as never);
      expect(Object.values(t).map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0, 0]);
      expect(app.versions).toEqual({ chat: 0, reactions: 0 });
      expect(await rows()).toEqual([]);
      expect(app.calls).toEqual([]);
    });

    it('a `members` change resyncs members only and never bumps a message store', async () => {
      const app = make();
      const { t, route } = targets();
      route(G, { type: 'applied', commitDigest: 'c1', kind: 'memberAdded' } as never);
      route(G, { type: 'applied', commitDigest: 'c2', kind: 'memberRemoved' } as never);
      expect(t.members).toHaveBeenCalledTimes(2);
      expect(t.members).toHaveBeenCalledWith(G);
      expect([t.admins, t.name, t.disband].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
      expect(app.versions).toEqual({ chat: 0, reactions: 0 });
      expect(app.calls).toEqual([]);
    });

    it('component change resyncs admins and name; disband resyncs disband', () => {
      const { t, route } = targets();
      route(G, { type: 'applied', commitDigest: 'c3', kind: 'componentChanged' } as never);
      route(G, { type: 'group-disbanded', actor: BOB, epoch: 1n, nodeTag: 'x', commitDigest: 'c4' } as never);
      expect(t.admins).toHaveBeenCalledWith(G);
      expect(t.name).toHaveBeenCalledWith(G);
      expect(t.disband).toHaveBeenCalledWith(G);
      expect(t.members).not.toHaveBeenCalled();
    });
  });
});

describe('sender binding (AC-FORGE-1 unit half, AC-HIST-12)', () => {
  it('a chat rumor whose inner pubkey differs from the sink sender is stored under the SENDER', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e1', account: MALLORY, pubkey: ALICE, content: 'claim' }));
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].senderPubkey).toBe(MALLORY);
    expect(stored.some((m) => m.senderPubkey === ALICE)).toBe(false);
  });

  it('the reaction and delete/edit cores receive the sender, not the rumor pubkey', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e1', account: BOB, content: 'target' }));
    await app.sink.append(entry({ eventId: 'e2', kind: 7, account: MALLORY, pubkey: ALICE, content: '+', tags: [['e', 'rumor-e1']] }));
    await app.sink.append(entry({ eventId: 'e3', kind: 5, account: MALLORY, pubkey: ALICE, tags: [['e', 'rumor-e1']] }));
    const reaction = (app.reactionDeps.applyInboundRumor as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(reaction[2]).toEqual({ pubkey: MALLORY, authenticity: 'mls' });
    const del = (app.deleteEditDeps.applyDeleteEditSignal as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(del[2]).toEqual({ pubkey: MALLORY, authenticity: 'mls' });
  });

  it('the own-message guard is keyed on the sender: a forged own-pubkey rumor from a peer still rings the bell', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e1', account: MALLORY, pubkey: SELF, content: 'forged as me' }));
    expect(app.chatDeps.incrementUnread).toHaveBeenCalledTimes(1);
    expect(app.chatDeps.onOwnEcho).not.toHaveBeenCalled();
  });
});

describe('idempotency by event id', () => {
  it('repeating dispatch for an applied rumor leaves one row, one bell and one bump (crash-recovery rerun)', async () => {
    const app = make();
    const input = { groupId: G, eventId: 'e1', rumor: entry({ eventId: 'e1', account: BOB }).rumor, sender: BOB };
    await app.dispatcher.dispatch(input);
    await app.dispatcher.dispatch(input);
    expect(await rows()).toHaveLength(1);
    expect(app.chatDeps.incrementUnread).toHaveBeenCalledTimes(1);
    expect(app.versions.chat).toBe(1);
    expect(isKnownPeer(BOB)).toBe(true);
  });

  it('a handler failure rejects the append and leaves the row undispatched; the retry lands it once', async () => {
    const app = make();
    app.failure.appendMessage = true;
    const e = entry({ eventId: 'e1', account: BOB });
    await expect(app.sink.append(e)).rejects.toThrow('storage down');
    expect(await rows()).toEqual([]);
    expect((await app.sink.list(G)).length).toBe(1);
    app.failure.appendMessage = false;
    await app.sink.append(e);
    await app.sink.append(e);
    expect(await rows()).toHaveLength(1);
    expect(app.chatDeps.incrementUnread).toHaveBeenCalledTimes(1);
  });

  it('a reaction whose target has not arrived is HELD, not dropped: it applies when the target lands (dependent kinds tolerate a missing target)', async () => {
    const app = make();
    await expect(app.sink.append(entry({ eventId: 'e2', kind: 7, account: BOB, content: '+', tags: [['e', 'rumor-e1']] }))).resolves.toBeUndefined();
    expect(app.reactionStore.size).toBe(0);
    expect(app.versions.reactions).toBe(0);
    expect(app.heldReactions.size).toBe(1);
    expect(app.reactionDeps.holdReaction).toHaveBeenCalledTimes(1);

    await app.sink.append(entry({ eventId: 'e1', account: ALICE, content: 'the target' })); // the target lands
    expect([...app.reactionStore.values()].map((r) => [r.sender, r.target])).toEqual([[BOB, 'rumor-e1']]);
    expect(app.heldReactions.size).toBe(0);
    expect(app.versions.reactions).toBe(1); // the reactions UI re-reads
    expect(app.chatDeps.releaseHeldReactions).toHaveBeenCalledWith(G, 'rumor-e1');
  });

  it('a held reaction that is withdrawn before its target lands is not revived by the target', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e2', kind: 7, account: BOB, content: '+', tags: [['e', 'rumor-e1']] }));
    await app.sink.withdraw(G, ['e2']);
    expect(app.heldReactions.size).toBe(0);
    await app.sink.append(entry({ eventId: 'e1', account: ALICE, content: 'the target' }));
    expect(app.reactionStore.size).toBe(0);
    expect(app.versions.reactions).toBe(0);
  });

  it('a held-reaction release failure rejects the target row (retried) after its own bookkeeping; the retry releases', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e2', kind: 7, account: BOB, content: '+', tags: [['e', 'rumor-e1']] }));
    (app.chatDeps.releaseHeldReactions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('held store down'));
    const target = entry({ eventId: 'e1', account: ALICE, content: 'the target' });
    await expect(app.sink.append(target)).rejects.toThrow('held store down');
    expect(isKnownPeer(ALICE)).toBe(true);
    expect((await rows()).map((m) => m.id)).toEqual(['rumor-e1']);
    await app.sink.append(target);
    expect(app.reactionStore.size).toBe(1);
    expect(app.chatDeps.incrementUnread).toHaveBeenCalledTimes(1);
  });

  it('createGroupRumorDispatch refuses a handler for a kind outside the app registry', () => {
    expect(() =>
      createGroupRumorDispatch({
        handlers: [{ kind: 13, dispatch: async () => undefined, retract: async () => undefined }],
        env: { selfPubkeyHex: SELF, getActiveGroupId: () => null },
      }),
    ).toThrow(/kind 13/);
  });

  it('a rumor kind with no registered handler completes and touches nothing', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e1', kind: 30, account: BOB, content: '{}' }));
    expect(app.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

describe('own echo confirms the optimistic row (D13, AC-OWN-1 handler half)', () => {
  it('with the optimistic row already stored: one row with that rumor.id, no unread, no bell, confirmed once', async () => {
    const app = make({ activeGroup: null });
    const optimistic: ChatMessage = { id: 'rumor-e1', content: 'mine', senderPubkey: SELF, groupId: G, createdAt: 1_700_000_000_000 };
    await appendMessage(G, optimistic);
    await app.sink.append(entry({ eventId: 'e1', account: SELF, content: 'mine' }));
    const stored = await rows();
    expect(stored.filter((m) => m.id === 'rumor-e1')).toHaveLength(1);
    expect(app.chatDeps.incrementUnread).not.toHaveBeenCalled();
    expect(app.chatDeps.markAsRead).not.toHaveBeenCalled();
    expect(app.chatDeps.onOwnEcho).toHaveBeenCalledWith(G, 'rumor-e1');
    expect(app.versions.chat).toBe(1); // the row re-reads as confirmed even though nothing was inserted
    expect(isKnownPeer(SELF)).toBe(false);
  });

  it('without a stored optimistic row (reload): the echo inserts it, still no unread and no bell', async () => {
    const app = make({ activeGroup: G });
    await app.sink.append(entry({ eventId: 'e1', account: SELF, content: 'mine' }));
    expect((await rows()).map((m) => m.id)).toEqual(['rumor-e1']);
    expect(app.chatDeps.incrementUnread).not.toHaveBeenCalled();
    expect(app.chatDeps.markAsRead).not.toHaveBeenCalled();
    expect(app.chatDeps.onOwnEcho).toHaveBeenCalledTimes(1);
    expect(app.versions.chat).toBe(1);
  });
});

describe('AC-WDR-6: withdraw keeps the effects already emitted', () => {
  it('append then withdraw of a message from a new peer: row removed, peer still known, bell not undone, no notice', async () => {
    const app = make();
    expect(isKnownPeer(BOB)).toBe(false);
    await app.sink.append(entry({ eventId: 'e1', account: BOB }));
    expect(isKnownPeer(BOB)).toBe(true);
    app.calls.length = 0;
    const chatBefore = app.versions.chat;

    await app.sink.withdraw(G, ['e1']);

    expect(await rows()).toEqual([]);
    expect(isKnownPeer(BOB)).toBe(true);
    expect(app.chatDeps.incrementUnread).toHaveBeenCalledTimes(1); // the bell stays rung: never decremented or re-rung
    expect(app.chatDeps.recomputeUnread).toHaveBeenCalledWith(G);
    expect(app.versions.chat).toBe(chatBefore + 1);
    // only the store removal, the unread recompute and the version bump ran: no notice, no re-add
    expect(app.calls).toEqual(['retractMessageCarrier', 'recomputeUnread', 'setChatVersion']);
  });

  it('withdraw of an OWN message hands the row to the own-send lifecycle and never deletes it', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e1', account: SELF, content: 'mine' }));
    await app.sink.withdraw(G, ['e1']);
    expect(app.chatDeps.onOwnWithdrawn).toHaveBeenCalledWith(G, 'rumor-e1');
    expect((await rows()).map((m) => m.id)).toEqual(['rumor-e1']);
    expect(app.calls).not.toContain('retractMessageCarrier');
  });

  it('a retract of a rumor whose row is already gone removes nothing and still runs the idempotent tail', async () => {
    const app = make();
    const input = { groupId: G, eventId: 'e9', rumor: entry({ eventId: 'e9', account: BOB }).rumor, sender: BOB, remaining: async () => [] };
    await app.dispatcher.retract(input);
    expect(await rows()).toEqual([]);
    expect(app.chatDeps.recomputeUnread).toHaveBeenCalledTimes(1);
  });

  it('withdraw of a reaction drops its row and bumps the reactions version; of a delete signal calls the retract port', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e1', account: BOB, content: 'target' }));
    await app.sink.append(entry({ eventId: 'e2', kind: 7, account: ALICE, content: '+', tags: [['e', 'rumor-e1']] }));
    await app.sink.append(entry({ eventId: 'e3', kind: 5, account: BOB, tags: [['e', 'rumor-e1']] }));
    expect(app.reactionStore.size).toBe(1);
    const reactionsBefore = app.versions.reactions;
    const chatBefore = app.versions.chat;

    await app.sink.withdraw(G, ['e2', 'e3']);

    expect(app.reactionStore.size).toBe(0);
    expect(app.versions.reactions).toBe(reactionsBefore + 1);
    expect(app.deleteEditDeps.recomputeSlot).toHaveBeenCalledTimes(1);
    const [thread, slotIds, signals] = (app.deleteEditDeps.recomputeSlot as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(thread).toEqual({ kind: 'group', groupId: G });
    expect(slotIds).toEqual(['rumor-e1']);
    expect(signals).toEqual([]); // the withdrawn signal is not among the remaining rows (their senders are the rows' accounts)
    expect(app.versions.chat).toBe(chatBefore + 1);
  });

  it('a retract failure rejects (the sink keeps the row) instead of being swallowed', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e1', account: BOB }));
    (app.chatDeps.recomputeUnread as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('unread store down'));
    await expect(app.sink.withdraw(G, ['e1'])).rejects.toThrow('unread store down');
    // the row stays, marked `withdrawing` (hidden from list(), finished by the retried withdraw)
    expect(await app.sink.list(G)).toEqual([]);
    expect(await rows()).toEqual([]); // the removal itself committed before the recompute threw

    // retry: the removal is a no-op now, but the tail must still run
    const bumpsBefore = app.versions.chat;
    await app.sink.withdraw(G, ['e1']);
    expect(app.chatDeps.recomputeUnread).toHaveBeenCalledTimes(2);
    expect(app.versions.chat).toBe(bumpsBefore + 1);
    expect(await rows()).toEqual([]);
    expect(await app.sink.list(G)).toEqual([]);
  });
});

describe('carriers: the unit of withdrawal is (groupId, eventId) (AC-WDR-1, AC-HIST-10)', () => {
  const same = (eventId: string, account = BOB) => entry({ eventId, rumorId: 'shared-rumor', account });

  it('one rumor id under two event ids: withdrawing E1 keeps the row, withdrawing E2 removes it', async () => {
    const app = make();
    await app.sink.append(same('e1'));
    await app.sink.append(same('e2'));
    expect(await rows()).toHaveLength(1);
    await app.sink.withdraw(G, ['e1']);
    expect((await rows()).map((m) => m.id)).toEqual(['shared-rumor']);
    await app.sink.withdraw(G, ['e2']);
    expect(await rows()).toEqual([]);
  });

  it('re-delivering the same event id adds no second carrier (idempotent)', async () => {
    const app = make();
    await app.sink.append(same('e1'));
    await app.dispatcher.dispatch({ groupId: G, eventId: 'e1', rumor: same('e1').rumor, sender: BOB });
    await app.sink.withdraw(G, ['e1']);
    expect(await rows()).toEqual([]);
  });

  it('a retract whose sender differs from the stored row sender removes nothing', async () => {
    const app = make();
    await app.sink.append(same('e1'));
    await app.dispatcher.retract({ groupId: G, eventId: 'e1', rumor: same('e1').rumor, sender: MALLORY , remaining: async () => [] });
    expect(await rows()).toHaveLength(1);
  });

  it('a duplicate delivery under E2 racing a retract of E1 keeps the row backed by E2 (carrier registration is atomic with insert-if-absent)', async () => {
    const app = make();
    await app.sink.append(same('e1'));
    let retracting: Promise<void> | undefined;
    // the retract of E1 is queued right behind the duplicate's store write
    app.hooks.afterAppend = () => {
      retracting = app.dispatcher.retract({ groupId: G, eventId: 'e1', rumor: same('e1').rumor, sender: BOB , remaining: async () => [] });
    };
    await app.dispatcher.dispatch({ groupId: G, eventId: 'e2', rumor: same('e2').rumor, sender: BOB });
    await retracting;
    const stored = await rows();
    expect(stored.map((m) => m.id)).toEqual(['shared-rumor']);
    expect(stored[0].carrierEventIds).toEqual(['e2']);
    await app.dispatcher.retract({ groupId: G, eventId: 'e2', rumor: same('e2').rumor, sender: BOB , remaining: async () => [] });
    expect(await rows()).toEqual([]);
  });

  it('a legacy row (no carrier field) is removed by any retract', async () => {
    const app = make();
    await appendMessage(G, { id: 'legacy', content: 'old', senderPubkey: BOB, groupId: G, createdAt: 1 });
    await app.dispatcher.retract({ groupId: G, eventId: 'whatever', rumor: entry({ eventId: 'x', rumorId: 'legacy', account: BOB }).rumor, sender: BOB , remaining: async () => [] });
    expect(await rows()).toEqual([]);
  });
});

describe('own echo and own withdraw edge cases', () => {
  it('an own rejected announcement still confirms the optimistic row', async () => {
    const app = make(); // the live group lists no admins: a group_renamed announcement is rejected
    await app.sink.append(entry({ eventId: 'e1', account: SELF, content: JSON.stringify({ type: 'group_renamed', name: 'x' }) }));
    expect(app.chatDeps.onOwnEcho).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([]);
  });

  it('an own edit-signal echo confirms the optimistic row', async () => {
    const app = make();
    await app.sink.append(entry({ eventId: 'e1', account: SELF, content: 'new text', tags: [['e', 'orig', '', 'edit']] }));
    expect(app.chatDeps.applyDeleteEditSignal).toHaveBeenCalledTimes(1);
    expect(app.chatDeps.onOwnEcho).toHaveBeenCalledWith(G, 'rumor-e1');
  });

  it('an own retract of a rumor that was never applied is a no-op (no hand-back, no bump)', async () => {
    const app = make();
    await app.dispatcher.retract({ groupId: G, eventId: 'e9', rumor: entry({ eventId: 'e9', account: SELF }).rumor, sender: SELF , remaining: async () => [] });
    expect(app.chatDeps.onOwnWithdrawn).not.toHaveBeenCalled();
    expect(app.versions.chat).toBe(0);
  });

  it('"is this mine" is case-insensitive in both the shared core and the sink wrapper', async () => {
    const app = make();
    const upper = SELF.toUpperCase().replace(/[^A-F0-9]/g, 'A');
    // env self is lowercase; the MLS sender arrives upper-cased
    await app.sink.append(entry({ eventId: 'e1', account: upper }));
    expect(app.chatDeps.incrementUnread).not.toHaveBeenCalled();
    expect(app.chatDeps.markAsRead).not.toHaveBeenCalled();
    expect(app.chatDeps.onOwnEcho).toHaveBeenCalledTimes(1);
  });
});

// guards the fixture itself: ApplicationRumor shape is what the handlers read
describe('fixture sanity', () => {
  it('the sink delivers the rumor unchanged to the handlers', async () => {
    const seen: ApplicationRumor[] = [];
    const sink = createHistoryBackend({
      handlers: createGroupRumorDispatch({
        handlers: [{ kind: 9, dispatch: async (i) => void seen.push(i.rumor as ApplicationRumor), retract: async () => undefined }],
        env: { selfPubkeyHex: SELF, getActiveGroupId: () => null },
      }),
      store: createIdbHistoryStore(`s4-sanity-${G}`),
    });
    sinks.push(sink);
    const e = entry({ eventId: 'e1', account: BOB });
    await sink.append(e);
    expect(seen).toEqual([e.rumor]);
  });
});

describe('a withdrawn poll_close announcement is dropped from the hold queue (AC-WDR-1)', () => {
  const closeContent = JSON.stringify({ type: 'poll_close', pollId: 'p1', title: 'T', results: [], totalVoters: 0 });
  const poll = { id: 'p1', groupId: '', title: 'T', options: [], creatorPubkey: BOB, closed: false } as unknown as Poll;

  function withHoldQueue(app: ReturnType<typeof make>) {
    const held: PendingCloseAnnouncement[] & { pollKnown?: boolean } = [];
    const d = app.chatDeps as unknown as Record<string, unknown>;
    d.getPoll = async () => (held.pollKnown ? { ...poll, groupId: G } : null);
    d.queuePendingCloseAnnouncement = async (a: Omit<PendingCloseAnnouncement, 'receivedAt'>) => void held.push({ ...a, receivedAt: 1 });
    d.loadPendingCloseAnnouncements = async (_g: string, pollId: string) => held.filter((h) => h.pollId === pollId);
    d.removePendingCloseAnnouncements = async (_g: string, applied: PendingCloseAnnouncement[]) => {
      for (const a of applied) {
        const i = held.findIndex((h) => h.pollId === a.pollId && h.senderPubkey === a.senderPubkey && h.rumorId === a.rumorId);
        if (i !== -1) held.splice(i, 1);
      }
    };
    d.loadVotes = async () => [];
    d.loadPendingVotes = async () => [];
    return held;
  }

  it('a close held for an unknown poll is gone after its withdrawal: the poll-open then creates no chat row', async () => {
    const app = make();
    const held = withHoldQueue(app);
    await app.sink.append(entry({ eventId: 'e1', account: BOB, content: closeContent }));
    expect(held).toHaveLength(1);
    await app.sink.withdraw(G, ['e1']);
    expect(held).toEqual([]);
    held.pollKnown = true; // the poll-open arrives
    const ctx = { groupId: G, selfPubkeyHex: SELF, getActiveGroupId: () => null };
    await createPollCloseAnnouncementReplayer(legacyDeps(app.chatDeps))({ ...poll, groupId: G }, ctx);
    expect(await rows()).toEqual([]);
  });

  it('control: without a withdrawal the poll-open replays the held close into a chat row', async () => {
    const app = make();
    const held = withHoldQueue(app);
    await app.sink.append(entry({ eventId: 'e1', account: BOB, content: closeContent }));
    expect(held).toHaveLength(1);
    held.pollKnown = true; // the poll-open arrives
    const ctx = { groupId: G, selfPubkeyHex: SELF, getActiveGroupId: () => null };
    await createPollCloseAnnouncementReplayer(legacyDeps(app.chatDeps))({ ...poll, groupId: G }, ctx);
    expect((await rows()).map((m) => m.id)).toEqual(['rumor-e1']);
  });
});

describe('resolvePendingSignalsForSlot failure policy', () => {
  it('on the sink path a failure rejects (the sink retries) after showing the stored row; the retry succeeds', async () => {
    const app = make();
    const resolve = vi.fn().mockRejectedValueOnce(new Error('signal store down')).mockResolvedValue({ thread: { kind: 'group', groupId: G }, slotId: null, kind: 'noop' });
    (app.chatDeps as { resolvePendingSignalsForSlot: unknown }).resolvePendingSignalsForSlot = resolve;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = entry({ eventId: 'e1', account: BOB });
    await expect(app.sink.append(e)).rejects.toThrow('signal store down');
    expect(warn).not.toHaveBeenCalled();
    expect((await rows()).map((m) => m.id)).toEqual(['rumor-e1']);
    expect(app.versions.chat).toBe(1);
    // The peer message still rings the bell once, even though the delivery is retried.
    expect(app.chatDeps.incrementUnread).toHaveBeenCalledTimes(1);
    expect((await app.sink.list(G)).length).toBe(1); // still undispatched
    await app.sink.append(e);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(await rows()).toHaveLength(1);
    expect(app.chatDeps.incrementUnread).toHaveBeenCalledTimes(1); // retry is a duplicate: no second bell
    warn.mockRestore();
  });

  it('the legacy path keeps swallowing the failure with a warning', async () => {
    const app = make();
    (app.chatDeps as { resolvePendingSignalsForSlot: unknown }).resolvePendingSignalsForSlot = async () => {
      throw new Error('signal store down');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rumor = entry({ eventId: 'e1', account: BOB }).rumor as ApplicationRumor;
    await expect(
      createChatHandler(legacyDeps(app.chatDeps)).handle(rumor, { groupId: G, selfPubkeyHex: SELF, getActiveGroupId: () => null }, { pubkey: BOB, authenticity: 'mls' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('required ports are enforced at construction', () => {
  const CHAT_PORTS = [
    'appendMessage', 'incrementUnread', 'markAsRead', 'setChatVersion', 'applyDeleteEditSignal', 'resolvePendingSignalsForSlot',
    'groupOf', 'getPoll', 'loadVotes', 'saveVoteIfNewer', 'loadPendingVotes', 'removePendingVotes',
    'queuePendingCloseAnnouncement', 'loadPendingCloseAnnouncements', 'removePendingCloseAnnouncements', 'appendOrAddCarrier',
    'retractMessageCarrier', 'removeMessages', 'hasMessage', 'recomputeUnread', 'rememberKnownPeer', 'onOwnEcho', 'onOwnWithdrawn', 'recomputeSlot', 'recomputeMessageReactions',
    'releaseHeldReactions', 'setReactionsVersion',
  ];
  const REACTION_PORTS = ['loadMessages', 'applyInboundRumor', 'setReactionsVersion', 'recomputeMessageReactions', 'holdReaction', 'releaseHeldReactions'];
  const DELETE_EDIT_PORTS = ['applyDeleteEditSignal', 'setChatVersion', 'recomputeSlot'];

  it('the chat port list covers every dep the fixture wires', () => {
    expect(Object.keys(build().chatDeps).sort()).toEqual([...CHAT_PORTS].sort());
  });

  it.each(CHAT_PORTS)('createChatGroupHandler without %s throws a TypeError naming it', (port) => {
    const deps = { ...build().chatDeps, [port]: undefined };
    expect(() => createChatGroupHandler(deps as never)).toThrow(TypeError);
    expect(() => createChatGroupHandler(deps as never)).toThrow(new RegExp(`"${port}"`));
    expect(() => createChatGroupHandler({ ...deps, [port]: 'not a function' } as never)).toThrow(new RegExp(`"${port}"`));
  });

  it.each(REACTION_PORTS)('createReactionGroupHandler without %s throws a TypeError naming it', (port) => {
    const deps = { ...build().reactionDeps, [port]: undefined };
    expect(() => createReactionGroupHandler(deps as never)).toThrow(TypeError);
    expect(() => createReactionGroupHandler(deps as never)).toThrow(new RegExp(`"${port}"`));
  });

  it.each(DELETE_EDIT_PORTS)('createDeleteEditGroupHandler without %s throws a TypeError naming it', (port) => {
    const deps = { ...build().deleteEditDeps, [port]: undefined };
    expect(() => createDeleteEditGroupHandler(deps as never)).toThrow(TypeError);
    expect(() => createDeleteEditGroupHandler(deps as never)).toThrow(new RegExp(`"${port}"`));
  });

  it.each(['dispatch', 'retract'])('createGroupRumorDispatch rejects a handler without %s', (port) => {
    const handler = { kind: 9, dispatch: async () => undefined, retract: async () => undefined, [port]: undefined };
    expect(() => createGroupRumorDispatch({ handlers: [handler as never], env: { selfPubkeyHex: SELF, getActiveGroupId: () => null } })).toThrow(
      new RegExp(`"${port}"`),
    );
  });

  it('createGroupRumorDispatch rejects an env without getActiveGroupId', () => {
    expect(() => createGroupRumorDispatch({ handlers: [], env: { selfPubkeyHex: SELF } as never })).toThrow(/"getActiveGroupId"/);
  });
});
