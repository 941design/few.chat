/**
 * applicationRumorDispatcher.ts
 *
 * Single `group.on('applicationMessage')` listener with per-group LRU seen-id
 * deduplication and sequential handler dispatch.
 *
 * Boundary rules (architecture.md):
 *   - Zero React imports
 *   - Zero context imports
 *   - Zero IDB calls at subscribe time
 *   - Only console.warn (never console.error) for handler errors
 */

// Static top-level import so vi.mock() in tests can intercept deserialization.

export interface ApplicationRumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface DispatcherContext {
  groupId: string;
  selfPubkeyHex: string;
  getActiveGroupId: () => string | null;
}

export interface AuthenticatedSender {
  pubkey: string;
  authenticity: 'claimed' | 'mls';
}

export type SenderResolver = (rumor: ApplicationRumor) => AuthenticatedSender;

export interface RumorHandler<TKind extends number = number> {
  kind: TKind;
  handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender): Promise<void> | void;
}

export interface Dispatcher {
  subscribe(group: MarmotGroupLike, ctx: DispatcherContext, resolveSender?: SenderResolver): () => void;
}

import { deserializeApplicationData } from '@internet-privacy/marmot-ts';

// Minimal structural type — avoids a hard import dependency on marmot-ts types.
interface MarmotGroupLike {
  on(event: 'applicationMessage', listener: (data: Uint8Array) => void): void;
  off(event: 'applicationMessage', listener: (data: Uint8Array) => void): void;
}

/** Maximum number of seen IDs stored per group. */
const LRU_CAP = 1000;

export function createDispatcher(handlers: RumorHandler[]): Dispatcher {
  // Per-group LRU: Map<groupId, Set<rumorId>>
  // Set preserves insertion order; we evict from the front when size > LRU_CAP.
  const seenByGroup = new Map<string, Set<string>>();

  function isSeen(groupId: string, rumorId: string): boolean {
    return seenByGroup.get(groupId)?.has(rumorId) ?? false;
  }

  function markSeen(groupId: string, rumorId: string): void {
    let set = seenByGroup.get(groupId);
    if (!set) {
      set = new Set<string>();
      seenByGroup.set(groupId, set);
    }
    set.add(rumorId);
    // Evict oldest entries if the cap is exceeded.
    if (set.size > LRU_CAP) {
      const toEvict = set.size - LRU_CAP;
      const iter = set.values();
      for (let i = 0; i < toEvict; i++) {
        const entry = iter.next();
        if (!entry.done) {
          set.delete(entry.value);
        }
      }
    }
  }

  return {
    subscribe(group: MarmotGroupLike, ctx: DispatcherContext, resolveSender?: SenderResolver): () => void {
      const listener = async (data: Uint8Array): Promise<void> => {
        let rumor: ApplicationRumor;
        try {
          rumor = deserializeApplicationData(data) as ApplicationRumor;
        } catch {
          // Malformed application message — discard silently.
          return;
        }

        if (isSeen(ctx.groupId, rumor.id)) {
          return;
        }

        // Resolve the authenticated sender AFTER deserialize but STRICTLY BEFORE
        // markSeen and fan-out. A sender-mismatched rumor is dropped here and must
        // never reach markSeen — otherwise its id would poison the per-group dedup
        // LRU and a later legitimate redelivery of the same id would be silently
        // swallowed (AC-XCUT-1). Falls back to the identity resolver
        // ({ pubkey: rumor.pubkey, authenticity: 'claimed' }) when the caller
        // supplies no resolver (e.g. pre-existing tests calling subscribe(group, ctx)).
        const sender: AuthenticatedSender = resolveSender
          ? resolveSender(rumor)
          : { pubkey: rumor.pubkey, authenticity: 'claimed' };

        if (sender.pubkey !== rumor.pubkey) {
          console.warn('[dispatcher.unauthenticatedMessage]', {
            groupId: ctx.groupId,
            kind: rumor.kind,
            rumorId: rumor.id,
            claimedPubkey: rumor.pubkey,
            authenticatedPubkey: sender.pubkey,
          });
          return;
        }

        markSeen(ctx.groupId, rumor.id);

        const matching = handlers.filter((h) => h.kind === rumor.kind);
        for (const handler of matching) {
          try {
            await handler.handle(rumor, ctx, sender);
          } catch (err) {
            console.warn(`[dispatcher.${rumor.kind}]`, err);
          }
        }
      };

      group.on('applicationMessage', listener);
      return () => {
        group.off('applicationMessage', listener);
      };
    },
  };
}
