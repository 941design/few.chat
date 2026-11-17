/**
 * Key-package presence for the account (bootstrap step 8).
 *
 * `keyPackages.count() === 0` -> mint exactly one last-resort KeyPackage
 * (kind 30443, addressable; the library never uses kind 443). Otherwise leave
 * the existing ones alone. Rotation after consumption is the library's job.
 */
import type { MarmotClient } from '@941design/marmot';

export type KeyPackageEnsureOutcome = 'created' | 'present';

export async function ensureKeyPackage(
  client: Pick<MarmotClient, 'keyPackages'>,
): Promise<KeyPackageEnsureOutcome> {
  const count = await client.keyPackages.count();
  if (count > 0) return 'present';
  await client.keyPackages.create({ lastResort: true });
  return 'created';
}
