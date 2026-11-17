/**
 * Lifetime of a pending join request. Dependency-free so the inbox handler, the storage loader and the approval
 * (a pure module) can all enforce the same bound.
 */
export const PENDING_JOIN_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A request is expired once it is `PENDING_JOIN_REQUEST_TTL_MS` old (the boundary instant itself is expired). */
export function isPendingJoinRequestExpired(request: { receivedAt: number }, now: number): boolean {
  return request.receivedAt + PENDING_JOIN_REQUEST_TTL_MS <= now;
}
