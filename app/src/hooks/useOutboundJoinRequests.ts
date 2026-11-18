/**
 * React hook over the outbound join-request store (`src/lib/marmot/outboundJoinRequests.ts`).
 *
 * Both `records` AND `loaded` are piped through `useSyncExternalStore` over
 * the same `subscribe`. This is load-bearing: on an EMPTY initial load,
 * `_recomputeSnapshot([])` leaves `getSnapshot`'s array reference unchanged
 * (empty→empty), so the records subscription alone produces no re-render —
 * useSyncExternalStore suppresses re-renders when the snapshot reference is
 * Object.is-equal. A consumer that mounted before the load resolved would
 * then stay stuck at `loaded === false` and render nothing (e.g. the Invited
 * banner for a returning user opening a fresh invite link with no prior
 * outbound records). Reading `_loaded` plainly here does NOT fix that,
 * because there is no guaranteed re-render at which to re-read it. Routing
 * `loaded` through its own primitive-boolean snapshot makes the false→true
 * flip itself the re-render trigger.
 *
 * The hook lives here, not in `src/lib/marmot/`, so the marmot modules stay
 * free of React (AC-BOUND-1).
 */
import { useMemo, useSyncExternalStore } from 'react';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import {
  getLoadedServerSnapshot,
  getLoadedSnapshot,
  getServerSnapshot,
  getSnapshot,
  subscribe,
} from '@/src/lib/marmot/outboundJoinRequests';

export function useOutboundJoinRequests() {
  const { pubkeyHex } = useNostrIdentity();
  const records = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const loaded = useSyncExternalStore(subscribe, getLoadedSnapshot, getLoadedServerSnapshot);
  const accountRecords = useMemo(() => {
    const account = pubkeyHex?.toLowerCase();
    return records.filter(({ accountPubkey }) => !accountPubkey || accountPubkey === account);
  }, [records, pubkeyHex]);
  return { records: accountRecords, loaded };
}
