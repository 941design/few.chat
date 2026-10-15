/**
 * IncomingCallWatcher.tsx — Null-rendering global call-signaling subscriber (Story S2, updated S5).
 *
 * Mounts in Layout.tsx alongside DirectMessageNotificationsWatcher.
 * Subscribes to kind-21059 gift wraps via callSignaling.ts and routes ALL
 * signaling kinds (25050–25055) through a singleton CallManager instance.
 *
 * Pattern follows DirectMessageNotificationsWatcher.tsx exactly:
 *   - Gated on `hydrated + pubkeyHex + privateKeyHex`.
 *   - Dynamic imports for SSR safety.
 *   - Cleanup: `cancelled = true` + `unsubscribe?.()` + `manager.destroy()`.
 *   - `groupsRef` kept live without rebuilding the subscription on group changes.
 *
 * Module-level singleton: `getCallManager()` lets S8's start-call UI initiate
 * outgoing calls without creating a duplicate subscription.
 */

import { useEffect, useRef } from 'react';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { isAllowedDmSender } from '@/src/lib/walledGarden';
import { loadKnownPeers } from '@/src/lib/knownPeers';
import { isBlockedPeer, loadBlockedPeers } from '@/src/lib/blockedPeers';
import type { Group } from '@/src/types';
import type { CallManager } from '@/src/lib/calls/callManager';

// ── Module-level singleton ────────────────────────────────────────────────────

/**
 * The active CallManager instance. Set when the watcher mounts (identity hydrated)
 * and cleared when it unmounts.
 *
 * S8 (start-call UI) calls getCallManager() to initiate outgoing calls.
 */
let activeCallManager: CallManager | null = null;

/**
 * Returns the current active CallManager, or null if the watcher has not yet
 * hydrated (identity not available) or has unmounted.
 */
export function getCallManager(): CallManager | null {
  return activeCallManager;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function IncomingCallWatcher() {
  const { hydrated, pubkeyHex, privateKeyHex } = useNostrIdentity();
  const { groups, getClient, knownPeersRevision, blockedPeersRevision } = useMarmot();

  // Live ref keeps the group roster current without tearing down the subscription
  // on every membership change. Mirrors the pattern in ContactChat.tsx / DMNotificationsWatcher.
  const groupsRef = useRef<Group[]>(groups);
  useEffect(() => { groupsRef.current = groups; }, [groups]);

  // Ever-known peers ref — refreshed whenever groups change (MarmotContext's
  // maintenance effect may have updated lp_knownPeers_v1) OR when knownPeersRevision
  // bumps (an out-of-band write, e.g. manual add-contact-by-npub, that doesn't
  // correlate with a groups change). Mirrors DirectMessageNotificationsWatcher so
  // call authorization uses the same walled-garden whitelist as DMs, which is what
  // makes the spec §5.3 1:1 fallback (calls from a known contact with no shared MLS
  // group) reachable.
  const knownPeersRef = useRef(loadKnownPeers());
  useEffect(() => { knownPeersRef.current = loadKnownPeers(); }, [groups, knownPeersRevision]);

  // Block-set ref (mirrors DirectMessageNotificationsWatcher): refreshed on the
  // same triggers plus blockedPeersRevision, so a block made while mounted takes
  // effect on the next offer without a subscription rebuild. Feeds CallManager's
  // isBlockedCaller, which denies DIRECT 1:1 calls only (group calls: owner Q8).
  const blockedPeersRef = useRef(loadBlockedPeers());
  useEffect(() => {
    blockedPeersRef.current = loadBlockedPeers();
  }, [groups, knownPeersRevision, blockedPeersRevision]);

  // getClient is stable (useCallback) — safe to read directly in the effect.
  const getClientRef = useRef(getClient);
  useEffect(() => { getClientRef.current = getClient; }, [getClient]);

  useEffect(() => {
    if (!hydrated || !pubkeyHex || !privateKeyHex) return;
    if (typeof window === 'undefined') return;

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let manager: CallManager | null = null;

    void (async () => {
      try {
        const ndkModule = await import('@/src/lib/ndkClient');
        const signalingModule = await import('@/src/lib/calls/callSignaling');
        const managerModule = await import('@/src/lib/calls/callManager');
        const signerModule = await import('@/src/lib/marmot/signerAdapter');

        // Await the relay connection here rather than assuming another watcher
        // (e.g. the DM notifications watcher) has already connected NDK. Without
        // this, the call-signaling subscription is race-dependent: if it mounts
        // first, the gift-wrap filter is registered before any relay socket is
        // open and early offers can be missed.
        const ndk = await ndkModule.connectNdk(privateKeyHex);
        if (cancelled || !ndk) return;

        // Build an EventSigner from the local private key (or use the NIP-46/07 override)
        const signer =
          signerModule.activeEventSignerOverride.current ??
          signerModule.createPrivateKeySigner(privateKeyHex);

        manager = new managerModule.CallManager({
          pubkeyHex,
          privateKeyHex,
          signer,
          ndk,
          getGroupRoster: async (groupId: string) => {
            try {
              const { getGroupMembers } = await import('@internet-privacy/marmot-ts');
              const client = getClientRef.current();
              if (!client) return [];
              const mlsGroup = await client.groups.get(groupId);
              if (!mlsGroup) return [];
              return getGroupMembers(mlsGroup.state);
            } catch {
              return [];
            }
          },
          // Live list of the user's group ids so CallManager can bind an incoming
          // call to the actual MLS group it belongs to (strict roster authorization).
          getGroupIds: () => groupsRef.current.map((g) => g.id),
          isBlockedCaller: (pk: string) => isBlockedPeer(pk, blockedPeersRef.current),
          publishGroupNotice: async (groupId: string, content: string) => {
            try {
              const client = getClientRef.current();
              if (!client) return;
              const mlsGroup = await client.groups.get(groupId);
              if (!mlsGroup) return;
              const { getEventHash } = await import('applesauce-core/helpers/event');
              // Build a properly-hashed kind-9 rumor (same pattern as MarmotContext.buildRumor)
              const rumor = { id: '', kind: 9, pubkey: pubkeyHex, created_at: Math.floor(Date.now() / 1000), content, tags: [] as string[][] };
              rumor.id = getEventHash(rumor);
              await (mlsGroup.sendApplicationRumor as unknown as (r: typeof rumor) => Promise<void>)(rumor);
            } catch (err) {
              console.warn('[IncomingCallWatcher] publishGroupNotice failed', err);
            }
          },
        });

        activeCallManager = manager;

        unsubscribe = signalingModule.subscribeCallSignaling({
          ndk,
          pubkeyHex,
          privateKeyHex,
          isAuthorized: async (senderPubkey: string, _callId: string) => {
            // Outer authorization gate (same walled-garden whitelist as DMs):
            // the sender must be a known contact — a member of one of the user's
            // MLS groups OR an ever-known peer. This admits the spec §5.3 1:1
            // fallback (a call from a known contact with no shared group), which
            // the previous group-only gate silently rejected. Fine-grained
            // per-call roster binding still happens inside CallManager.handleEvent
            // (group calls bind to the live MLS roster; direct calls authorize on
            // the caller pubkey alone).
            // The block deny-list is NOT composed here: a block keeps the peer in
            // knownPeers (spec §9 / ADR-005), and whether a call is direct or group
            // is only known once CallManager binds it to a roster. CallManager's
            // isBlockedCaller (wired above) denies blocked callers on DIRECT 1:1
            // calls; group calls from a blocked member are out of scope (owner Q8).
            return isAllowedDmSender(
              senderPubkey,
              groupsRef.current,
              knownPeersRef.current,
              pubkeyHex,
            );
          },
          onEvent: (evt) => {
            if (cancelled || !manager) return;
            void manager.handleEvent(evt);
          },
        });
      } catch (err) {
        console.warn('[IncomingCallWatcher] subscribe failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (manager) {
        manager.destroy();
        if (activeCallManager === manager) {
          activeCallManager = null;
        }
      }
    };
  }, [hydrated, pubkeyHex, privateKeyHex]); // groups intentionally omitted — live ref handles updates

  return null;
}
