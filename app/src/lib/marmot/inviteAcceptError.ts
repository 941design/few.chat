/** Which notice an accept failure shows: retry (invitation kept) or no longer valid. */
export function acceptErrorKind(err: unknown): 'retry' | 'invalid' {
  return err instanceof Error && err.name === 'InvitationRetryableError' ? 'retry' : 'invalid';
}
