/**
 * Nostr Identity Context — Tier 1 (auto-generated local keypair) + NIP-46 remote signer support.
 *
 * On first mount (client-side only):
 * 1. Load or generate a Nostr keypair from localStorage.
 * 2. Connect NDK to default relays.
 * 3. Publish kind 0 (metadata). KeyPackages (kind 30443) are published by MarmotContext.
 *
 * Provides pubkeyHex, npub, and (optionally) a NIP-46 signer to the app.
 * When signerMode === 'nip46', reconnects the stored session on mount (AC-SIGNER-6).
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { NostrIdentity } from '@/src/types';
import { STORAGE_KEYS } from '@/src/types';
import {
  loadStoredIdentity,
  saveStoredIdentity,
  generateIdentityFromSeed,
  derivePublicKeyHex,
  pubkeyToNpub,
  type StoredNostrIdentity,
} from '@/src/lib/nostrKeys';
import { deriveIsFreshIdentity } from '@/src/lib/freshIdentity';
import { postAccountChangedIfSwitched } from '@/src/lib/crossTab';

export type SignerMode = 'local' | 'nip46' | 'nip07';

/**
 * Required NIP-46 permissions for group chat + DMs.
 * Matches AC-SIGNER-3.
 */
const REQUIRED_PERMS = [
  'sign_event:0',
  'sign_event:5',
  'sign_event:443',
  'sign_event:444',
  'sign_event:445',
  'sign_event:1059',
  'sign_event:10051',
  // CARD_SIG_KIND_V2 (contactCard.ts) — the synthetic kind the v2 pairing card
  // signs over. Required or a permission-enforcing NIP-46 bunker rejects the
  // Share contact card action (all shares are v2 pairing codes as of the
  // contact-pairing-code epic).
  'sign_event:20602',
  'sign_event:30051',
  'sign_event:30078',
  'sign_event:30443',
  'nip44_encrypt',
  'nip44_decrypt',
];

type NostrIdentityContextValue = {
  /** Whether the identity has been loaded from storage (may be null on SSR) */
  hydrated: boolean;
  /**
   * True only when loadStoredIdentity() returned null at this page load's
   * init, before the auto-generation step — i.e. this is a genuine
   * first-time visitor for this session. False whenever a stored identity
   * already existed at init, including immediately after a first-timer's
   * identity was auto-generated and the page is reloaded. Session-scoped:
   * set once during init, not re-derived mid-session. No new persistence
   * backs this signal (see app/src/lib/freshIdentity.ts).
   */
  isFreshIdentity: boolean;
  /** Hex-encoded public key */
  pubkeyHex: string | null;
  /** Npub (NIP-19 bech32 encoded public key) */
  npub: string | null;
  /** Hex private key — needed to pass to MarmotClient signer */
  privateKeyHex: string | null;
  /** 128-bit seed hex for BIP-39 mnemonic backup (null for legacy identities without seed) */
  seedHex: string | null;
  /** Whether the identity has been backed up with a seed phrase */
  backedUp: boolean;
  /** Replace identity (e.g. after seed phrase restore) */
  replaceIdentity: (identity: StoredNostrIdentity) => Promise<void>;
  /** Current signer mode — 'local' uses the stored private key; nip46/nip07 delegate signing externally */
  signerMode: SignerMode;
  /** Set the signer mode and persist to localStorage (AC-SIGNER-1) */
  setSignerMode: (mode: SignerMode) => void;
  /** Convenience: true when signerMode === 'local'; backup/restore controls should gate on this */
  isLocalMode: boolean;
  /**
   * True when the active signer is ready to sign events.
   * For 'local' mode this is always true after hydration.
   * For 'nip46' mode this becomes true after a successful blockUntilReady().
   */
  signerAvailable: boolean;
  /** Non-null when the NIP-46 signer has failed (e.g. bunker unreachable). */
  signerError: string | null;
  /** True while reconnecting a stored NIP-46 session on mount. */
  signerReconnecting: boolean;
  /**
   * Step 1 of the nostrconnect flow: creates a pending NIP-46 signer and returns
   * the nostrconnect:// URI for QR display. Call confirmNostrConnect() once the
   * user approves in their signer app.
   */
  initNostrConnect: (relay: string) => Promise<{ connectUri: string }>;
  /**
   * Step 2 of the nostrconnect flow: blocks until the remote signer approves
   * (15 s timeout). On success, activates the signer and persists the session.
   */
  confirmNostrConnect: () => Promise<void>;
  /**
   * Connect via bunker:// URI (paste flow). Opens an auth_url tab if needed.
   */
  connectBunkerUri: (uri: string) => Promise<void>;
  /**
   * Disconnect the active NIP-46 signer and return to local mode.
   * Never leaves the user without a signer (AC-SIGNER-8).
   */
  disconnectBunker: () => void;
  /**
   * Connect via a NIP-07 browser extension. Checks for window.nostr and
   * window.nostr.nip44 presence before proceeding (AC-NIP07-1).
   * Throws with a user-readable message if the extension is absent or
   * does not support NIP-44.
   */
  connectNip07: () => Promise<void>;
  /**
   * Disconnect the active NIP-07 signer and return to local mode.
   */
  disconnectNip07: () => void;
};

const NostrIdentityContext = createContext<NostrIdentityContextValue | null>(null);

/** Timeout (ms) for a NIP-46 blockUntilReady() call (AC-SIGNER-7). */
const BUNKER_TIMEOUT_MS = 15_000;

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function NostrIdentityProvider({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [identity, setIdentity] = useState<StoredNostrIdentity | null>(null);
  const [isFreshIdentity, setIsFreshIdentity] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  const [signerMode, setSignerModeState] = useState<SignerMode>('local');
  const [signerAvailable, setSignerAvailable] = useState(true);
  const [signerError, setSignerError] = useState<string | null>(null);
  const [signerReconnecting, setSignerReconnecting] = useState(false);

  // Module-level ref for the active NIP-46 signer — not React state (no re-render needed).
  // Populated by initNostrConnect/connectBunkerUri and used by confirmNostrConnect.
  const pendingNip46SignerRef = useRef<import('@nostr-dev-kit/ndk').NDKNip46Signer | null>(null);

  // Initialize identity on client
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Check backed-up status
      const isBackedUp =
        typeof localStorage !== 'undefined' &&
        localStorage.getItem(STORAGE_KEYS.nostrBackedUp) === 'true';

      setBackedUp(isBackedUp);

      // Load persisted signer mode (default: 'local')
      const storedMode = typeof localStorage !== 'undefined'
        ? (localStorage.getItem(STORAGE_KEYS.signerMode) as SignerMode | null)
        : null;
      const validModes: SignerMode[] = ['local', 'nip46', 'nip07'];
      let effectiveMode: SignerMode = 'local';
      if (storedMode && validModes.includes(storedMode)) {
        effectiveMode = storedMode;
        setSignerModeState(storedMode);
      }

      // Load or generate identity
      let stored = loadStoredIdentity();

      // AC-DETECT-1/2: capture the pre-auto-generation snapshot. This is the
      // sole call site of deriveIsFreshIdentity — the auto-generation branch
      // below never runs before this line, so both branches (fresh vs.
      // returning) go through the same derivation, not divergent code paths.
      const freshAtInit = deriveIsFreshIdentity(stored);

      if (!stored) {
        // First launch: generate keypair from 128-bit seed
        const { seedHex, privateKeyHex } = await generateIdentityFromSeed();
        const pubkeyHex = await derivePublicKeyHex(privateKeyHex);
        stored = { privateKeyHex, pubkeyHex, seedHex };
        saveStoredIdentity(stored);
      }

      if (cancelled) return;
      setIdentity(stored);
      setIsFreshIdentity(freshAtInit);
      setHydrated(true);

      // AC-NIP07: If previously in nip07 mode, re-connect the extension silently on mount.
      if (effectiveMode === 'nip07') {
        try {
          // Extensions auto-approve on reconnect when previously trusted.
          // connectNip07 is defined later; call via module function to avoid closure issues.
          // We inline the reconnect logic here to avoid a forward-reference problem.
          if (typeof window !== 'undefined' && window.nostr && window.nostr.nip44) {
            const { NDKNip07Signer } = await import('@nostr-dev-kit/ndk');
            const nip07 = new NDKNip07Signer();
            await nip07.blockUntilReady();
            if (cancelled) return;
            await _activateNip07Signer(nip07, stored);
          } else {
            // Extension gone or missing NIP-44 — degrade gracefully
            if (!cancelled) {
              setSignerError('nip07_unavailable');
              setSignerAvailable(false);
            }
          }
        } catch {
          if (!cancelled) {
            setSignerError('nip07_unavailable');
            setSignerAvailable(false);
          }
        }
      }

      // AC-SIGNER-6: If previously in nip46 mode, restore session on mount.
      if (effectiveMode === 'nip46') {
        const sessionPayload = typeof localStorage !== 'undefined'
          ? localStorage.getItem(STORAGE_KEYS.nip46Session)
          : null;

        if (sessionPayload) {
          setSignerReconnecting(true);
          setSignerAvailable(false);
          try {
            const { connectNdk } = await import('@/src/lib/ndkClient');
            const ndk = await connectNdk(stored.privateKeyHex);
            const { NDKNip46Signer } = await import('@nostr-dev-kit/ndk');
            const restoredSigner = await NDKNip46Signer.fromPayload(sessionPayload, ndk);

            // Wire auth_url handler before blockUntilReady
            restoredSigner.on('authUrl', (url: string) => {
              if (typeof window !== 'undefined') window.open(url, '_blank');
            });

            await raceWithTimeout(restoredSigner.blockUntilReady(), BUNKER_TIMEOUT_MS);

            if (cancelled) return;
            await _activateNip46Signer(restoredSigner, null, stored);
            setSignerAvailable(true);
            setSignerError(null);
          } catch {
            if (!cancelled) {
              setSignerError('bunker_unreachable');
              setSignerAvailable(false);
            }
          } finally {
            if (!cancelled) setSignerReconnecting(false);
          }
        } else {
          // No session payload — revert to local (shouldn't happen normally)
          _clearNip46Mode();
        }
      }

      // Privacy invariant: the user's profile (kind-0 metadata) is NEVER
      // broadcast to public relays. Profile data is exchanged only over
      // addressed, encrypted channels (MLS group rumors, NIP-59 gift wraps,
      // out-of-band contact cards). See CLAUDE.md "Privacy invariant".
      // KeyPackages (MLS crypto key material, no personal data) are published
      // separately in MarmotContext.
    }

    void init();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Internal: revert signer mode to local and clean up NIP-46 state. */
  function _clearNip46Mode() {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEYS.nip46Session);
      localStorage.setItem(STORAGE_KEYS.signerMode, 'local');
    }
    setSignerModeState('local');
    setSignerAvailable(true);
    setSignerError(null);
    pendingNip46SignerRef.current = null;
    // Clear the global EventSigner override so MarmotContext reverts to local
    import('@/src/lib/marmot/signerAdapter').then(({ activeEventSignerOverride }) => {
      activeEventSignerOverride.current = null;
    }).catch(() => {});
  }

  /**
   * Internal: activate a successfully connected NIP-46 signer.
   * Sets signerMode to 'nip46', persists the session, applies the signer
   * to NDK and to the global EventSigner override (for MarmotContext).
   *
   * If reportedPubkey differs from the local identity's pubkeyHex, the user
   * is switching identities. We accept this (no hard block in this epic slice)
   * but log a warning. The backup gate (AC-SIGNER-4b) is enforced by the
   * settings UI before calling connect functions.
   */
  async function _activateNip46Signer(
    signer: import('@nostr-dev-kit/ndk').NDKNip46Signer,
    reportedPubkey: string | null,
    currentIdentity: StoredNostrIdentity | null,
  ): Promise<void> {
    if (reportedPubkey && currentIdentity && reportedPubkey !== currentIdentity.pubkeyHex) {
      console.warn('[NostrIdentity] NIP-46 pubkey differs from local identity.', {
        local: currentIdentity.pubkeyHex,
        bunker: reportedPubkey,
      });
    }

    // Apply to NDK singleton
    const { applyNdkSigner } = await import('@/src/lib/ndkClient');
    applyNdkSigner(signer);

    // Build the EventSigner adapter and set the global override
    const { createNip46EventSigner, activeEventSignerOverride } = await import('@/src/lib/marmot/signerAdapter');
    const eventSigner = createNip46EventSigner(signer);
    activeEventSignerOverride.current = eventSigner;

    // Persist session payload (no private key stored — AC-SIGNER-5)
    const payload = signer.toPayload();
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.nip46Session, payload);
      // Remove the raw private key from localStorage (AC-SIGNER-5)
      // Only do this if the bunker is for the same identity (safe guard)
      if (!reportedPubkey || !currentIdentity || reportedPubkey === currentIdentity.pubkeyHex) {
        localStorage.removeItem(STORAGE_KEYS.nostrIdentity);
      }
    }

    pendingNip46SignerRef.current = signer;
    setSignerModeState('nip46');
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.signerMode, 'nip46');
    }
    setSignerAvailable(true);
    setSignerError(null);
  }

  /**
   * Internal: activate a successfully connected NIP-07 signer.
   * Sets signerMode to 'nip07', applies the signer to NDK and the global
   * EventSigner override (for MarmotContext).
   *
   * Unlike NIP-46, there is no session payload to persist — the extension
   * is always present on the device. signerMode='nip07' in localStorage is
   * sufficient to trigger auto-reconnect on the next mount.
   */
  async function _activateNip07Signer(
    signer: import('@nostr-dev-kit/ndk').NDKNip07Signer,
    currentIdentity: StoredNostrIdentity | null,
  ): Promise<void> {
    // .pubkey getter is available synchronously after blockUntilReady() has been called (done by the caller)
    const reportedPubkey = signer.pubkey;
    if (currentIdentity && reportedPubkey !== currentIdentity.pubkeyHex) {
      console.warn('[NostrIdentity] NIP-07 pubkey differs from local identity.', {
        local: currentIdentity.pubkeyHex,
        extension: reportedPubkey,
      });
    }

    // Apply to NDK singleton
    const { applyNdkSigner } = await import('@/src/lib/ndkClient');
    applyNdkSigner(signer);

    // Build the EventSigner adapter and set the global override
    const { createNip07EventSigner, activeEventSignerOverride } = await import('@/src/lib/marmot/signerAdapter');
    const eventSigner = createNip07EventSigner(signer);
    activeEventSignerOverride.current = eventSigner;

    setSignerModeState('nip07');
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.signerMode, 'nip07');
    }
    setSignerAvailable(true);
    setSignerError(null);
  }

  /** Internal: revert signer mode to local and clean up NIP-07 state. */
  function _clearNip07Mode() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.signerMode, 'local');
    }
    setSignerModeState('local');
    setSignerAvailable(true);
    setSignerError(null);
    // Clear the global EventSigner override so MarmotContext reverts to local
    import('@/src/lib/marmot/signerAdapter').then(({ activeEventSignerOverride }) => {
      activeEventSignerOverride.current = null;
    }).catch(() => {});
  }

  const replaceIdentity = useCallback(async (newIdentity: StoredNostrIdentity) => {
    const previousPubkey = loadStoredIdentity()?.pubkeyHex;
    saveStoredIdentity(newIdentity);
    // Other tabs still run as the previous identity: tell them to reload (only
    // when the pubkey really changed), now that the new one is persisted.
    postAccountChangedIfSwitched(previousPubkey, newIdentity.pubkeyHex);
    // Rebind the global NDK signer immediately so any in-flight or follow-up
    // relay traffic uses the new private key, not the previous identity's.
    if (typeof window !== 'undefined') {
      const { getNdk } = await import('@/src/lib/ndkClient');
      getNdk(newIdentity.privateKeyHex);
    }
    setIdentity(newIdentity);
    // Privacy invariant: no kind-0 profile broadcast on restore (see CLAUDE.md).
  }, []);

  const setSignerMode = useCallback((mode: SignerMode) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.signerMode, mode);
    }
    setSignerModeState(mode);
  }, []);

  /**
   * Step 1 of nostrconnect flow: create pending NIP-46 signer, return URI.
   * Returns a nostrconnect:// URI that the UI should show as a QR code.
   */
  const initNostrConnect = useCallback(async (relay: string): Promise<{ connectUri: string }> => {
    if (typeof window === 'undefined') return { connectUri: '' };

    try {
      const { connectNdk, getNdkInstance } = await import('@/src/lib/ndkClient');
      const { NDKNip46Signer, NDKPrivateKeySigner } = await import('@nostr-dev-kit/ndk');

      let ndk = getNdkInstance();
      if (!ndk) {
        // NDK may not be connected yet — use the stored identity's key to connect.
        const stored = loadStoredIdentity();
        if (stored) {
          ndk = await connectNdk(stored.privateKeyHex);
        }
      }
      if (!ndk) return { connectUri: '' };

      // Generate an ephemeral local signer for the nostrconnect flow
      const ephemeralSigner = NDKPrivateKeySigner.generate();
      await ephemeralSigner.blockUntilReady();

      const nip46 = NDKNip46Signer.nostrconnect(ndk, relay, ephemeralSigner, {
        name: 'Few',
        url: 'https://few.chat',
        perms: REQUIRED_PERMS.join(','),
      });

      // Wire auth_url handler
      nip46.on('authUrl', (url: string) => {
        if (typeof window !== 'undefined') window.open(url, '_blank');
      });

      pendingNip46SignerRef.current = nip46;
      return { connectUri: nip46.nostrConnectUri ?? '' };
    } catch (err) {
      console.warn('[NostrIdentity] initNostrConnect failed:', err);
      return { connectUri: '' };
    }
  }, []);

  /**
   * Step 2 of nostrconnect flow: block until remote signer approves (15 s timeout).
   */
  const confirmNostrConnect = useCallback(async (): Promise<void> => {
    const signer = pendingNip46SignerRef.current;
    if (!signer) throw new Error('No pending nostrconnect signer');

    setSignerReconnecting(true);
    setSignerAvailable(false);
    try {
      const user = await raceWithTimeout(signer.blockUntilReadyNostrConnect(), BUNKER_TIMEOUT_MS);
      await _activateNip46Signer(signer, user.pubkey, identity);
    } catch (err) {
      const msg = err instanceof Error && err.message === 'timeout'
        ? 'bunker_unreachable'
        : 'connection_failed';
      setSignerError(msg);
      setSignerAvailable(false);
      throw err;
    } finally {
      setSignerReconnecting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  /**
   * Connect via a bunker:// URI (paste flow).
   */
  const connectBunkerUri = useCallback(async (uri: string): Promise<void> => {
    if (typeof window === 'undefined') return;

    setSignerReconnecting(true);
    setSignerAvailable(false);
    setSignerError(null);
    try {
      const { connectNdk, getNdkInstance } = await import('@/src/lib/ndkClient');
      const { NDKNip46Signer } = await import('@nostr-dev-kit/ndk');

      let ndk = getNdkInstance();
      if (!ndk) {
        const stored = loadStoredIdentity();
        if (stored) ndk = await connectNdk(stored.privateKeyHex);
      }
      if (!ndk) throw new Error('NDK not available');

      const signer = NDKNip46Signer.bunker(ndk, uri);

      // Wire auth_url handler before blockUntilReady
      signer.on('authUrl', (url: string) => {
        if (typeof window !== 'undefined') window.open(url, '_blank');
      });

      pendingNip46SignerRef.current = signer;
      const user = await raceWithTimeout(signer.blockUntilReady(), BUNKER_TIMEOUT_MS);
      await _activateNip46Signer(signer, user.pubkey, identity);
    } catch (err) {
      const msg = err instanceof Error && err.message === 'timeout'
        ? 'bunker_unreachable'
        : 'connection_failed';
      setSignerError(msg);
      setSignerAvailable(false);
      throw err;
    } finally {
      setSignerReconnecting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  /**
   * Disconnect the NIP-46 signer and return to local mode (AC-SIGNER-8).
   * Never leaves the user without a signer.
   */
  const disconnectBunker = useCallback(() => {
    // Stop the active NIP-46 signer if any
    pendingNip46SignerRef.current?.stop?.();
    pendingNip46SignerRef.current = null;

    // Restore local NDK signer
    const stored = loadStoredIdentity();
    if (stored) {
      import('@/src/lib/ndkClient').then(({ getNdk }) => {
        getNdk(stored.privateKeyHex);
      }).catch(() => {});
    } else {
      // No local identity: generate one
      void generateIdentityFromSeed().then(async ({ seedHex, privateKeyHex }) => {
        const pubkeyHex = await derivePublicKeyHex(privateKeyHex);
        const newId = { privateKeyHex, pubkeyHex, seedHex };
        saveStoredIdentity(newId);
        setIdentity(newId);
        import('@/src/lib/ndkClient').then(({ getNdk }) => {
          getNdk(privateKeyHex);
        }).catch(() => {});
      }).catch(() => {});
    }

    // Clear global EventSigner override
    import('@/src/lib/marmot/signerAdapter').then(({ activeEventSignerOverride }) => {
      activeEventSignerOverride.current = null;
    }).catch(() => {});

    _clearNip46Mode();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Connect via a NIP-07 browser extension (AC-OTHER-2, AC-NIP07-1, AC-NIP07-2).
   * Guards:
   *   - window.nostr absent → throws "No browser extension found"
   *   - window.nostr.nip44 absent → throws NIP-44 missing error (AC-NIP07-1)
   * On success: wraps NDKNip07Signer in the EventSigner adapter and activates it.
   */
  const connectNip07 = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.nostr) {
      throw new Error('No browser extension found');
    }
    if (!window.nostr.nip44) {
      throw new Error('Extension does not support NIP-44 encryption. Use Alby or nos2x-fox.');
    }

    setSignerReconnecting(true);
    setSignerAvailable(false);
    setSignerError(null);
    try {
      const { NDKNip07Signer } = await import('@nostr-dev-kit/ndk');
      const nip07 = new NDKNip07Signer();
      await nip07.blockUntilReady();
      await _activateNip07Signer(nip07, identity);
    } catch (err) {
      setSignerError('nip07_unavailable');
      setSignerAvailable(false);
      throw err;
    } finally {
      setSignerReconnecting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  /**
   * Disconnect the NIP-07 signer and return to local mode.
   * Mirrors disconnectBunker but without any session payload to delete.
   */
  const disconnectNip07 = useCallback(() => {
    // Restore local NDK signer
    const stored = loadStoredIdentity();
    if (stored) {
      import('@/src/lib/ndkClient').then(({ getNdk }) => {
        getNdk(stored.privateKeyHex);
      }).catch(() => {});
    } else {
      void generateIdentityFromSeed().then(async ({ seedHex, privateKeyHex }) => {
        const pubkeyHex = await derivePublicKeyHex(privateKeyHex);
        const newId = { privateKeyHex, pubkeyHex, seedHex };
        saveStoredIdentity(newId);
        setIdentity(newId);
        import('@/src/lib/ndkClient').then(({ getNdk }) => {
          getNdk(privateKeyHex);
        }).catch(() => {});
      }).catch(() => {});
    }

    _clearNip07Mode();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<NostrIdentityContextValue>(
    () => ({
      hydrated,
      isFreshIdentity,
      pubkeyHex: identity?.pubkeyHex ?? null,
      npub: identity ? pubkeyToNpub(identity.pubkeyHex) : null,
      privateKeyHex: identity?.privateKeyHex ?? null,
      seedHex: identity?.seedHex ?? null,
      backedUp,
      replaceIdentity,
      signerMode,
      setSignerMode,
      isLocalMode: signerMode === 'local',
      signerAvailable,
      signerError,
      signerReconnecting,
      initNostrConnect,
      confirmNostrConnect,
      connectBunkerUri,
      disconnectBunker,
      connectNip07,
      disconnectNip07,
    }),
    [
      hydrated,
      isFreshIdentity,
      identity,
      backedUp,
      replaceIdentity,
      signerMode,
      setSignerMode,
      signerAvailable,
      signerError,
      signerReconnecting,
      initNostrConnect,
      confirmNostrConnect,
      connectBunkerUri,
      disconnectBunker,
      connectNip07,
      disconnectNip07,
    ]
  );

  return (
    <NostrIdentityContext.Provider value={value}>
      {children}
    </NostrIdentityContext.Provider>
  );
}

const NOOP_REPLACE: NostrIdentityContextValue['replaceIdentity'] = async () => {};
const NOOP_SET_SIGNER_MODE: NostrIdentityContextValue['setSignerMode'] = () => {};
const NOOP_INIT_NOSTR_CONNECT: NostrIdentityContextValue['initNostrConnect'] = async () => ({ connectUri: '' });
const NOOP_CONFIRM_NOSTR_CONNECT: NostrIdentityContextValue['confirmNostrConnect'] = async () => {};
const NOOP_CONNECT_BUNKER_URI: NostrIdentityContextValue['connectBunkerUri'] = async () => {};
const NOOP_DISCONNECT_BUNKER: NostrIdentityContextValue['disconnectBunker'] = () => {};
const NOOP_CONNECT_NIP07: NostrIdentityContextValue['connectNip07'] = async () => {};
const NOOP_DISCONNECT_NIP07: NostrIdentityContextValue['disconnectNip07'] = () => {};

const DEFAULT_CONTEXT: NostrIdentityContextValue = {
  hydrated: false,
  isFreshIdentity: false,
  pubkeyHex: null,
  npub: null,
  privateKeyHex: null,
  seedHex: null,
  backedUp: false,
  replaceIdentity: NOOP_REPLACE,
  signerMode: 'local',
  setSignerMode: NOOP_SET_SIGNER_MODE,
  isLocalMode: true,
  signerAvailable: true,
  signerError: null,
  signerReconnecting: false,
  initNostrConnect: NOOP_INIT_NOSTR_CONNECT,
  confirmNostrConnect: NOOP_CONFIRM_NOSTR_CONNECT,
  connectBunkerUri: NOOP_CONNECT_BUNKER_URI,
  disconnectBunker: NOOP_DISCONNECT_BUNKER,
  connectNip07: NOOP_CONNECT_NIP07,
  disconnectNip07: NOOP_DISCONNECT_NIP07,
};

export function useNostrIdentity(): NostrIdentityContextValue {
  const context = useContext(NostrIdentityContext);
  // Return safe defaults when called outside provider (e.g., during dynamic load)
  return context ?? DEFAULT_CONTEXT;
}
