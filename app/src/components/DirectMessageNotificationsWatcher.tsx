import { useEffect, useRef } from 'react';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { initDirectMessageCounts, initPendingContactCounts } from '@/src/lib/unreadStore';
import { readStoredContacts } from '@/src/lib/contacts';
import type { StoredContact } from '@/src/lib/contacts';
import { useMarmot } from '@/src/context/MarmotContext';
import { isAllowedDmSenderComposite, loadBlockedPeers } from '@/src/lib/blockedPeers';
import { loadKnownPeers } from '@/src/lib/knownPeers';

/**
 * Builds the peer list the startup batch scan (`initDirectMessageCounts`)
 * reconciles unread counts for — every stored contact except the local user.
 *
 * Pending contacts are NOT filtered here. `initDirectMessageCounts` drops
 * them itself, at the entrypoint that owns the `directMessages` slice, so the
 * bell cannot light for an unconfirmed pairing regardless of what any caller
 * passes in. Do not re-add the filter here: duplicating it would re-derive the
 * pending predicate at a call site, which the epic's architecture forbids.
 *
 * Exported as a pure function so it can be unit tested directly (this repo's
 * no-jsdom/no-renderHook convention).
 */
export function buildInitDirectMessagePeerList(
  storedContacts: Record<string, StoredContact>,
  ownPubkeyHex: string,
): string[] {
  return Object.keys(storedContacts)
    .filter((pk) => pk.toLowerCase() !== ownPubkeyHex.toLowerCase());
}

export default function DirectMessageNotificationsWatcher() {
  const { hydrated, pubkeyHex, privateKeyHex } = useNostrIdentity();
  const { groups, knownPeersRevision, blockedPeersRevision } = useMarmot();

  // Live ref keeps the gate current without recreating the subscription on
  // every group membership change. Pattern matches ContactChat.tsx groupsRef.
  const groupsRef = useRef(groups);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  // Ever-known peers ref — refreshed whenever groups change (when MarmotContext's
  // maintenance effect may have updated lp_knownPeers_v1) OR when
  // knownPeersRevision bumps (an out-of-band write, e.g. manual add-contact-by-npub,
  // that doesn't correlate with a groups change).
  const knownPeersRef = useRef(loadKnownPeers());
  useEffect(() => { knownPeersRef.current = loadKnownPeers(); }, [groups, knownPeersRevision]);
  // Block-set ref (epic: block-contact, S2) — refreshed whenever groups/knownPeers
  // would refresh (the same out-of-band triggers) OR when blockedPeersRevision
  // bumps (an archiveContact/unarchiveContact call, S1's dedicated counter — kept
  // separate from knownPeersRevision per MarmotContext's own doc). A peer blocked
  // while this watcher is already mounted is picked up on the very next inbound
  // event via this ref, with NO subscription teardown/rebuild (AC-INBOUND-3).
  const blockedPeersRef = useRef(loadBlockedPeers());
  useEffect(() => {
    blockedPeersRef.current = loadBlockedPeers();
  }, [groups, knownPeersRevision, blockedPeersRevision]);

  useEffect(() => {
    if (!hydrated || !pubkeyHex || !privateKeyHex) return;
    if (typeof window === 'undefined') return;
    if (!globalThis.isSecureContext) return;

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const ownPubkey = pubkeyHex;

    void (async () => {
      try {
        const peerPubkeys = buildInitDirectMessagePeerList(readStoredContacts(), ownPubkey);
        await initDirectMessageCounts(peerPubkeys, ownPubkey);
        // Initialise the pending-contact bell from persisted contact state so a
        // pending contact carried over from a previous session appears without a
        // new event (epic: pending-contact-notification, AC-LIFE-2). Derives its
        // own key list from readStoredContacts(), so no peer list is passed.
        await initPendingContactCounts();

        const { connectNdk } = await import('@/src/lib/ndkClient');
        const ndk = await connectNdk(privateKeyHex);
        if (cancelled) return;

        const { subscribeDirectMessageNotifications } = await import(
          '@/src/lib/directMessageNotifications'
        );
        // groupsRef.current is always up-to-date: the separate effect above
        // keeps it in sync with the latest groups array without triggering a
        // subscription teardown/rebuild on every membership change. Same
        // pattern for blockedPeersRef (epic: block-contact, S2) — the composite
        // gate re-reads the live ref on every inbound event.
        unsubscribe = subscribeDirectMessageNotifications({
          ndk,
          ownPubkeyHex: ownPubkey,
          privateKeyHex,
          isAllowedSender: (peer) => isAllowedDmSenderComposite(
            peer,
            groupsRef.current,
            knownPeersRef.current,
            blockedPeersRef.current,
            ownPubkey,
          ),
        });
      } catch (err) {
        console.warn('[DMNotifications] subscribe failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [hydrated, pubkeyHex, privateKeyHex]); // groups intentionally omitted — live ref handles updates

  return null;
}
