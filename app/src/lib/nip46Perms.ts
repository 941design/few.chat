/**
 * NIP-46 requested-permission set and stored-session discard check (D2).
 *
 * The requested set is the union of the library's own signer needs
 * (`permissions.toNip46Perms()`) and the app-signed kinds (see {@link APP_SIGN_EVENT_KINDS}). Kinds 443/444/445/1059/10051/30051 are no longer
 * requested. Requesting `sign_event:0` does not publish anything: kind 0 is
 * never broadcast (privacy invariant).
 *
 * Session storage is injected by the identity provider.
 */
import { permissions } from '@941design/marmot';
import { NDKKind, type NDKNip46Signer } from '@nostr-dev-kit/ndk';
import { verifyEvent } from 'nostr-tools/pure';
import { STORAGE_KEYS } from '@/src/types';
import { BLOSSOM_AUTH_KIND } from '@/src/lib/media/blossomAuthKind';
import {
  CALL_ANSWER_KIND,
  CALL_HANGUP_KIND,
  CALL_ICE_KIND,
  CALL_OFFER_KIND,
  CALL_REJECT_KIND,
  CALL_RENEGOTIATE_KIND,
} from '@/src/lib/calls/callKinds';

/**
 * App-signed kinds requested on top of the library's set: 0 (profile; never broadcast), 20602 (pairing card),
 * 30078 (backup), 10050 (inbox relay list), the Blossom upload authorization (24242), and the call signaling inner
 * events (25050-25055). The last two groups come from the code's own kind constants so a new account-signed kind
 * cannot be added without it showing here.
 */
export const APP_SIGN_EVENT_KINDS = [
  0,
  20602,
  30078,
  10050,
  BLOSSOM_AUTH_KIND,
  CALL_OFFER_KIND,
  CALL_ANSWER_KIND,
  CALL_ICE_KIND,
  CALL_HANGUP_KIND,
  CALL_REJECT_KIND,
  CALL_RENEGOTIATE_KIND,
] as const;

function splitPerms(list: string): string[] {
  return list.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Ordered, de-duplicated list of permissions to request from a bunker. */
export function buildNip46Permissions(): string[] {
  const out: string[] = [];
  for (const perm of [
    ...splitPerms(permissions.toNip46Perms()),
    ...APP_SIGN_EVENT_KINDS.map((k) => `sign_event:${k}`),
  ]) {
    if (!out.includes(perm)) out.push(perm);
  }
  return out;
}

/** Comma-joined form for the `perms` parameter of a nostrconnect URI. */
export function buildNip46PermsParam(): string {
  return buildNip46Permissions().join(',');
}

/**
 * True when a stored NIP-46 session must be discarded (cleared, user routed to
 * reconnect): its recorded permissions do not cover the current required set.
 * `recordedPerms` is the set the app REQUESTED at a successful connect, saved
 * next to the session — bunkers never report what they granted (the connect
 * reply is a bare ack) and NDK's stored payload records none. So the caller
 * must persist `buildNip46Permissions()` with the session on connect; a missing
 * record discards, which would otherwise force a reconnect on every load.
 */
export function shouldDiscardStoredNip46Session(
  recordedPerms: unknown,
): boolean {
  // Read from storage: anything that is not a string or an array of strings is corrupt -> discard.
  let have: Set<string>;
  if (typeof recordedPerms === 'string') {
    have = new Set(splitPerms(recordedPerms));
  } else if (Array.isArray(recordedPerms)) {
    if (!recordedPerms.every((p): p is string => typeof p === 'string')) return true;
    have = new Set(recordedPerms.map((p) => p.trim()).filter((p) => p.length > 0));
  } else {
    return true;
  }
  return buildNip46Permissions().some((perm) => !have.has(perm));
}

export function parseSignerAccountPubkey(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

type VerifiedNip46Account = { source: 'get_public_key'; pubkey: string };

export function loadVerifiedNip46Account(storage: Pick<Storage, 'getItem'>): string | null {
  try {
    const binding = JSON.parse(storage.getItem(STORAGE_KEYS.nip46Account) ?? 'null');
    return binding?.source === 'get_public_key' ? parseSignerAccountPubkey(binding.pubkey) : null;
  } catch {
    return null;
  }
}

export function saveNip46Session(storage: Pick<Storage, 'setItem' | 'removeItem'>, payload: string, account: VerifiedNip46Account): void {
  // A partial session replacement must leave offline wipe unbound.
  storage.removeItem(STORAGE_KEYS.nip46Account);
  storage.setItem(STORAGE_KEYS.nip46Session, payload);
  storage.setItem(STORAGE_KEYS.nip46Permissions, buildNip46PermsParam());
  storage.setItem(STORAGE_KEYS.nip46Account, JSON.stringify(account));
}

export function loadNip46Session(storage: Pick<Storage, 'getItem' | 'removeItem'>): string | null {
  const payload = storage.getItem(STORAGE_KEYS.nip46Session);
  if (!payload) return null;
  if (!shouldDiscardStoredNip46Session(storage.getItem(STORAGE_KEYS.nip46Permissions))) return payload;
  storage.removeItem(STORAGE_KEYS.nip46Session);
  storage.removeItem(STORAGE_KEYS.nip46Permissions);
  return null;
}

export async function requestVerifiedNip46Account(
  signer: Pick<NDKNip46Signer, 'bunkerPubkey' | 'rpc'>,
): Promise<VerifiedNip46Account> {
  const bunker = parseSignerAccountPubkey(signer.bunkerPubkey);
  if (!bunker) throw new Error('NIP-46 bunker public key is unavailable');

  // NDK's getter can return a cached URI or session hint. Use its encrypted,
  // request-ID-correlated RPC and authenticate the reply against the bunker.
  return new Promise((resolve, reject) => {
    void signer.rpc.sendRequest(bunker, 'get_public_key', [], NDKKind.NostrConnect, (reply) => {
      try {
        const { id, pubkey: sender, kind, created_at, tags, content, sig } = reply.event.rawEvent();
        const pubkey = parseSignerAccountPubkey(reply.result);
        // Check a fresh event object so cached signature verification cannot
        // carry over from another representation.
        const event = { id, pubkey: sender, kind, created_at, tags, content, sig };
        if (reply.error || !pubkey || sender !== bunker || kind !== NDKKind.NostrConnect || !verifyEvent(event)) {
          throw new Error('NIP-46 account response could not be verified');
        }
        resolve({ source: 'get_public_key', pubkey });
      } catch (error) {
        reject(error);
      }
    }).catch(reject);
  });
}

/** Add permissions to the connect request made by NDK's bunker handshake. */
export async function connectBunkerWithPermissions(
  signer: Pick<NDKNip46Signer, 'rpc' | 'blockUntilReady'>,
) {
  const rpc = signer.rpc;
  const original = rpc.sendRequest;
  rpc.sendRequest = (recipient, method, params, kind, callback) => original.call(
    rpc,
    recipient,
    method,
    method === 'connect' ? [params?.[0] ?? '', params?.[1] ?? '', buildNip46PermsParam()] : params,
    kind,
    callback,
  );
  try {
    return await signer.blockUntilReady();
  } finally {
    rpc.sendRequest = original;
  }
}
