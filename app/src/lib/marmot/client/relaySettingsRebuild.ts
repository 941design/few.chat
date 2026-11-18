import { bootstrapAccountClient, type AccountClient, type BootstrapInput, type BootstrapResult } from './createClient';
import { ensureInboxRelayList } from './inboxRelayList';
import { ensureKeyPackage } from './keyPackageEnsure';

interface RelayRebuildResult {
  bootstrap: BootstrapResult;
  rotationErrors: unknown[];
  /** Original ensure failure, also reported through bootstrap's onError callback. */
  inboxRelayListFailure?: { error: unknown };
}

/** Tear down before reacquiring the lease, then refresh key packages on the replacement client. */
export async function rebuildAccountForRelays(
  previous: Pick<AccountClient, 'teardown'> | null,
  input: BootstrapInput,
  previousRelays: readonly string[] = [],
  expectedPubkey?: string,
): Promise<RelayRebuildResult> {
  await previous?.teardown();
  let rotatingKeyPackages = false;
  let matchesAccount = true;
  let inboxRelayListFailure: RelayRebuildResult['inboxRelayListFailure'];
  const bootstrap = await bootstrapAccountClient({
    ...input,
    relayRebuild: { previousRelays, rotatingKeyPackages: () => rotatingKeyPackages, expectedPubkey },
    async onAccountResolved(pubkey) {
      matchesAccount = expectedPubkey === undefined || expectedPubkey === pubkey;
      await input.onAccountResolved?.(pubkey);
    },
    seams: {
      ...input.seams,
      async ensureKeyPackage(client) {
        rotatingKeyPackages = matchesAccount;
        try {
          return await (input.seams?.ensureKeyPackage ?? ensureKeyPackage)(client);
        } finally {
          rotatingKeyPackages = false;
        }
      },
    },
    inboxRelayList: {
      async ensure(context) {
        if (!matchesAccount) return input.inboxRelayList.ensure(context);
        try {
          await ensureInboxRelayList({ ...context, republish: true });
        } catch (error) {
          inboxRelayListFailure = { error };
          throw error;
        }
      },
    },
  });
  const rotationErrors: unknown[] = [];
  if (bootstrap.status !== 'ready' || !matchesAccount) return { bootstrap, rotationErrors, inboxRelayListFailure };

  const { account } = bootstrap;
  const { keyPackages } = account.handle.client;
  const isLive = () => !input.signal?.aborted && account.handle.leaseHeld();
  rotatingKeyPackages = true;
  try {
    for (const { id } of await keyPackages.list()) {
      if (!isLive()) break;
      try {
        await keyPackages.rotate(id);
      } catch (error) {
        rotationErrors.push(error);
      }
    }
  } catch (error) {
    rotationErrors.push(error);
  } finally {
    rotatingKeyPackages = false;
  }

  if (input.signal?.aborted || !account.handle.leaseHeld()) {
    await account.teardown();
    return { bootstrap: { status: 'aborted' }, rotationErrors, inboxRelayListFailure };
  }
  return { bootstrap, rotationErrors, inboxRelayListFailure };
}
