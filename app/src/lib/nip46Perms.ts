/**
 * NIP-46 requested-permission set and stored-session discard check (D2).
 *
 * The requested set is the union of the library's own signer needs
 * (`permissions.toNip46Perms()`) and the few app-signed kinds (0 existing
 * app behaviour, 20602 pairing card, 30078 backup,
 * 10050 inbox relay list). Kinds 443/444/445/1059/10051/30051 are no longer
 * requested. Requesting `sign_event:0` does not publish anything: kind 0 is
 * never broadcast (privacy invariant).
 *
 * Pure: no React, no storage access; wiring lives in NostrIdentityContext (S18).
 */
import { permissions } from '@941design/marmot';

/** App-signed kinds requested on top of the library's set. */
export const APP_SIGN_EVENT_KINDS = [0, 20602, 30078, 10050] as const;

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
