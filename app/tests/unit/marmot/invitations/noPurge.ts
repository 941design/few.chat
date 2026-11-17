/**
 * A purge-exclusion port that excludes nothing, for tests that do not exercise the purge/accept exclusion.
 * The ports are REQUIRED by `createInvitationActions` / `createAutoAccept` (the exclusion cannot be left out by
 * accident), so a test that does not care passes this explicitly.
 */
export const noPurge = {
  withGroupLock: <T>(_groupId: string, fn: () => Promise<T>): Promise<T> => fn(),
  whenPurged: async (_groupId: string): Promise<void> => undefined,
};
