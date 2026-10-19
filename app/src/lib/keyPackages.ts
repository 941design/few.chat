/**
 * KeyPackage publication utilities.
 * Publishes kind 443 KeyPackages to Nostr relays using the MarmotClient.
 * Called on first app launch and when key package count drops below threshold.
 */

import { DEFAULT_RELAYS } from '@/src/types';

export const KEY_PACKAGE_COUNT = 5;
export const KEY_PACKAGE_REPLENISH_THRESHOLD = 2;

/**
 * Publish `count` key packages for the given MarmotClient.
 * Wraps the operation in try/catch — marmot-ts is alpha.
 * Returns the number of successfully published key packages.
 */
export async function publishKeyPackages(
  keyPackageManager: import('@internet-privacy/marmot-ts').KeyPackageManager,
  count: number = KEY_PACKAGE_COUNT,
  relays: string[] = [...DEFAULT_RELAYS]
): Promise<number> {
  let published = 0;
  for (let i = 0; i < count; i++) {
    try {
      await keyPackageManager.create({
        relays,
        isLastResort: i === count - 1, // last one is last-resort
        client: 'few',
      });
      published++;
    } catch (err) {
      console.warn(`[keyPackages] Failed to publish key package ${i + 1}:`, err);
      // Continue — partial success is acceptable
    }
  }
  return published;
}

/**
 * Check how many unused local key packages exist.
 * Returns the count.
 */
export async function countAvailableKeyPackages(
  keyPackageManager: import('@internet-privacy/marmot-ts').KeyPackageManager
): Promise<number> {
  try {
    const packages = await keyPackageManager.list();
    return packages.filter((p) => !p.used).length;
  } catch {
    return 0;
  }
}

/**
 * Replenish key packages if below threshold.
 */
export async function replenishKeyPackagesIfNeeded(
  keyPackageManager: import('@internet-privacy/marmot-ts').KeyPackageManager,
  relays: string[] = [...DEFAULT_RELAYS]
): Promise<void> {
  const available = await countAvailableKeyPackages(keyPackageManager);
  if (available < KEY_PACKAGE_REPLENISH_THRESHOLD) {
    const needed = KEY_PACKAGE_COUNT - available;
    await publishKeyPackages(keyPackageManager, needed, relays);
  }
}


/**
 * Counts the relay events that a local KeyPackage backs (its published event
 * ids). Events no local KeyPackage backs — left behind by cleared browser data
 * or deleted by the startup cleanup — prove nothing about invitability.
 */
export function countBackedKeyPackageEvents(
  events: Iterable<{ id?: string }>,
  localPackages: ReadonlyArray<{ published?: ReadonlyArray<{ id: string }> }>,
): number {
  const localIds = new Set(localPackages.flatMap((kp) => (kp.published ?? []).map((e) => e.id)));
  let count = 0;
  for (const e of events) if (localIds.has(e.id as string)) count++;
  return count;
}

/**
 * Publishes a KeyPackage again when the relays hold none of ours although the
 * local store has some (bug invite-fresh-peer-fails-with-has). marmot-ts stores
 * a KeyPackage before publishing it and records the publish whatever the
 * relays answered, so a first publish no relay accepted (cold relay, offline at
 * first launch) would otherwise leave the account uninvitable for good.
 * A fetch that timed out or failed proves nothing and never republishes, so an
 * offline device does not churn. "Complete" is NDK's EOSE heuristic, not proof
 * that every relay answered; with one of two relays unreachable the fetch times
 * out and the check waits for the next start. Never throws.
 */
export async function ensureKeyPackagesOnRelays(deps: {
  /** Fetches our own KeyPackage events and counts those a local one backs. */
  fetchOwn: () => Promise<{ count: number; timedOut: boolean }>;
  /** Resolves to the number of KeyPackages published. */
  publish: () => Promise<number>;
}): Promise<'present' | 'republished' | 'failed' | 'unknown'> {
  let own: { count: number; timedOut: boolean };
  try {
    own = await deps.fetchOwn();
  } catch (err) {
    console.warn('[keyPackages] relay check failed:', err);
    return 'unknown';
  }
  // Any backed event found proves presence, even from a fetch that timed out.
  if (own.count > 0) return 'present';
  if (own.timedOut) return 'unknown';
  try {
    return (await deps.publish()) > 0 ? 'republished' : 'failed';
  } catch (err) {
    console.warn('[keyPackages] republish failed:', err);
    return 'failed';
  }
}
