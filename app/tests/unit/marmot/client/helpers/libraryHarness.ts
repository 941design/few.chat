import { getEventHash } from 'nostr-tools/pure';
import type {
  GroupNotification,
  MarmotGroup,
  PendingInvitation,
} from '@941design/marmot';
import type { TransportContract } from '@941design/nostr-events/transport/contract';
import {
  bootstrapAccountClient,
  createClientTransport,
  type AccountClient,
  type BootstrapSeams,
  type ClientTransport,
} from '@/src/lib/marmot/client';
import { createPrivateKeySigner } from '@/src/lib/marmot/signerAdapter';
import { createRecordingHistoryBackend, type RecordingHistoryBackend } from './recordingHistoryBackend';

export interface PartitionableTransport {
  transport: TransportContract;
  setPartition(on: boolean): void;
}

/**
 * Wraps a transport so inbound live events are held back while partitioned
 * (and flushed in order on heal) and history requests report a timeout. Used
 * to stage a same-epoch fork between two clients; publishes still go out.
 */
export function partitionable(inner: TransportContract): PartitionableTransport {
  let partitioned = false;
  const held: Array<() => void> = [];
  return {
    setPartition(on) {
      partitioned = on;
      if (!on) for (const flush of held.splice(0)) flush();
    },
    transport: {
      publish: (relays, event, opts) => inner.publish(relays, event, opts),
      requestWithDeadline: async (relays, filters, opts) => {
        if (partitioned) {
          return { events: [], timedOut: true, eosedRelays: [], silentRelays: [...relays] } as never;
        }
        return inner.requestWithDeadline(relays, filters, opts);
      },
      subscription: (relays, filters) => {
        const source = inner.subscription(relays, filters);
        return {
          subscribe(observer) {
            return source.subscribe({
              next: (value, meta) => {
                if (partitioned) held.push(() => observer.next?.(value, meta));
                else observer.next?.(value, meta);
              },
              error: (e) => observer.error?.(e),
              complete: () => observer.complete?.(),
            });
          },
        };
      },
    },
  };
}

export interface RecordedNotification {
  groupId: string;
  type: string;
  eventId?: string;
  rumorId?: string;
  account?: string;
}

export interface GroupLibraryHook {
  start(opts: { privateKeyHex: string; relays: string[]; historyTimeoutMs?: number }): Promise<{ pubkey: string }>;
  stop(): Promise<void>;
  pubkey(): string;
  createGroup(name: string, opts?: { admins?: string[] }): Promise<{ groupId: string }>;
  /** Looks up the invitee's key package (first one seen) and invites it. */
  inviteByPubkey(groupId: string, pubkey: string, opts?: { timeoutMs?: number }): Promise<{ status: string }[]>;
  /** Accepts the first pending invitation; resolves its group id (null when none is pending). */
  acceptFirstPending(): Promise<string | null>;
  pendingCount(): Promise<number>;
  /** Sends a kind-9 rumor; resolves its canonical id once `send()` settled. */
  send(groupId: string, content: string): Promise<{ rumorId: string }>;
  /** Starts a rename commit without awaiting it (fork staging). */
  renameNoWait(groupId: string, name: string): void;
  waitSynced(groupId: string): Promise<void>;
  setPartition(on: boolean): void;
  groupInfo(groupId: string): { nostrGroupId: string; epoch: string; name: string; members: string[]; admins: string[] };
  /** The recording sink. */
  sink: () => RecordingHistoryBackend;
  notifications(): RecordedNotification[];
  failNextAppends(count: number): void;
  /** Own ids the sink holds for a group: `{eventId, rumorId, account, content}`. */
  retained(groupId: string): Array<{ eventId: string; rumorId: string; account: string; content: string }>;
}

export function createGroupLibraryHook(seams?: {
  secureContext?: () => boolean;
  openStores?: BootstrapSeams['openStores'];
  /** Replace the pool/transport (node harness points it at a FakeRelay). */
  createTransport?: (relays: readonly string[]) => ClientTransport;
}): GroupLibraryHook {
  let account: AccountClient | undefined;
  let sink = createRecordingHistoryBackend();
  let partition: PartitionableTransport | undefined;
  const notifications: RecordedNotification[] = [];
  const groups = new Map<string, MarmotGroup>();

  const need = (): AccountClient => {
    if (!account) throw new Error('groupLibrary hook: call start() first');
    return account;
  };
  const group = async (groupId: string): Promise<MarmotGroup> => {
    const cached = groups.get(groupId);
    if (cached) return cached;
    const found = await need().handle.client.groups.get(groupId);
    if (!found) throw new Error(`groupLibrary hook: unknown group ${groupId}`);
    groups.set(groupId, found);
    return found;
  };
  const track = (g: MarmotGroup) => {
    groups.set(g.id, g);
    need().attachGroup(g);
  };

  return {
    async start({ privateKeyHex, relays, historyTimeoutMs }) {
      sink = createRecordingHistoryBackend();
      const result = await bootstrapAccountClient({
        eventSigner: createPrivateKeySigner(privateKeyHex),
        signerKind: 'local',
        relays,
        // The recording sink holds no persisted rows: its sweep has nothing to recover.
        history: Object.assign(sink, { sweep: async () => undefined, dispose: () => undefined }),
        clientEvents: {
          groupRemoved: () => undefined,
          inboxDisposition: () => undefined,
          welcomeDeclined: () => undefined,
          intentFailed: (p) => console.warn('[groupLibrary] intentFailed', p),
          storeIncompatible: (p) => console.warn('[groupLibrary] storeIncompatible', p),
          groupBranchSwitched: () => undefined,
        },
        inboxHandlers: { joinRequest: () => undefined, inviteContext: () => undefined },
        onGroupNotification: (g, n: GroupNotification) => {
          const rec: RecordedNotification = { groupId: g.id, type: n.type };
          if (n.type === 'message') {
            rec.eventId = n.eventId;
            rec.rumorId = n.rumor.id;
            rec.account = n.orderingKey.account;
          } else if (n.type === 'message-withdrawn') {
            rec.eventId = n.eventId;
          }
          notifications.push(rec);
        },
        inboxRelayList: { ensure: async () => undefined },
        clientOptions: historyTimeoutMs ? { historyTimeoutMs } : undefined,
        seams: {
          ...(seams?.secureContext ? { isSecureContext: seams.secureContext } : {}),
          ...(seams?.openStores ? { openStores: seams.openStores } : {}),
          createTransport: (r) => {
            const base = (seams?.createTransport ?? ((x: readonly string[]) => createClientTransport({ relays: x })))(r);
            partition = partitionable(base.transport);
            return { ...base, transport: partition.transport };
          },
        },
      });
      if (result.status !== 'ready') throw new Error(`groupLibrary hook: bootstrap ${JSON.stringify(result)}`);
      account = result.account;
      for (const g of result.account.groups) groups.set(g.id, g);
      return { pubkey: result.account.handle.pubkey };
    },

    async stop() {
      const a = account;
      account = undefined;
      groups.clear();
      if (a) await a.teardown();
    },

    pubkey: () => need().handle.pubkey,

    async createGroup(name, opts) {
      const g = await need().handle.client.groups.create(name, opts?.admins ? { admins: opts.admins } : undefined);
      track(g);
      return { groupId: g.id };
    },

    async inviteByPubkey(groupId, pubkey, opts) {
      const g = await group(groupId);
      const client = need().handle.client;
      const kp = await new Promise<import('@941design/nostr-events/event').NostrEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          reject(new Error(`no key package observed for ${pubkey}`));
        }, opts?.timeoutMs ?? 20_000);
        const stop = client.keyPackages.observe(pubkey, (event) => {
          clearTimeout(timer);
          queueMicrotask(stop);
          resolve(event);
        });
      });
      await g.synced();
      const outcomes = await g.invite([kp]);
      return outcomes.map((o) => ({ status: o.status }));
    },

    async acceptFirstPending() {
      const client = need().handle.client;
      const pending: readonly PendingInvitation[] = await client.invitations.pending();
      if (pending.length === 0) return null;
      const g = await client.invitations.accept(pending[0].id);
      track(g);
      return g.id;
    },

    async pendingCount() {
      return (await need().handle.client.invitations.pending()).length;
    },

    async send(groupId, content) {
      const g = await group(groupId);
      const unsigned = {
        pubkey: need().handle.pubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [] as string[][],
        content,
      };
      const id = getEventHash(unsigned);
      await g.send({ type: 'application', rumor: { ...unsigned, id } });
      return { rumorId: id };
    },

    renameNoWait(groupId, name) {
      void (async () => {
        try {
          const g = await group(groupId);
          await g.rename(name);
        } catch (error) {
          console.warn('[groupLibrary] rename failed', error);
        }
      })();
    },

    async waitSynced(groupId) {
      await (await group(groupId)).synced();
    },

    setPartition(on) {
      partition?.setPartition(on);
    },

    groupInfo(groupId) {
      const g = groups.get(groupId);
      if (!g) throw new Error(`groupLibrary hook: unknown group ${groupId}`);
      return { nostrGroupId: g.nostrGroupId, epoch: g.epoch.toString(), name: g.name, members: [...g.members()], admins: [...g.admins] };
    },

    sink: () => sink,
    notifications: () => notifications.map((n) => ({ ...n })),
    failNextAppends: (count) => sink.failNextAppends(count),
    retained: (groupId) =>
      sink.retained(groupId).map((e) => ({
        eventId: e.eventId,
        rumorId: e.rumor.id,
        account: e.orderingKey.account,
        content: e.rumor.content,
      })),
  };
}
