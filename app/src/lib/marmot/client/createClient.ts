/**
 * Account client bootstrap (D1, D2, D15; seams `AccountClientHandle`,
 * `InboxRelayListEnsure`).
 *
 * Builds the ONE `MarmotClient` for an account and runs the startup sequence
 * in the order the library requires:
 *
 *   1. gates      secure context, signer NIP-44 (no client is constructed when unmet)
 *   2. stores     `openForWrite(pubkey)` (takes the per-account lease)
 *   3. client     `createMarmotClient` (transport, budget, timing options, sink)
 *   4. listeners  `client.on(...)` for the app-visible lifecycle events
 *   5. inbox      `registerInboxHandler` for the app inbox kinds (21059, 21064)
 *   6. groups     `await client.groups.list()` (starts every group's sync)
 *   7. notify     `group.onNotification(...)` per listed group; groups created or
 *                 joined later are attached structurally: the `groupCreated` /
 *                 `groupJoined` listeners (step 4) enqueue a job that fetches the
 *                 group handle and attaches it
 *   8. history    `await history.sweep()`: recovers the history rows no live call has
 *                 touched yet (the library starts each group's history drain during
 *                 step 6, so a recovered row is ordered ahead of live entries by the
 *                 sink's per-group first-touch recovery; this pass covers the rest).
 *                 A rejected sweep is reported (step `historySweep`) and does not abort; the wait is
 *                 capped at HISTORY_SWEEP_WAIT_MS (reported as a timeout, the sweep goes on in the
 *                 background) and ends on abort
 *   9. inbox      `await client.inbox.start()` (after groups and after the sweep settles:
 *                 removals that settled offline are announced on first group load)
 *  10. kp         key-package ensure (count 0 -> create last-resort, else none)
 *  11. 10050      the initial inbox-relay-list ensure, after (10)
 *
 * Abort: `input.signal` is checked after every await; on abort the contract-order
 * teardown runs (lease released) and the result is `{ status: 'aborted' }`.
 *
 * Boundaries: only this module constructs/disposes the client (never React,
 * never a context). Code that runs inside a library frame (listeners, inbox
 * handlers, group notifications, the history sink) must not await an
 * account-scope client call: it schedules follow-up work on `handle.enqueue`
 * (an owned `setTimeout(0)` FIFO). Group sender identity is
 * `orderingKey.account`, never `rumor.pubkey` (enforced by the consumers).
 *
 * Everything is injected: omitting a required collaborator is a loud
 * `TypeError`, never a silent no-op. Importing this module touches no browser
 * API; the library is only exercised when `bootstrapAccountClient` runs.
 */
import { createMarmotClient as libCreateMarmotClient } from '@941design/marmot';
import type { NostrEvent } from '@941design/nostr-events/event';
import { parseDmRelayList10050, parseRelayList10002 } from '@941design/nostr-events/parsers';
import type {
  ClientOptions,
  GroupNotification,
  HistoryBackend,
  InboxRumorHandler,
  MarmotClient,
  MarmotClientEvents,
  MarmotGroup,
} from '@941design/marmot';
import type { Signer } from '@941design/nostr-events/signer';
import type { WritableStores } from '@941design/marmot/storage';
import {
  createAccountSigner,
  REMOTE_SIGNER_TIMEOUT_MS,
  type AppEventSigner,
  type SignerKind,
} from './signerAdapter';
import { APP_INBOX_KINDS } from '../kinds';
import { createClientTransport, type ClientTransport } from './transport';
import { openAccountStores, type OpenStoresResult } from './storage';
import { createJobQueue, INBOX_CALLBACK, type ClientJobQueue, type JobQueue } from './fifo';
import { ensureKeyPackage, type KeyPackageEnsureOutcome } from './keyPackageEnsure';
import { createTeardown } from './lifecycle';
import {
  INBOX_RELAY_LIST_KIND,
  createInboxRelayOwnership,
  createLegacyInboxDiscovery,
  isForeignInboxRelayList,
  latestVerifiedRelayList,
} from './inboxRelayOwnership';

/** Library timing options the app pins (everything else keeps the library default). */
const CLIENT_TIMING_OPTIONS = { leaveTimeoutMs: 10_000, removalSettleMs: 5_000 } as const;

/** Lifecycle events the app listens to; every one needs a handler. */
export const CLIENT_EVENT_NAMES = [
  'groupRemoved',
  'inboxDisposition',
  'welcomeDeclined',
  'intentFailed',
  'storeIncompatible',
  'groupBranchSwitched',
] as const;
type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];
type ClientEventHandlers = {
  [E in ClientEventName]: (payload: MarmotClientEvents[E]) => void;
};

/** Seam `InboxRelayListEnsure`: publishes the account's kind-10050 when policy allows (policy is not owned here). */
export interface InboxRelayListEnsure {
  ensure: (ctx: {
    pubkey: string;
    relays: string[];
    previousRelays?: readonly string[];
    observeInboxRelayList?: (events: readonly NostrEvent[]) => NostrEvent | undefined;
    assertCanPublish?: () => void;
    transport: ClientTransport['transport'];
    signer: Pick<Signer, 'signEvent'>;
    signal?: AbortSignal;
  }) => Promise<void>;
}

/** Seam `AccountClientHandle`: what feature modules receive by injection. */
export interface AccountClientHandle {
  client: MarmotClient;
  pubkey: string;
  /** False once the lease is lost or released: no group write may happen then. */
  leaseHeld: () => boolean;
  enqueue: ClientJobQueue['enqueue'];
}

export type BootstrapStep =
  | 'gates'
  | 'getPublicKey'
  | 'stores'
  | 'client'
  | 'listeners'
  | 'inboxHandlers'
  | 'groups.list'
  | 'groupNotifications'
  | 'historySweep'
  | 'inbox.start'
  | 'keyPackageEnsure'
  | 'inboxRelayListEnsure'
  | 'listener'
  | 'queuedJob';

export interface BootstrapSeams {
  createMarmotClient?: typeof libCreateMarmotClient;
  openStores?: (pubkey: string) => Promise<OpenStoresResult>;
  createTransport?: (relays: readonly string[]) => ClientTransport;
  ensureKeyPackage?: (client: MarmotClient) => Promise<KeyPackageEnsureOutcome>;
  createQueue?: () => JobQueue;
  isSecureContext?: () => boolean;
  /** Timeout for a remote signer's `getPublicKey()`; defaults to the remote signer budget timeout. */
  signerTimeoutMs?: number;
}

export interface BootstrapInput {
  eventSigner: AppEventSigner;
  signerKind: SignerKind;
  /** Called after signer identity resolves and before account lease acquisition. */
  onAccountResolved?: (pubkey: string) => void | Promise<void>;
  /** The user's configured relays: library defaults, and the 10050 list. */
  relays: readonly string[];
  /** Relay-settings rebuild: retain discovery access without retaining old defaults. */
  relayRebuild?: { previousRelays: readonly string[]; rotatingKeyPackages: () => boolean; expectedPubkey?: string };
  /**
   * The app sink (S3); the library retains accepted group messages through it. Its `sweep()` (structural
   * port: client/ does not import history/) runs after `groups.list()` and before `inbox.start()`; its
   * `dispose()` runs in teardown before `client.dispose()`. One backend instance per bootstrap: a disposed
   * backend rejects every call, so a re-bootstrap needs a fresh instance.
   */
  history: HistoryBackend & { sweep: () => Promise<unknown>; dispose: () => void | Promise<void> };
  clientEvents: ClientEventHandlers;
  inboxHandlers: { joinRequest: InboxRumorHandler; inviteContext: InboxRumorHandler };
  onGroupNotification: (group: MarmotGroup, notification: GroupNotification) => void;
  inboxRelayList: InboxRelayListEnsure;
  /** Overrides on top of `CLIENT_TIMING_OPTIONS` (tests lower history timeouts). */
  clientOptions?: ClientOptions;
  /** Non-fatal step failures (the two ensure steps), listener exceptions and failed queued jobs. */
  onError?: (step: BootstrapStep, error: unknown) => void;
  /** Aborts an in-flight bootstrap: whatever was acquired is released, the result is `{ status: 'aborted' }`. */
  signal?: AbortSignal;
  /** False after the device reset generation changes, including while an operation is awaiting I/O. */
  isCurrent?: () => boolean;
  /** Compose account-scoped ports before group loading can deliver history. */
  onAccountOpened?: (handle: AccountClientHandle, transport: ClientTransport['transport'], attachGroup: AccountClient['attachGroup']) => void;
  /** Reconcile overlay rows before inbox delivery. */
  afterGroupsListed?: (groups: readonly MarmotGroup[]) => Promise<void>;
  /** Runs after disposal, while the session still owns the store lease. */
  beforeStoresClose?: (stores: WritableStores) => Promise<void>;
  /** Recover committed app cleanup while holding the lease, before constructing the client. */
  beforeClientConstruction?: (stores: WritableStores) => Promise<void>;
  seams?: BootstrapSeams;
}

export interface AccountClient {
  handle: AccountClientHandle;
  stores: WritableStores;
  transport: ClientTransport['transport'];
  groups: readonly MarmotGroup[];
  /** Outcome of the two non-fatal ensure steps (`failed` is also sent to `onError`). */
  ensure: { keyPackage: KeyPackageEnsureOutcome | 'failed'; inboxRelayList: 'ok' | 'failed' };
  /** Available after an initial failure. Rejects on failure and updates ensure on recovery. */
  retryInboxRelayList?: () => Promise<void>;
  /** A historical ownership lookup needs an explicit retry before Few may publish kind 10050. */
  readonly legacyInboxDiscoveryPending?: boolean;
  retryLegacyInboxDiscovery?: () => Promise<void>;
  /** Attaches the notification listener to a group created/joined after bootstrap. Idempotent per group handle; a no-op after teardown. */
  attachGroup: (group: MarmotGroup) => void;
  queue: JobQueue;
  teardown: () => Promise<void>;
}

export type BootstrapResult =
  | { status: 'ready'; account: AccountClient }
  | { status: 'unsupported'; reason: 'insecure-context' | 'nip44' | 'storage' }
  | { status: 'lease-held' }
  | { status: 'aborted' }
  /** A remote signer did not answer `getPublicKey()` within the budget timeout (reported as step `getPublicKey`); nothing was opened. */
  | { status: 'signer-timeout' };

function requireFn(value: unknown, name: string): void {
  if (typeof value !== 'function') {
    throw new TypeError(`bootstrapAccountClient: required dependency "${name}" is missing`);
  }
}

function assertInput(input: BootstrapInput): void {
  if (!input || typeof input !== 'object') {
    throw new TypeError('bootstrapAccountClient: input is required');
  }
  if (!input.eventSigner) throw new TypeError('bootstrapAccountClient: required dependency "eventSigner" is missing');
  requireFn(input.eventSigner.getPublicKey, 'eventSigner.getPublicKey');
  requireFn(input.eventSigner.signEvent, 'eventSigner.signEvent');
  if (!Array.isArray(input.relays) || input.relays.length === 0) {
    throw new TypeError('bootstrapAccountClient: "relays" must list at least one relay');
  }
  if (!input.history) throw new TypeError('bootstrapAccountClient: required dependency "history" is missing');
  requireFn(input.history.sweep, 'history.sweep');
  requireFn(input.history.dispose, 'history.dispose');
  for (const name of CLIENT_EVENT_NAMES) requireFn(input.clientEvents?.[name], `clientEvents.${name}`);
  requireFn(input.inboxHandlers?.joinRequest, 'inboxHandlers.joinRequest');
  requireFn(input.inboxHandlers?.inviteContext, 'inboxHandlers.inviteContext');
  requireFn(input.onGroupNotification, 'onGroupNotification');
  requireFn(input.inboxRelayList?.ensure, 'inboxRelayList.ensure');
}

class SignerTimeoutError extends Error {
  constructor(ms: number) {
    super(`signer getPublicKey() did not answer within ${ms} ms`);
    this.name = 'SignerTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SignerTimeoutError(ms)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Longest the bootstrap waits for `history.sweep()` before it starts the inbox anyway (AC-BOOT-1). */
export const HISTORY_SWEEP_WAIT_MS = 15_000;

type SweepOutcome = { kind: 'settled' } | { kind: 'failed'; error: unknown } | { kind: 'timeout' } | { kind: 'aborted' };

/** Races the sweep against the cap and the abort signal; the sweep itself is never cancelled. */
function waitForSweep(sweep: Promise<unknown>, signal: AbortSignal | undefined, capMs: number): Promise<SweepOutcome> {
  return new Promise<SweepOutcome>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish({ kind: 'aborted' });
    const finish = (outcome: SweepOutcome) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    timer = setTimeout(() => finish({ kind: 'timeout' }), capMs);
    if (signal?.aborted) return finish({ kind: 'aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(sweep).then(
      () => finish({ kind: 'settled' }),
      (error: unknown) => finish({ kind: 'failed', error }),
    );
  });
}

export async function bootstrapAccountClient(input: BootstrapInput): Promise<BootstrapResult> {
  assertInput(input);
  const seams = input.seams ?? {};
  const signal = input.signal;
  const aborted = () => signal?.aborted === true || input.isCurrent?.() === false;
  const reportError = (step: BootstrapStep, error: unknown) => {
    try {
      (input.onError ?? ((s, e) => console.error(`[marmot/client] ${s} failed`, e)))(step, error);
    } catch {
      /* a reporter must never break the bootstrap */
    }
  };

  if (aborted()) return { status: 'aborted' };

  // 1. gates -- before anything is constructed or opened.
  const secure = (seams.isSecureContext ?? (() => globalThis.isSecureContext === true))();
  if (!secure) return { status: 'unsupported', reason: 'insecure-context' };
  const accountSigner = createAccountSigner({ eventSigner: input.eventSigner, kind: input.signerKind });
  if (accountSigner.status === 'unsupported') return { status: 'unsupported', reason: accountSigner.reason };

  // A remote signer (extension prompt, bunker round trip) can hang: bound it like every other signer call.
  let pubkey: string;
  const pubkeyCall = Promise.resolve(accountSigner.signer.getPublicKey());
  if (input.signerKind === 'local') {
    pubkey = await pubkeyCall;
  } else {
    try {
      pubkey = await withTimeout(pubkeyCall, seams.signerTimeoutMs ?? REMOTE_SIGNER_TIMEOUT_MS);
    } catch (error) {
      if (aborted()) return { status: 'aborted' };
      if (error instanceof SignerTimeoutError) {
        reportError('getPublicKey', error);
        return { status: 'signer-timeout' };
      }
      throw error;
    }
  }
  if (aborted()) return { status: 'aborted' };

  await input.onAccountResolved?.(pubkey);
  if (aborted()) return { status: 'aborted' };

  // 2. stores (lease)
  const opened = await (seams.openStores ?? ((pk: string) => openAccountStores(pk)))(pubkey);
  if (opened.status === 'unsupported') return aborted() ? { status: 'aborted' } : { status: 'unsupported', reason: opened.reason };
  if (opened.status === 'lease-held') return aborted() ? { status: 'aborted' } : { status: 'lease-held' };
  const { stores } = opened;

  const queue = (seams.createQueue ?? (() => createJobQueue({ onError: (e) => reportError('queuedJob', e) })))();
  const unsubscribers: Array<() => void> = [];
  let transport: ClientTransport | undefined;
  let client: MarmotClient | undefined;
  let tornDown = false;
  let retryAbort: AbortController | undefined;
  const isActive = () => !tornDown && !aborted() && stores.lease.held;
  const teardownOnce = createTeardown({
      client: { dispose: () => client?.dispose() },
      stores,
      beforeStoresClose: () => input.beforeStoresClose?.(stores),
      closePool: () => transport?.closePool(),
      queue,
      history: input.history,
      unsubscribers,
    });
  const teardownNow = () => {
    tornDown = true;
    retryAbort?.abort();
    return teardownOnce();
  };
  const abortNow = async (): Promise<BootstrapResult> => {
    await teardownNow();
    return { status: 'aborted' };
  };

  try {
    if (aborted()) return await abortNow();

    await input.beforeClientConstruction?.(stores);
    if (aborted()) return await abortNow();

    const transition = input.relayRebuild;
    const rebuild = transition?.expectedPubkey && transition.expectedPubkey !== pubkey ? undefined : transition;
    const observeInboxRelayList = createInboxRelayOwnership(pubkey, isActive);
    const legacyDiscovery = createLegacyInboxDiscovery(pubkey, input.relays, rebuild?.previousRelays);
    const assertCanPublish = () => {
      if (!isActive()) throw new Error('Publishing requires an active account lease');
      if (legacyDiscovery.pending) throw new Error('Previous relay ownership is unresolved. Save relay settings to retry.');
    };
    let activeInboxRelays: Set<string> | undefined;
    let inboxFallbackRelays: readonly string[] | undefined;

    // 3. client
    transport = (seams.createTransport ?? ((relays) => createClientTransport({ relays })))(input.relays);
    const network = transport.transport;
    const publish: typeof network.publish = async (relays, event, opts) => {
      opts?.signal?.throwIfAborted();
      if (!isActive()) throw new Error('Publishing requires an active account lease');
      if (event.kind === INBOX_RELAY_LIST_KIND) assertCanPublish();
      return network.publish(relays, event, opts);
    };
    const ensureTransport = { ...network, publish };
    const discoverLegacy = (explicit: boolean, attemptSignal?: AbortSignal) =>
      legacyDiscovery.discover(network, observeInboxRelayList, isActive, explicit, attemptSignal);
    {
      const rotatingKeyPackages = rebuild?.rotatingKeyPackages ?? (() => false);
      transport = {
        ...transport,
        transport: {
          subscription(relays, filters) {
            const queries = Array.isArray(filters) ? filters : [filters];
            // The library opens its live inbox with an account-scoped kind-1059 filter.
            if (queries.length === 1 && queries[0].kinds?.length === 1 && queries[0].kinds[0] === 1059 &&
                queries[0]['#p']?.length === 1 && queries[0]['#p'][0] === pubkey) {
              activeInboxRelays = new Set(relays);
            }
            return network.subscription(relays, filters);
          },
          async requestWithDeadline(relays, filters, opts) {
            const queries = Array.isArray(filters) ? filters : [filters];
            const ownWriteList = queries.every((filter) =>
              filter.kinds?.length === 1 && filter.kinds[0] === 10002 &&
              filter.authors?.length === 1 && filter.authors[0] === pubkey);
            // A relay-settings save explicitly chooses this account's defaults.
            // Do not let its old NIP-65 list override that choice. Returning no
            // candidate makes the library select defaults before persisting the
            // publish targets and classifying their real acknowledgments.
            if (ownWriteList) {
              const result = await network.requestWithDeadline(relays, filters, opts);
              if (rotatingKeyPackages()) return { ...result, events: [] };
              const latest = latestVerifiedRelayList(pubkey, 10002, result.events);
              const read = latest ? parseRelayList10002(latest).read : [];
              inboxFallbackRelays = result.timedOut ? undefined : read.length ? read : input.relays;
              return result;
            }
            const ownInboxList = queries.every((filter) =>
              filter.kinds?.length === 1 && filter.kinds[0] === INBOX_RELAY_LIST_KIND &&
              filter.authors?.length === 1 && filter.authors[0] === pubkey);
            if (!ownInboxList) {
              return network.requestWithDeadline(relays, filters, opts);
            }
            // The library treats any timeout as unknown, even if a verified
            // foreign list is available. Allow that list for receiving, but keep
            // the ensure's separate lookup honest before it may publish.
            const current = await network.requestWithDeadline(relays, filters, opts);
            const latest = observeInboxRelayList(current.events);
            const verifiedForeign = latest && isForeignInboxRelayList(latest) &&
              parseDmRelayList10050(latest).relay.length > 0;
            return {
              ...current,
              events: latest ? [latest] : [],
              timedOut: current.timedOut && !verifiedForeign,
            };
          },
          publish,
        },
      };
    }
    client = (seams.createMarmotClient ?? libCreateMarmotClient)({
      signer: accountSigner.signer,
      budget: accountSigner.budget,
      transport: transport.transport,
      stores,
      relays: { defaults: [...input.relays], mode: 'discover' },
      history: {
        append: (entry) => queue.runInCallback(entry.groupId, () => input.history.append(entry)),
        withdraw: (groupId, ids) => queue.runInCallback(groupId, () => input.history.withdraw(groupId, ids)),
        list: (groupId) => input.history.list(groupId),
        purge: (groupId) => input.history.purge(groupId),
      },
      options: { ...CLIENT_TIMING_OPTIONS, ...input.clientOptions },
    });
    const liveClient = client;
    const handle: AccountClientHandle = {
      client: liveClient, pubkey, leaseHeld: isActive, enqueue: queue.enqueue,
    };

    // Per-group notification listeners. Attachment is tracked by handle identity: the library builds a new
    // runtime + handle when a group id is rejoined after an abandon/purge, and that handle needs its own listener.
    const attachedHandles = new WeakSet<MarmotGroup>();
    const attachGroup = (group: MarmotGroup) => {
      if (tornDown || attachedHandles.has(group)) return;
      attachedHandles.add(group);
      unsubscribers.push(
        group.onNotification((notification) => {
          try {
            input.onGroupNotification(group, notification);
          } catch (error) {
            reportError('listener', error);
          }
        }),
      );
    };

    input.onAccountOpened?.(handle, transport.transport, attachGroup);

    // 4. listeners (attached before groups load: groupRemoved for offline-settled removals fires on first load)
    for (const name of CLIENT_EVENT_NAMES) {
      const handler = input.clientEvents[name] as (payload: unknown) => void;
      unsubscribers.push(
        liveClient.on(name, (payload: unknown) => {
          try {
            handler(payload);
          } catch (error) {
            reportError('listener', error);
          }
        }),
      );
    }
    // Structural attach for groups created/joined after bootstrap. The listener frame never awaits a client
    // call: it only enqueues (as its last action) a job that fetches the handle and attaches it.
    for (const name of ['groupCreated', 'groupJoined'] as const) {
      unsubscribers.push(
        liveClient.on(name, (payload: { groupId: string }) => {
          const groupId = payload.groupId;
          queue.enqueue(async () => {
            if (tornDown) return;
            let group: MarmotGroup | undefined;
            try {
              group = await liveClient.groups.get(groupId);
            } catch (error) {
              // Suspended in `get` while teardown disposed the client: the rejection is the teardown, not a failure.
              if (tornDown) return;
              throw error;
            }
            if (tornDown || !group) return;
            attachGroup(group);
          });
        }),
      );
    }

    // 5. inbox handlers
    unsubscribers.push(
      liveClient.extensions.registerInboxHandler(APP_INBOX_KINDS.joinRequest, (rumor, ctx) =>
        queue.runInCallback(INBOX_CALLBACK, () => input.inboxHandlers.joinRequest(rumor, ctx))),
      liveClient.extensions.registerInboxHandler(APP_INBOX_KINDS.inviteContext, (rumor, ctx) =>
        queue.runInCallback(INBOX_CALLBACK, () => input.inboxHandlers.inviteContext(rumor, ctx))),
    );

    // 6. groups (this starts every stored group's relay sync)
    const groups = await liveClient.groups.list();
    if (aborted()) return await abortNow();

    // 7. per-group notification listeners
    for (const group of groups) attachGroup(group);
    await input.afterGroupsListed?.(groups);
    if (aborted()) return await abortNow();

    // 8. history sweep (non-fatal: a failed sweep leaves rows undispatched for the next first-touch / startup)
    // Bounded: waits for the sweep at most HISTORY_SWEEP_WAIT_MS and stops waiting on abort. Past the cap the
    // sweep keeps running in the background (its per-group serialisation still orders recovered rows).
    const sweepOutcome = await waitForSweep(Promise.resolve().then(() => input.history.sweep()), signal, HISTORY_SWEEP_WAIT_MS);
    if (sweepOutcome.kind === 'failed') reportError('historySweep', sweepOutcome.error);
    else if (sweepOutcome.kind === 'timeout') {
      reportError('historySweep', new Error(`history sweep did not settle within ${HISTORY_SWEEP_WAIT_MS} ms; continuing`));
    }
    if (aborted()) return await abortNow();

    // 9. inbox
    try {
      await discoverLegacy(!!rebuild, signal);
    } catch (error) {
      if (isActive()) reportError('inboxRelayListEnsure', error);
    }
    if (aborted()) return await abortNow();
    await liveClient.inbox.start();
    if (aborted()) return await abortNow();

    // 10. key package, 11. kind-10050 (both non-fatal: the client stays usable for receiving)
    const ensure: AccountClient['ensure'] = { keyPackage: 'failed', inboxRelayList: 'failed' };
    try {
      ensure.keyPackage = await (seams.ensureKeyPackage ?? ensureKeyPackage)(liveClient);
    } catch (error) {
      reportError('keyPackageEnsure', error);
    }
    if (aborted()) return await abortNow();
    const ensureInboxList = (attemptSignal: AbortSignal | undefined) => input.inboxRelayList.ensure({
      pubkey, relays: [...input.relays], observeInboxRelayList, assertCanPublish,
      transport: ensureTransport, signer: liveClient.signer, signal: attemptSignal,
    });
    let refreshPending = false;
    const refreshInboxIfMoved = async (isActive: () => boolean) => {
      if (!isActive()) return false;
      const latest = observeInboxRelayList([]);
      const advertised = latest ? parseDmRelayList10050(latest).relay : [];
      const nextRelays = advertised.length ? advertised : inboxFallbackRelays;
      const current = activeInboxRelays;
      if (!refreshPending && (!current || !nextRelays ||
          (current.size === nextRelays.length && nextRelays.every((relay) => current.has(relay))))) {
        return true;
      }
      refreshPending = true;
      await liveClient.inbox.stop();
      if (!isActive()) return false;
      await liveClient.inbox.start();
      refreshPending = false;
      return isActive();
    };
    try {
      await ensureInboxList(signal);
      ensure.inboxRelayList = 'ok';
    } catch (error) {
      reportError('inboxRelayListEnsure', error);
    }
    if (aborted()) return await abortNow();
    if (ensure.inboxRelayList === 'ok' && !await refreshInboxIfMoved(() => !aborted() && handle.leaseHeld())) {
      return await abortNow();
    }

    let retryInboxRelayList: AccountClient['retryInboxRelayList'];
    let retryLegacyInboxDiscovery: AccountClient['retryLegacyInboxDiscovery'];
    if (ensure.inboxRelayList === 'failed' || legacyDiscovery.pending) {
      const controller = new AbortController();
      retryAbort = controller;
      const abortRetry = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abortRetry, { once: true });
      unsubscribers.push(() => signal?.removeEventListener('abort', abortRetry));
      const assertRetryActive = () => {
        controller.signal.throwIfAborted();
        if (!handle.leaseHeld()) throw new Error('Inbox relay list retry requires an active account lease');
      };
      let listEnsured = false;
      const retryEnsure = async () => {
        assertRetryActive();
        if (ensure.inboxRelayList === 'ok') return;
        if (!listEnsured) {
          await ensureInboxList(controller.signal);
          listEnsured = true;
        }
        assertRetryActive();
        await refreshInboxIfMoved(() => !controller.signal.aborted && handle.leaseHeld());
        assertRetryActive();
        ensure.inboxRelayList = 'ok';
      };
      if (legacyDiscovery.pending) {
        let inFlight: Promise<void> | undefined;
        const retryLegacy = async () => {
          assertRetryActive();
          if (!legacyDiscovery.pending) return retryEnsure();
          await discoverLegacy(true, controller.signal);
          assertRetryActive();
          if (legacyDiscovery.pending) {
            await refreshInboxIfMoved(() => !controller.signal.aborted && isActive());
            assertRetryActive();
            assertCanPublish();
          }
          ensure.inboxRelayList = 'failed';
          await retryEnsure();
        };
        retryLegacyInboxDiscovery = () => inFlight ??= retryLegacy().finally(() => { inFlight = undefined; });
      } else {
        retryInboxRelayList = retryEnsure;
      }
    }

    const account: AccountClient = {
      handle,
      stores,
      transport: transport.transport,
      groups,
      ensure,
      retryInboxRelayList,
      get legacyInboxDiscoveryPending() { return legacyDiscovery.pending; },
      retryLegacyInboxDiscovery,
      attachGroup,
      queue,
      teardown: () => {
        return teardownNow();
      },
    };
    return { status: 'ready', account };
  } catch (error) {
    const inactive = aborted() && !tornDown;
    try {
      await teardownNow();
    } catch (closeError) {
      if (closeError !== error) {
        throw new AggregateError([error, closeError], 'Group client startup and teardown failed');
      }
    }
    if (inactive) return { status: 'aborted' };
    throw error;
  }
}
