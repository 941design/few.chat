/**
 * EpochResolver — deterministic MLS fork resolution and message buffering.
 *
 * Wraps `mlsGroup.ingest()` with:
 * - Competing-commit detection (lowest event ID wins)
 * - State snapshot + rollback on fork
 * - Future-epoch buffering with automatic retry
 * - Grace window before finalising a commit
 */

import {
  serializeClientState,
  deserializeClientState,
  getEpoch,
  getGroupMembers,
} from '@internet-privacy/marmot-ts';
import type { IngestResult } from '@internet-privacy/marmot-ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

type EpochSnapshot = {
  epoch: number;
  stateBytes: Uint8Array;
  commitEventId: string;
  commitCreatedAt: number;
  takenAt: number;
  replayQueue: NostrEvent[];
};

type EpochResolverConfig = {
  graceWindowMs?: number; // default 3000
  maxBufferSize?: number; // default 50
};

type EpochResolverCallbacks = {
  onApplicationMessage?: (rumor: {
    id: string;
    kind: number;
    pubkey: string;
    created_at: number;
    content: string;
    tags: string[][];
  }) => void;
  onMembersChanged?: (members: string[]) => void;
};

/**
 * Minimal interface for the MarmotGroup methods we use.
 *
 * AC-SEAM-4: `ingest()`'s return type is the fork's exact `IngestResult`
 * union (imported, not hand-pinned) so this interface compiles against the
 * 0.7.0 shape — including the two authenticated-sender `rejected` variants
 * ('unauthenticated-sender' | 'undeserializable', which carry
 * `senderPubkey`/`claimedPubkey` and no `result` field, unlike the
 * pre-existing 'admin-policy' rejection). See processEvent/flushFutureBuffer
 * below for the terminal (never-bufferable) classification of those two
 * variants — architecture.md §6 guarantee 2.
 */
interface MlsGroupLike {
  state: import('ts-mls').ClientState;
  ingest(
    events: NostrEvent[],
    options?: { retryCount?: number; maxRetries?: number; _errors?: Array<{ eventId: string; error: unknown }> },
  ): AsyncGenerator<IngestResult>;
  save(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic comparison: lower `created_at` wins; tie-break by
 * lexicographic `id`. Matches marmot-ts `sortGroupCommits`.
 */
export function commitIsLower(
  a: { created_at: number; id: string },
  b: { created_at: number; id: string },
): boolean {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at;
  return a.id < b.id;
}

// ---------------------------------------------------------------------------
// EpochResolver
// ---------------------------------------------------------------------------

export class EpochResolver {
  private readonly mlsGroup: MlsGroupLike;
  private readonly callbacks: EpochResolverCallbacks;
  private readonly graceWindowMs: number;
  private readonly maxBufferSize: number;

  private snapshot: EpochSnapshot | null = null;
  private futureBuffer: NostrEvent[] = [];
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** Promise-chain lock to serialise concurrent `ingestEvent` calls. */
  private lockChain: Promise<void> = Promise.resolve();

  constructor(
    mlsGroup: MlsGroupLike,
    callbacks: EpochResolverCallbacks,
    config?: EpochResolverConfig,
  ) {
    this.mlsGroup = mlsGroup;
    this.callbacks = callbacks;
    this.graceWindowMs = config?.graceWindowMs ?? 3000;
    this.maxBufferSize = config?.maxBufferSize ?? 50;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Ingest a single event.
   *
   * Returns `{ buffered: true }` when the event could not be applied yet and was
   * parked in the future-epoch buffer (it arrived before the commit/message that
   * would let it decrypt). Callers use this to avoid permanently marking such an
   * event "seen": if this resolver is later disposed, dispose() clears the
   * buffer, and a fresh resolver's historical refetch must be allowed to
   * re-ingest the event rather than skip it as a duplicate. Applied, skipped, or
   * errored events return `{ buffered: false }` — they must stay deduped.
   */
  async ingestEvent(event: NostrEvent): Promise<{ buffered: boolean }> {
    // Acquire serialised lock
    const prevLock = this.lockChain;
    let releaseLock!: () => void;
    this.lockChain = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await prevLock;
      if (this.disposed) return { buffered: false };
      return await this.processEvent(event);
    } finally {
      releaseLock();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.futureBuffer = [];
    this.snapshot = null;
  }

  // -----------------------------------------------------------------------
  // Internal processing
  // -----------------------------------------------------------------------

  private async processEvent(event: NostrEvent): Promise<{ buffered: boolean }> {
    // Snapshot state before first event per epoch (if no active snapshot)
    const currentEpoch = getEpoch(this.mlsGroup.state);
    if (!this.snapshot) {
      this.takeSnapshot(currentEpoch);
    }

    const results = this.mlsGroup.ingest([event]);

    // True when this event landed in the future-epoch buffer (unreadable now).
    // Surfaced to the caller so the seen-set dedup can be relaxed for it — see
    // ingestEvent's contract.
    let buffered = false;

    for await (const result of results) {
      if (this.disposed) return { buffered };

      if (result.kind === 'processed') {
        if (result.result.kind === 'applicationMessage') {
          // Dispatch application message immediately
          const { deserializeApplicationData } = await import('@internet-privacy/marmot-ts');
          const rumor = deserializeApplicationData(
            (result.result as { kind: 'applicationMessage'; message: Uint8Array }).message,
          );
          this.callbacks.onApplicationMessage?.(rumor);

          // Add to replay queue if grace window is active
          if (this.snapshot) {
            this.snapshot.replayQueue.push(event);
          }

          // ts-mls advances the sender's per-leaf ratchet on every application
          // message. A buffered event from the same leaf may now be readable —
          // retry. Without this, an out-of-order rumor stays stuck in the
          // futureBuffer until the next commit (which may never arrive).
          if (this.futureBuffer.length > 0) {
            await this.flushFutureBuffer();
          }
        } else if (result.result.kind === 'newState') {
          // Commit detected
          await this.handleCommit(event);
        }
      } else if (result.kind === 'unreadable') {
        this.futureBuffer.push(event);
        this.capBuffer();
        buffered = true;
      } else if (result.kind === 'skipped' && result.reason === 'past-epoch') {
        // A commit for a past epoch was skipped. If we have an active snapshot
        // with a recorded commit, this might be a competing commit that was
        // lower — meaning we accepted the wrong one first.
        await this.handleSkippedPastEpoch(event);
      } else if (result.kind === 'rejected') {
        // AC-SEAM-4 / architecture.md §6 guarantee 2: terminal, never
        // bufferable. This covers 'admin-policy' (a commit rejected by the
        // admin-verification callback) and the two authenticated-sender
        // rejections ('unauthenticated-sender' | 'undeserializable') alike —
        // none of them is retried like an 'unreadable' event. The library's
        // own 'unauthenticatedMessage' diagnostic event (wired in
        // applicationRumorDispatcher.ts, AC-OBS-1) already surfaces the
        // sender-authentication drop; nothing further is done here.
      }
      // other skipped reasons: log and drop
    }

    // After processing, notify members changed
    if (!this.disposed && this.callbacks.onMembersChanged) {
      const currentMembers = getGroupMembers(this.mlsGroup.state);
      this.callbacks.onMembersChanged(currentMembers);
    }

    return { buffered };
  }

  private async handleCommit(event: NostrEvent): Promise<void> {
    // Record commit in snapshot and start/reset grace timer
    if (this.snapshot) {
      this.snapshot.commitEventId = event.id;
      this.snapshot.commitCreatedAt = event.created_at;
    }

    this.startGraceTimer();
    await this.flushFutureBuffer();
  }

  /**
   * A commit for a past epoch was skipped by marmot-ts. If we have an active
   * snapshot recording a different commit, and the skipped event is
   * deterministically lower, we need to rollback and replay with the lower one.
   */
  private async handleSkippedPastEpoch(event: NostrEvent): Promise<void> {
    if (
      !this.snapshot ||
      this.snapshot.commitEventId === '' ||
      this.snapshot.commitEventId === event.id
    ) {
      return;
    }

    const existing = {
      created_at: this.snapshot.commitCreatedAt,
      id: this.snapshot.commitEventId,
    };

    if (commitIsLower(event, existing)) {
      // Skipped event was actually lower — it should have won. Rollback.
      await this.rollbackAndReplay(event);
    }
    // If existing is lower, it correctly won. Do nothing.
  }

  private async rollbackAndReplay(winningEvent: NostrEvent): Promise<void> {
    if (!this.snapshot) return;

    // Restore state from snapshot
    const restoredState = deserializeClientState(this.snapshot.stateBytes);

    // Set state (setter marks dirty, fires stateChanged)
    this.mlsGroup.state = restoredState;

    // Build replay: winning event + queued events, minus the losing commit
    const losingCommitId = this.snapshot.commitEventId;
    const replayList = [
      winningEvent,
      ...this.snapshot.replayQueue.filter((e) => e.id !== losingCommitId),
    ];

    // Ingest replay batch
    const replayResults = this.mlsGroup.ingest(replayList);
    for await (const result of replayResults) {
      if (this.disposed) return;

      if (result.kind === 'processed' && result.result.kind === 'applicationMessage') {
        const { deserializeApplicationData } = await import('@internet-privacy/marmot-ts');
        const rumor = deserializeApplicationData(
          (result.result as { kind: 'applicationMessage'; message: Uint8Array }).message,
        );
        this.callbacks.onApplicationMessage?.(rumor);
      }
    }

    // Take fresh snapshot for the new epoch
    const newEpoch = getEpoch(this.mlsGroup.state);
    this.takeSnapshot(newEpoch);
    this.snapshot!.commitEventId = winningEvent.id;
    this.snapshot!.commitCreatedAt = winningEvent.created_at;

    this.startGraceTimer();
    await this.mlsGroup.save();
  }

  private async flushFutureBuffer(): Promise<void> {
    if (this.futureBuffer.length === 0) return;

    const toRetry = [...this.futureBuffer];
    this.futureBuffer = [];

    const results = this.mlsGroup.ingest(toRetry);
    for await (const result of results) {
      if (this.disposed) return;

      if (result.kind === 'processed') {
        if (result.result.kind === 'applicationMessage') {
          const { deserializeApplicationData } = await import('@internet-privacy/marmot-ts');
          const rumor = deserializeApplicationData(
            (result.result as { kind: 'applicationMessage'; message: Uint8Array }).message,
          );
          this.callbacks.onApplicationMessage?.(rumor);
        }
        // Processed — don't re-add to buffer
      } else if (result.kind === 'unreadable') {
        // Still unreadable — keep in buffer
        this.futureBuffer.push(result.event);
      } else if (result.kind === 'rejected') {
        // AC-SEAM-4: terminal — a retried buffered event that comes back
        // 'rejected' (admin-policy or sender-authentication) is dropped, not
        // re-added to the buffer. See processEvent's matching branch above.
      }
      // other skipped reasons: drop
    }

    this.capBuffer();
  }

  // -----------------------------------------------------------------------
  // Snapshot & timer helpers
  // -----------------------------------------------------------------------

  private takeSnapshot(epoch: number): void {
    this.snapshot = {
      epoch,
      stateBytes: serializeClientState(this.mlsGroup.state),
      commitEventId: '',
      commitCreatedAt: 0,
      takenAt: Date.now(),
      replayQueue: [],
    };
  }

  private startGraceTimer(): void {
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
    }
    this.graceTimer = setTimeout(() => {
      this.onGraceWindowExpired();
    }, this.graceWindowMs);
  }

  private onGraceWindowExpired(): void {
    if (this.disposed) return;
    this.graceTimer = null;
    this.snapshot = null;
    void this.mlsGroup.save();
  }

  private capBuffer(): void {
    if (this.futureBuffer.length > this.maxBufferSize) {
      this.futureBuffer.sort((a, b) => a.created_at - b.created_at);
      this.futureBuffer = this.futureBuffer.slice(-this.maxBufferSize);
    }
  }
}

export type { NostrEvent, EpochSnapshot, EpochResolverConfig, EpochResolverCallbacks, MlsGroupLike };
