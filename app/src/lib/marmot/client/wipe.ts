import type { WritableStores, WipeMarker } from '@941design/marmot/storage';

/** Durable intent, written before the library's atomic wipe transaction. */
export interface WipeCheckpoint {
  read(pubkey: string): Promise<{ previousMarker: WipeMarker | null } | undefined>;
  write(pubkey: string, previousMarker: WipeMarker | null): Promise<void>;
  clear(pubkey: string): Promise<void>;
}

function sameMarker(a: WipeMarker | null | undefined, b: WipeMarker | null | undefined): boolean {
  return (a == null && b == null) || (a != null && b != null &&
    a.at === b.at && a.reason === b.reason && a.engine === b.engine && a.tsMls === b.tsMls);
}

export async function resumeWipeCleanup(stores: WritableStores, checkpoint: WipeCheckpoint, clearAllGroupData: (pubkey: string) => Promise<void>): Promise<void> {
  if (!stores.lease.held) throw new Error('Cannot recover wipe without the account lease');
  const pubkey = stores.account.account;
  const intent = await checkpoint.read(pubkey);
  if (!intent) return;
  const marker = await stores.account.wipeMarker();
  if (!marker || marker.reason !== 'incompatible' || sameMarker(marker, intent.previousMarker)) return;
  if (!stores.lease.held) throw new Error('Account lease lost during wipe recovery');
  await clearAllGroupData(pubkey);
  if (!stores.lease.held) throw new Error('Account lease lost during wipe recovery');
  await checkpoint.clear(pubkey);
}

export interface StoreWipeGuard {
  wipe(stores: WritableStores, clearAllGroupData: (pubkey: string) => Promise<void>, checkpoint: WipeCheckpoint): Promise<'wiped' | 'unsupported'>;
}

export function createStoreWipeGuard(): StoreWipeGuard {
  let attempted = false;
  return {
    async wipe(stores, clearAllGroupData, checkpoint) {
      if (attempted || !stores.lease.held) return 'unsupported';
      attempted = true;
      const pubkey = stores.account.account;
      const previousMarker = await stores.account.wipeMarker() ?? null;
      // The library uses millisecond timestamps, so an equal or future prior
      // timestamp cannot safely distinguish a committed wipe after a crash.
      if (previousMarker && previousMarker.at >= Date.now()) throw new Error('Cannot distinguish the next wipe marker');
      await checkpoint.write(pubkey, previousMarker);
      if (!stores.lease.held) throw new Error('Account lease lost before wipe');
      const committed = await stores.account.wipe({ reason: 'incompatible' });
      if (sameMarker(committed, previousMarker)) throw new Error('Cannot distinguish committed wipe marker');
      await resumeWipeCleanup(stores, checkpoint, clearAllGroupData);
      return 'wiped';
    },
  };
}

export const pageStoreWipeGuard = createStoreWipeGuard();
