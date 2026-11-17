/**
 * Relay transport for the library client (D1).
 *
 * `createSimplePoolNetwork({pool}).asTransportContract()` over a nostr-tools
 * `SimplePool` owned by (and scoped to) one marmot client. No NDK, no custom
 * verifier (the adapter's `verifyEvents` default stays on). The pool is closed
 * when the client is torn down; the adapter itself never closes a caller-owned
 * pool.
 */
import { SimplePool } from 'nostr-tools/pool';
import { createSimplePoolNetwork } from '@941design/nostr-events/transport/simple-pool';
import type { TransportContract } from '@941design/nostr-events/transport/contract';

/**
 * The members of `SimplePool` the simple-pool network adapter actually calls
 * plus `destroy` (lets tests pass a recording pool without casts).
 */
export type ClientPool = Pick<
  SimplePool,
  'publish' | 'subscribeMany' | 'subscribeManyEose' | 'ensureRelay' | 'maxWaitForConnection' | 'close' | 'destroy'
>;

export interface ClientTransport {
  transport: TransportContract;
  pool: ClientPool;
  /** Closes every relay connection of the pool. Idempotent. */
  closePool: () => void;
}

export function createClientTransport(input: {
  relays: readonly string[];
  /** Pool seam; defaults to a fresh `new SimplePool()`. */
  createPool?: () => ClientPool;
}): ClientTransport {
  const pool = (input.createPool ?? (() => new SimplePool()))();
  // The adapter's parameter type is the full SimplePool; it only calls the members in ClientPool.
  const network = createSimplePoolNetwork({ pool: pool as SimplePool, defaultRelays: [...input.relays] });
  let closed = false;
  return {
    transport: network.asTransportContract(),
    pool,
    closePool() {
      if (closed) return;
      closed = true;
      pool.destroy();
    },
  };
}
