/**
 * Accepting an invitation failed but the invitation was kept, so accepting again
 * can succeed (a stale local copy was already replaced and only the fresh join
 * failed). Any other accept failure removes the invitation.
 */
export class InvitationRetryableError extends Error {
  constructor() {
    super('Joining failed, please try again');
    this.name = 'InvitationRetryableError';
  }
}

/** Which notice an accept failure shows: retry (invitation kept) or no longer valid. */
export function acceptErrorKind(err: unknown): 'retry' | 'invalid' {
  return err instanceof Error && err.name === 'InvitationRetryableError' ? 'retry' : 'invalid';
}
