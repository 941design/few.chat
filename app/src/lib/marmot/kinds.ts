/**
 * App / inbox / retired kind registry (D12, seam `AppKinds`).
 *
 * Registry of every Nostr kind the app sends or handles over the library
 * transports. It becomes the single source once the old-flow modules that still
 * carry their own literals are removed or re-pointed (S22/S23). Library-reserved kinds are NOT copied here: they are
 * read from the library's `RUMOR_KINDS` so a library change cannot silently
 * collide with an app kind. The module validates itself at import time and
 * throws on any collision, so a bad edit fails the first test/build that
 * touches it.
 *
 * Pure: no React, no context imports (AC-BOUND-1).
 */
import { RUMOR_KINDS } from '@941design/marmot';
import { APP_INBOX_KINDS, APP_RUMOR_KINDS } from './kindRegistryInputs';

export { APP_INBOX_KINDS, APP_RUMOR_KINDS } from './kindRegistryInputs';

/** Kinds retired by the app. */
export const RETIRED_KINDS = [13, 21063] as const;

/** Kinds reserved by the library (values of `RUMOR_KINDS`). */
export const RESERVED_KINDS: readonly number[] = Object.values(RUMOR_KINDS);

type KindRegistryInputs = {
  appRumorKinds: readonly number[];
  appInboxKinds: readonly number[];
  retiredKinds: readonly number[];
  reservedKinds: readonly number[];
};

/**
 * Throws when two app kinds (rumor + inbox) are equal, or when an app kind
 * equals a retired or library-reserved kind. The message names the kinds.
 */
export function assertNoKindCollisions(inputs: KindRegistryInputs): void {
  const app = [...inputs.appRumorKinds, ...inputs.appInboxKinds];
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const kind of app) {
    if (seen.has(kind)) duplicates.add(kind);
    seen.add(kind);
  }
  if (duplicates.size > 0) {
    throw new Error(`kind registry: duplicate app kind(s) ${[...duplicates].join(', ')}`);
  }
  const retired = new Set(inputs.retiredKinds);
  const retiredHits = app.filter((k) => retired.has(k));
  if (retiredHits.length > 0) {
    throw new Error(`kind registry: app kind(s) ${retiredHits.join(', ')} collide with retired kinds`);
  }
  const reserved = new Set(inputs.reservedKinds);
  const reservedHits = app.filter((k) => reserved.has(k));
  if (reservedHits.length > 0) {
    throw new Error(`kind registry: app kind(s) ${reservedHits.join(', ')} collide with library RUMOR_KINDS`);
  }
}

/** Flattened app inbox kinds (dmProfile is a pair). */
export function flattenInboxKinds(inbox: typeof APP_INBOX_KINDS): number[] {
  return [inbox.joinRequest, inbox.pairingAck, ...inbox.dmProfile, inbox.inviteContext];
}

/** The inputs validated at import; exported so tests can pin that every list is wired in. */
export const REGISTRY_INPUTS = {
  appRumorKinds: APP_RUMOR_KINDS,
  appInboxKinds: flattenInboxKinds(APP_INBOX_KINDS),
  retiredKinds: RETIRED_KINDS,
  reservedKinds: RESERVED_KINDS,
} as const;

assertNoKindCollisions(REGISTRY_INPUTS);
