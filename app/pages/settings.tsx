import React, { useCallback, useEffect, useRef, useState } from 'react';
import NextLink from 'next/link';
import {
  Box,
  Collapse,
  Heading,
  Text,
  VStack,
  HStack,
  SimpleGrid,
  Button,
  Alert,
  AlertIcon,
  AlertDescription,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
  Checkbox,
  Textarea,
  Input,
  Badge,
  Spinner,
  Image,
  useDisclosure,
  useToast,
  Code,
  FormControl,
  FormLabel,
  Switch,
} from '@chakra-ui/react';
import Head from 'next/head';
import { useCopy, useLanguage } from '@/src/context/LanguageContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useAppTheme } from '@/src/hooks/useMoodTheme';
import { listThemes } from '@/src/lib/theme';
import type { AppThemeName } from '@/src/lib/theme';
import { DYNAMIC_GENERATORS } from '@/src/themes/treatments/dynamicVisuals';
import NpubQrButton from '@/src/components/groups/NpubQrButton';
import NpubQrModal from '@/src/components/groups/NpubQrModal';
import { truncateNpub, derivePublicKeyHex } from '@/src/lib/nostrKeys';
import { useProfile } from '@/src/context/ProfileContext';
import { STORAGE_KEYS, DEFAULT_RELAYS, type LanguageCode } from '@/src/types';
import { MAINTAINER_ACTIVE_PUBKEY_HEX } from '@/src/config/maintainer';
import { CALLS_ENABLED } from '@/src/config/features';
import { getEffectiveRelays, saveRelays, isValidRelayUrl } from '@/src/lib/relay';
import { applyRelayChangesToPool, getNdk } from '@/src/lib/ndkClient';
import { useMarmot } from '@/src/context/MarmotContext';
import { NDKRelayStatus } from '@nostr-dev-kit/ndk';
import { resetAllData } from '@/src/lib/storage';
import type { BackupLookup } from '@/src/lib/backup/relayBackup';
import {
  getStoredTurnServer,
  setTurnServer,
  setIpPrivacyMode,
  getIpPrivacyMode,
} from '@/src/lib/calls/turnConfig';

/** Sanitize a relay URL into a safe testid fragment */
function relayTestId(url: string): string {
  return url.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolves a theme manifest's `{ en; de? }` localized-text field for the
 * current language, falling back to `en` when `de` is absent (AC-UX-3 /
 * spec.md Implementation Constraint 10 — "de falls back to en").
 */
function localizedThemeText(text: { en: string; de?: string }, language: LanguageCode): string {
  return language === 'de' ? text.de ?? text.en : text.en;
}

/**
 * Wraps a theme's static banner SVG string as a CSS `url(...)` value so each
 * theme-picker card can render its own watercolor as the card background.
 * `encodeURIComponent` (not base64) keeps it compact and human-diffable.
 */
function bannerBackgroundImage(svg: string): string {
  // Base64 (not percent-encoding): a watercolor SVG contains raw `)`, `#` and
  // `,` (e.g. `filter: url(#edge-…)`), which break CSS `url(...)` parsing and
  // cause the browser to drop the entire background shorthand. Base64 yields
  // only `[A-Za-z0-9+/=]`, so the data URI is always a valid `url()` token.
  // SSR-safe: `btoa` in the browser, `Buffer` during Next's server render.
  const base64 =
    typeof window !== 'undefined'
      ? window.btoa(unescape(encodeURIComponent(svg)))
      : Buffer.from(svg, 'utf8').toString('base64');
  return `url("data:image/svg+xml;base64,${base64}")`;
}

/**
 * Generates a theme's watercolor freshly at CARD dimensions (client-only), so a
 * picker card shows the same rich full-fidelity wash the live header does —
 * rather than the theme's small 420x96 static fallback, whose washes cluster at
 * the edges and leave a near-square card's centre empty. Falls back to the
 * static banner (and ultimately `null`) if the theme declares no dynamic banner
 * or generation throws. Runs through the `DYNAMIC_GENERATORS` seam (never the
 * `@rotheric/visuals` package directly — AC-STRUCT-4).
 */
function generateCardBanner(theme: ReturnType<typeof listThemes>[number]): string | null {
  const dyn = theme.treatments.dynamic?.banner;
  if (!dyn) return null;
  try {
    return DYNAMIC_GENERATORS.watercolor(dyn.style, 'banner', {
      ...dyn.render,
      width: 360,
      height: 220,
    });
  } catch {
    return null;
  }
}

/** Map NDK relay status enum values to a display label category */
function relayStatusLabel(
  status: NDKRelayStatus | undefined,
  copy: { statusConnected: string; statusConnecting: string; statusDisconnected: string },
): { label: string; colorScheme: string } {
  if (status === NDKRelayStatus.CONNECTED) {
    return { label: copy.statusConnected, colorScheme: 'green' };
  }
  if (status === NDKRelayStatus.CONNECTING || status === NDKRelayStatus.RECONNECTING) {
    return { label: copy.statusConnecting, colorScheme: 'yellow' };
  }
  return { label: copy.statusDisconnected, colorScheme: 'gray' };
}

/** Restore-section notice for a backup lookup that found nothing to apply. */
export type BackupNotice = 'none' | 'unreachable' | 'unusable';

export function backupNoticeFor(lookup: BackupLookup): BackupNotice | null {
  return lookup.status === 'found' ? null : lookup.status;
}

export default function SettingsPage() {
  const copy = useCopy();
  const {
    npub,
    pubkeyHex,
    privateKeyHex,
    seedHex,
    backedUp,
    hydrated: identityHydrated,
    replaceIdentity,
    isLocalMode,
    signerMode,
    signerAvailable,
    signerError,
    signerReconnecting,
    initNostrConnect,
    confirmNostrConnect,
    connectBunkerUri,
    disconnectBunker,
    connectNip07,
    disconnectNip07,
  } = useNostrIdentity();
  const { profile: savedProfile, saveProfile } = useProfile();
  const { language, setLanguage } = useLanguage();
  const { themeName, setTheme, activeThemeDefinition } = useAppTheme();
  const { republishDiscoverability } = useMarmot();
  const ownQrDisclosure = useDisclosure();
  const advancedDisclosure = useDisclosure();
  const wipeDisclosure = useDisclosure();
  const toast = useToast();
  const [npubCopied, setNpubCopied] = useState(false);
  const [wipeConfirmInput, setWipeConfirmInput] = useState('');
  // Per-theme card watercolors, generated once on the client (SSR/first paint
  // uses each theme's static banner fallback, then upgrades to a fresh render).
  const [cardBanners, setCardBanners] = useState<Record<string, string>>({});
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const theme of listThemes()) {
      const svg = generateCardBanner(theme);
      if (svg) next[theme.id] = svg;
    }
    setCardBanners(next);
  }, []);

  // --- Relay management state ---
  const [relayList, setRelayList] = useState<string[]>(() => getEffectiveRelays());
  const [relayStatuses, setRelayStatuses] = useState<Record<string, NDKRelayStatus | undefined>>({});
  const [addRelayInput, setAddRelayInput] = useState('');
  const [addRelayError, setAddRelayError] = useState<string | null>(null);
  const [removeRelayError, setRemoveRelayError] = useState<string | null>(null);
  const prevRelayListRef = useRef<string[]>(relayList);

  // Poll relay statuses every 2 seconds when advanced section is open
  useEffect(() => {
    if (!advancedDisclosure.isOpen) return;
    function pollStatuses() {
      const ndk = getNdk();
      if (!ndk) return;
      const statuses: Record<string, NDKRelayStatus | undefined> = {};
      for (const url of relayList) {
        const relay = ndk.pool.relays.get(url);
        statuses[url] = relay?.status;
      }
      setRelayStatuses(statuses);
    }
    pollStatuses();
    const id = setInterval(pollStatuses, 2000);
    return () => clearInterval(id);
  }, [advancedDisclosure.isOpen, relayList]);

  const handleAddRelay = useCallback(() => {
    setAddRelayError(null);
    const url = addRelayInput.trim();
    if (!isValidRelayUrl(url)) {
      setAddRelayError(copy.advanced.relays.invalidUrlError);
      return;
    }
    if (relayList.includes(url)) {
      setAddRelayError(copy.advanced.relays.duplicateUrlError);
      return;
    }
    setRelayList((prev) => [...prev, url]);
    setAddRelayInput('');
  }, [addRelayInput, relayList, copy.advanced.relays]);

  const handleRemoveRelay = useCallback((url: string) => {
    setRemoveRelayError(null);
    if (relayList.length <= 1) {
      setRemoveRelayError(copy.advanced.relays.lastRelayError);
      return;
    }
    setRelayList((prev) => prev.filter((r) => r !== url));
  }, [relayList, copy.advanced.relays]);

  const handleResetRelays = useCallback(() => {
    setAddRelayError(null);
    setRemoveRelayError(null);
    setRelayList([...DEFAULT_RELAYS]);
  }, []);

  const handleSaveRelays = useCallback(async () => {
    const previous = prevRelayListRef.current;
    const next = relayList;
    saveRelays(next);
    applyRelayChangesToPool(previous, next);
    prevRelayListRef.current = next;
    await republishDiscoverability(next).catch((err) =>
      console.warn('[Settings] republishDiscoverability failed:', err),
    );
    toast({
      title: copy.advanced.relays.savedSuccess,
      status: 'success',
      duration: 3000,
      isClosable: true,
    });
  }, [relayList, republishDiscoverability, toast, copy.advanced.relays.savedSuccess]);

  // Backup flow state
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupDone, setBackupDone] = useState(backedUp);

  // Restore flow state
  const [restoreInput, setRestoreInput] = useState('');
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState(false);

  // Relay backup restore state
  const [pendingBackupPayload, setPendingBackupPayload] = useState<import('@/src/lib/backup/relayBackup').BackupPayload | null>(null);
  const backupRestoreDisclosure = useDisclosure();
  const [backupNotice, setBackupNotice] = useState<BackupNotice | null>(null);
  const [backupChecking, setBackupChecking] = useState(false);
  // In-memory only: lets "Check again" re-run the backup lookup for the
  // identity that was just recovered without repeating the recovery.
  const recoveredKeyRef = useRef<{ privateKeyHex: string; pubkeyHex: string } | null>(null);

  // NIP-07 browser extension UI state
  const [nip07Connecting, setNip07Connecting] = useState(false);
  const [nip07ConnectError, setNip07ConnectError] = useState<string | null>(null);

  // --- Call Settings state ---
  // Seed the inputs from the user's saved TURN override only (getStoredTurnServer),
  // NOT the merged getIceConfig: when no override is set the fields stay empty and
  // the help text names the shipped openrelayproject default, so the default is
  // presented as a default rather than masquerading as a user-entered value.
  const storedTurn = getStoredTurnServer();
  const [turnUrl, setTurnUrl] = useState<string>(() => storedTurn?.url ?? '');
  const [turnUsername, setTurnUsername] = useState<string>(() => storedTurn?.username ?? '');
  const [turnCredential, setTurnCredential] = useState<string>(() => storedTurn?.credential ?? '');
  const [ipPrivacy, setIpPrivacy] = useState<boolean>(() => getIpPrivacyMode());

  const handleSaveTurnConfig = useCallback(() => {
    const url = turnUrl.trim();
    if (url) {
      setTurnServer({
        url,
        username: turnUsername.trim() || undefined,
        credential: turnCredential.trim() || undefined,
      });
    } else {
      setTurnServer(null);
    }
    toast({
      title: copy.calls.saveTurnConfig,
      status: 'success',
      duration: 2000,
      isClosable: true,
    });
  }, [turnUrl, turnUsername, turnCredential, toast, copy.calls.saveTurnConfig]);

  const handleIpPrivacyToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = e.target.checked;
    setIpPrivacy(enabled);
    setIpPrivacyMode(enabled);
  }, []);

  // NIP-46 remote signer UI state
  const [nip46ConnectMethod, setNip46ConnectMethod] = useState<'qr' | 'paste' | null>(null);
  const [nip46Relay, setNip46Relay] = useState('wss://relay.nsec.app');
  const [nip46QrDataUrl, setNip46QrDataUrl] = useState<string | null>(null);
  const [nip46QrUri, setNip46QrUri] = useState<string | null>(null);
  const [nip46QrLoading, setNip46QrLoading] = useState(false);
  const [nip46PasteUri, setNip46PasteUri] = useState('');
  const [nip46Connecting, setNip46Connecting] = useState(false);
  const [nip46ConnectError, setNip46ConnectError] = useState<string | null>(null);

  const handleGenerateNip46QR = useCallback(async () => {
    setNip46QrLoading(true);
    setNip46ConnectError(null);
    try {
      const { connectUri } = await initNostrConnect(nip46Relay);
      if (!connectUri) throw new Error('no_uri');
      setNip46QrUri(connectUri);
      // Render QR code as data URL
      const qrcode = await import('qrcode');
      const dataUrl = await qrcode.default.toDataURL(connectUri, { width: 256, margin: 1 });
      setNip46QrDataUrl(dataUrl);
    } catch {
      setNip46ConnectError(copy.advanced.nip46.errorUnreachable);
    } finally {
      setNip46QrLoading(false);
    }
  }, [initNostrConnect, nip46Relay, copy.advanced.nip46.errorUnreachable]);

  const handleNip46CopyUri = useCallback(async () => {
    if (!nip46QrUri) return;
    try {
      await navigator.clipboard.writeText(nip46QrUri);
    } catch {
      // Silently fail
    }
  }, [nip46QrUri]);

  const handleConfirmNostrConnect = useCallback(async () => {
    setNip46Connecting(true);
    setNip46ConnectError(null);
    try {
      await confirmNostrConnect();
      setNip46ConnectMethod(null);
      setNip46QrDataUrl(null);
      setNip46QrUri(null);
    } catch {
      setNip46ConnectError(copy.advanced.nip46.errorUnreachable);
    } finally {
      setNip46Connecting(false);
    }
  }, [confirmNostrConnect, copy.advanced.nip46.errorUnreachable]);

  const handleConnectBunkerUri = useCallback(async () => {
    if (!nip46PasteUri.trim()) return;
    setNip46Connecting(true);
    setNip46ConnectError(null);
    try {
      await connectBunkerUri(nip46PasteUri.trim());
      setNip46ConnectMethod(null);
      setNip46PasteUri('');
    } catch {
      setNip46ConnectError(copy.advanced.nip46.errorUnreachable);
    } finally {
      setNip46Connecting(false);
    }
  }, [connectBunkerUri, nip46PasteUri, copy.advanced.nip46.errorUnreachable]);

  const handleDisconnectBunker = useCallback(() => {
    disconnectBunker();
    setNip46ConnectMethod(null);
    setNip46ConnectError(null);
    setNip46QrDataUrl(null);
    setNip46QrUri(null);
  }, [disconnectBunker]);

  const handleRetryNip46 = useCallback(() => {
    setNip46ConnectMethod(null);
    setNip46ConnectError(null);
    setNip46QrDataUrl(null);
    setNip46QrUri(null);
    setNip46PasteUri('');
  }, []);

  const handleConnectNip07 = useCallback(async () => {
    setNip07Connecting(true);
    setNip07ConnectError(null);
    try {
      await connectNip07();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown_error';
      // Surface the NIP-44 missing error with the dedicated copy key
      if (msg.includes('NIP-44')) {
        setNip07ConnectError(copy.advanced.nip07.nip44MissingError);
      } else if (msg.includes('No browser extension')) {
        setNip07ConnectError(copy.advanced.nip07.noExtensionError);
      } else {
        setNip07ConnectError(copy.advanced.nip07.reconnectError);
      }
    } finally {
      setNip07Connecting(false);
    }
  }, [connectNip07, copy.advanced.nip07]);

  const handleDisconnectNip07 = useCallback(() => {
    disconnectNip07();
    setNip07ConnectError(null);
  }, [disconnectNip07]);

  const handleCopyNpub = useCallback(async () => {
    if (!npub) return;
    try {
      await navigator.clipboard.writeText(npub);
      setNpubCopied(true);
      setTimeout(() => setNpubCopied(false), 2000);
    } catch {
      // Fallback: do nothing silently
    }
  }, [npub]);

  const handleGeneratePhrase = useCallback(async () => {
    if (!privateKeyHex) return;
    setBackupLoading(true);
    try {
      if (seedHex) {
        const { mnemonicFromSeed } = await import('@/src/lib/bip39');
        const phrase = await mnemonicFromSeed(seedHex);
        setMnemonic(phrase);
      } else {
        const { mnemonicFromHex } = await import('@/src/lib/bip39');
        const phrase = await mnemonicFromHex(privateKeyHex);
        setMnemonic(phrase);
      }
      setBackupConfirmed(false);
    } catch {
      // Silently fail
    } finally {
      setBackupLoading(false);
    }
  }, [privateKeyHex, seedHex]);

  const handleConfirmBackup = useCallback(() => {
    if (!backupConfirmed) return;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.nostrBackedUp, 'true');
    }
    setBackupDone(true);
    setMnemonic(null);
    toast({ title: copy.identity.backupDone, status: 'success', duration: 3000, isClosable: true });
  }, [backupConfirmed, copy.identity.backupDone, toast]);

  /** Look up the recovered identity's backup and show the dialog or outcome notice. */
  const presentBackupLookup = useCallback(async (keyHex: string, pkHex: string) => {
    const { lookupBackup, settleRestoreGuard } = await import('@/src/lib/backup/relayBackup');
    const lookup = await lookupBackup(keyHex, pkHex);
    settleRestoreGuard(lookup);
    if (lookup.status === 'found') {
      setBackupNotice(null);
      setPendingBackupPayload(lookup.payload);
      backupRestoreDisclosure.onOpen();
      return;
    }
    setBackupNotice(backupNoticeFor(lookup));
  }, [backupRestoreDisclosure]);

  const handleRestore = useCallback(async () => {
    setRestoreLoading(true);
    setRestoreError(null);
    setBackupNotice(null);
    try {
      const { identityFromMnemonic, hexFromMnemonic } = await import('@/src/lib/bip39');
      const wordCount = restoreInput.trim().split(/\s+/).length;

      let restoredIdentity: { privateKeyHex: string; seedHex?: string } | null = null;

      if (wordCount === 12) {
        const result = await identityFromMnemonic(restoreInput);
        if (result) restoredIdentity = result;
      } else if (wordCount === 24) {
        const hex = await hexFromMnemonic(restoreInput);
        if (hex) restoredIdentity = { privateKeyHex: hex };
      }

      if (!restoredIdentity) {
        setRestoreError(copy.identity.restoreError);
        return;
      }

      const restoredPubkey = await derivePublicKeyHex(restoredIdentity.privateKeyHex);

      // Fetch profile from Nostr relays (kind 0) BEFORE replaceIdentity so a
      // recovered nickname is already saved locally by the time the identity
      // switch takes effect, avoiding a UI flash of an empty profile.
      // (replaceIdentity does NOT publish kind 0 on restore — see the
      // privacy invariant in NostrIdentityContext.tsx / CLAUDE.md: profile
      // data is never broadcast to public relays.)
      try {
        const { connectNdk, fetchEventsWithTimeout } = await import('@/src/lib/ndkClient');
        const ndk = await connectNdk(restoredIdentity.privateKeyHex);
        const { events } = await fetchEventsWithTimeout(ndk, {
          kinds: [0 as import('@nostr-dev-kit/ndk').NDKKind],
          authors: [restoredPubkey],
          limit: 5,
        });
        const sorted = Array.from(events).sort(
          (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0),
        );
        if (sorted.length > 0) {
          const meta = JSON.parse(sorted[0].content ?? '{}');
          const nickname = meta.name || meta.display_name || '';
          if (nickname) {
            saveProfile({ nickname, avatar: savedProfile.avatar });
          }
        }
      } catch (err) {
        console.warn('[Settings] Profile recovery from relays failed:', err);
      }

      // Pause scheduled backups for the recovered identity until the user has
      // decided on the backup that may exist on relays (see markRestorePending).
      const { markRestorePending } = await import('@/src/lib/backup/relayBackup');
      markRestorePending(restoredPubkey);

      await replaceIdentity({
        privateKeyHex: restoredIdentity.privateKeyHex,
        pubkeyHex: restoredPubkey,
        seedHex: restoredIdentity.seedHex,
      });
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEYS.nostrBackedUp, 'true');
      }

      // Check for relay backup
      recoveredKeyRef.current = { privateKeyHex: restoredIdentity.privateKeyHex, pubkeyHex: restoredPubkey };
      setRestoreInput('');
      setBackupDone(true);
      setRestoreSuccess(true);
      try {
        await presentBackupLookup(restoredIdentity.privateKeyHex, restoredPubkey);
      } catch (err) {
        // The identity is already recovered — never report this as an invalid phrase.
        console.warn('[Settings] Relay backup check failed:', err);
        setBackupNotice('unreachable');
      }
    } catch {
      setRestoreError(copy.identity.restoreError);
    } finally {
      setRestoreLoading(false);
    }
  }, [restoreInput, replaceIdentity, copy.identity.restoreError, savedProfile, saveProfile, presentBackupLookup]);

  const handleCheckBackupAgain = useCallback(async () => {
    const key = recoveredKeyRef.current;
    if (!key) return;
    setBackupChecking(true);
    try {
      await presentBackupLookup(key.privateKeyHex, key.pubkeyHex);
    } catch (err) {
      console.warn('[Settings] Relay backup check failed:', err);
      setBackupNotice('unreachable');
    } finally {
      setBackupChecking(false);
    }
  }, [presentBackupLookup]);

  // Re-offer a restore decision left open in an earlier visit (the user left
  // before restoring or skipping, or relays were unreachable): scheduled
  // backups stay paused until it is made.
  const reofferedRef = useRef(false);
  useEffect(() => {
    if (reofferedRef.current || !isLocalMode || !privateKeyHex || !pubkeyHex) return;
    reofferedRef.current = true;
    void (async () => {
      const { isRestorePending } = await import('@/src/lib/backup/relayBackup');
      if (!isRestorePending(pubkeyHex)) return;
      recoveredKeyRef.current = { privateKeyHex, pubkeyHex };
      await presentBackupLookup(privateKeyHex, pubkeyHex);
    })();
  }, [isLocalMode, privateKeyHex, pubkeyHex, presentBackupLookup]);

  const handleConfirmBackupRestore = useCallback(async () => {
    if (!pendingBackupPayload) return;
    try {
      const { restoreFromBackup, clearRestorePending } = await import('@/src/lib/backup/relayBackup');
      await restoreFromBackup(pendingBackupPayload);
      clearRestorePending();
      window.location.reload();
    } catch (err) {
      // Restore FAILED — surface the error, never a false-positive success.
      // (The identity was already restored earlier in handleRestore; only the
      // backup-payload application failed here, so the honest signal is an error.)
      console.error('[Settings] Backup restore failed:', err);
      backupRestoreDisclosure.onClose();
      setPendingBackupPayload(null);
      setRestoreError(copy.identity.backupApplyError);
    }
  }, [pendingBackupPayload, backupRestoreDisclosure, copy.identity.backupApplyError]);

  // Closing the dialog (X, Escape, backdrop) is not a decision: the backup stays
  // protected and is offered again on the next Settings visit.
  const handleCloseBackupRestore = useCallback(() => {
    backupRestoreDisclosure.onClose();
    setPendingBackupPayload(null);
  }, [backupRestoreDisclosure]);

  // Skipping is a decision: the device's own state may now be backed up.
  const handleSkipBackupRestore = useCallback(() => {
    handleCloseBackupRestore();
    void import('@/src/lib/backup/relayBackup').then((m) => m.clearRestorePending());
  }, [handleCloseBackupRestore]);

  return (
    <>
      <Head>
        <title>{`${copy.settings.pageTitle} - ${copy.appName}`}</title>
      </Head>
      <Box data-testid="settings-page">
        <Heading as="h1" size="xl" mb={6}>
          {copy.settings.heading}
        </Heading>

        <VStack spacing={6} align="stretch">
          {/* Feedback Section — only rendered when the feature is enabled */}
          {MAINTAINER_ACTIVE_PUBKEY_HEX ? (
            <Box>
              <NextLink href="/feedback" passHref legacyBehavior>
                <Button
                  as="a"
                  variant="outline"
                  size="sm"
                  data-testid="settings-feedback-row"
                >
                  {copy.feedback.settingsRowLabel}
                </Button>
              </NextLink>
            </Box>
          ) : null}

          {/* Theme Section */}
          <Box>
            <Heading as="h2" size="md" mb={1}>
              {copy.settings.themeHeading}
            </Heading>
            <Text fontSize="sm" color="textMuted" mb={4}>
              {copy.settings.themeDescription}
            </Text>

            <SimpleGrid columns={{ base: 2, md: 3 }} spacing={4}>
              {listThemes().map((themeOption) => {
                const isActive = themeName === themeOption.id;
                const c = themeOption.colors;
                const brand500 = c.brand[5];
                const cardRadius = themeOption.shape?.radii?.lg ?? '16px';
                const cardSvg = cardBanners[themeOption.id] ?? themeOption.treatments.banner;
                return (
                  <Box
                    as="button"
                    type="button"
                    key={themeOption.id}
                    onClick={() => setTheme(themeOption.id as AppThemeName)}
                    data-testid={`theme-${themeOption.id}-btn`}
                    aria-pressed={isActive}
                    textAlign="left"
                    position="relative"
                    overflow="hidden"
                    minH="132px"
                    borderRadius={cardRadius}
                    // The colourful watercolour fills the whole card (theme
                    // identity): the freshly-rendered wash multiplied over a
                    // brand-hue gradient, so each theme reads as its own colour.
                    // Set through the RAW DOM `style` attribute, NOT Chakra
                    // background props: Chakra's style-prop pipeline silently
                    // drops a data-URI `background-image` (documented in
                    // useDynamicBanner.ts's hard-contract comment).
                    style={{
                      backgroundColor: c.appBg,
                      backgroundImage: `${bannerBackgroundImage(cardSvg)}, linear-gradient(135deg, ${c.brand[3]}, ${c.brand[6]})`,
                      backgroundSize: 'cover, cover',
                      backgroundPosition: 'center, center',
                      backgroundBlendMode: 'multiply, normal',
                    }}
                    borderWidth="2px"
                    borderColor={isActive ? brand500 : c.borderSubtle}
                    boxShadow={isActive ? `0 0 0 2px ${brand500}` : 'sm'}
                    transition="transform 0.15s ease, box-shadow 0.15s ease"
                    _hover={{ transform: 'translateY(-2px)', boxShadow: 'md' }}
                    _focusVisible={{ outline: 'none', boxShadow: `0 0 0 3px ${brand500}` }}
                  >
                    {isActive && (
                      <Badge
                        position="absolute"
                        top={2}
                        right={2}
                        bg={brand500}
                        color={c.surfaceBg}
                        borderRadius="full"
                        px={2}
                        fontSize="0.65rem"
                        zIndex={1}
                      >
                        ✓
                      </Badge>
                    )}
                    {/* Frosted footer: text sits on the theme's own surface
                        colour so label/description keep gate-safe contrast
                        regardless of the wash behind the card. */}
                    <Box
                      position="absolute"
                      left={0}
                      right={0}
                      bottom={0}
                      p={3}
                      bg={c.surfaceBg}
                      opacity={0.92}
                      borderTopWidth="1px"
                      borderColor={c.borderSubtle}
                    >
                      <Text
                        fontFamily={themeOption.typography.fonts.heading}
                        fontWeight="bold"
                        fontSize="lg"
                        lineHeight="1.1"
                        color={c.textStrong}
                      >
                        {localizedThemeText(themeOption.label, language)}
                      </Text>
                      <Text fontSize="xs" color={c.textMuted} noOfLines={2} mt={1}>
                        {localizedThemeText(themeOption.description, language)}
                      </Text>
                    </Box>
                  </Box>
                );
              })}
            </SimpleGrid>
          </Box>

          {/* Language Section */}
          <Box>
            <Heading as="h2" size="md" mb={1}>
              {copy.settings.languageHeading}
            </Heading>
            <Text fontSize="sm" color="textMuted" mb={4}>
              {copy.settings.languageDescription}
            </Text>

            <HStack spacing={4} flexWrap="wrap">
              {(['en', 'de'] as const).map((option) => (
                <Button
                  key={option}
                  variant={language === option ? 'solid' : 'outline'}
                  onClick={() => setLanguage(option)}
                  data-testid={`language-${option}-btn`}
                  size="lg"
                >
                  {copy.languageNames[option]}
                </Button>
              ))}
            </HStack>
          </Box>

          {/* Nostr Identity Section */}
          <Box>
            {identityHydrated && npub ? (
              <VStack align="stretch" spacing={5}>
                {/* Backup Section — only shown in local signer mode */}
                {isLocalMode && (
                  <Box>
                    <Heading as="h3" size="sm" mb={1}>
                      {copy.identity.backupHeading}
                    </Heading>
                    <Text fontSize="sm" color="textMuted" mb={3}>
                      {copy.identity.backupDescription}
                    </Text>

                    {backupDone && !mnemonic && (
                      <Alert status="success" borderRadius="md" mb={3} size="sm">
                        <AlertIcon />
                        <AlertDescription fontSize="sm">{copy.identity.backupDone}</AlertDescription>
                      </Alert>
                    )}

                    {!mnemonic && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleGeneratePhrase()}
                        isLoading={backupLoading}
                        data-testid="generate-backup-phrase-btn"
                      >
                        {copy.identity.generatePhrase}
                      </Button>
                    )}

                    {mnemonic && (
                      <VStack align="stretch" spacing={3}>
                        <Alert status="warning" borderRadius="md">
                          <AlertIcon />
                          <AlertDescription fontSize="sm">{copy.identity.backupWarning}</AlertDescription>
                        </Alert>
                        <Code
                          p={4}
                          borderRadius="md"
                          fontSize="md"
                          whiteSpace="pre-wrap"
                          wordBreak="break-word"
                          bg="surfaceMutedBg"
                          data-testid="mnemonic-display"
                        >
                          {mnemonic}
                        </Code>
                        <Checkbox
                          isChecked={backupConfirmed}
                          onChange={(e) => setBackupConfirmed(e.target.checked)}
                          data-testid="backup-confirm-checkbox"
                        >
                          <Text fontSize="sm">{copy.identity.backupConfirmCheck}</Text>
                        </Checkbox>
                        <Button
                          size="sm"
                          isDisabled={!backupConfirmed}
                          onClick={handleConfirmBackup}
                          data-testid="backup-done-btn"
                        >
                          Done
                        </Button>
                      </VStack>
                    )}
                  </Box>
                )}

                {/* Restore Section — only shown in local signer mode */}
                {isLocalMode && (
                  <Box>
                    <Heading as="h3" size="sm" mb={1}>
                      {copy.identity.restoreHeading}
                    </Heading>
                    <Text fontSize="sm" color="textMuted" mb={3}>
                      {copy.identity.restoreDescription}
                    </Text>

                    {restoreSuccess && (
                      <Alert status="success" borderRadius="md" mb={3}>
                        <AlertIcon />
                        <AlertDescription fontSize="sm">{copy.identity.restoreSuccess}</AlertDescription>
                      </Alert>
                    )}

                    {backupNotice && (
                      <Alert
                        status={backupNotice === 'none' ? 'info' : 'warning'}
                        borderRadius="md"
                        mb={3}
                        data-testid={`backup-notice-${backupNotice}`}
                      >
                        <AlertIcon />
                        <AlertDescription fontSize="sm" flex="1">
                          {backupNotice === 'none'
                            ? copy.identity.backupNotFound
                            : backupNotice === 'unreachable'
                              ? copy.identity.backupUnreachable
                              : copy.identity.backupUnusable}
                        </AlertDescription>
                        {backupNotice === 'unreachable' && (
                          <Button
                            size="xs"
                            variant="outline"
                            ml={2}
                            onClick={() => void handleCheckBackupAgain()}
                            isLoading={backupChecking}
                            data-testid="backup-check-again-btn"
                          >
                            {copy.identity.backupCheckAgain}
                          </Button>
                        )}
                      </Alert>
                    )}

                    {restoreError && (
                      <Alert status="error" borderRadius="md" mb={3} data-testid="restore-error-alert">
                        <AlertIcon />
                        <AlertDescription fontSize="sm">{restoreError}</AlertDescription>
                      </Alert>
                    )}

                    <VStack align="stretch" spacing={2}>
                      <Textarea
                        value={restoreInput}
                        onChange={(e) => setRestoreInput(e.target.value)}
                        placeholder={copy.identity.restoreInput}
                        rows={3}
                        bg="surfaceBg"
                        fontSize="sm"
                        data-testid="restore-phrase-input"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        colorScheme="danger"
                        onClick={() => void handleRestore()}
                        isLoading={restoreLoading}
                        isDisabled={restoreInput.trim().split(/\s+/).length < 12}
                        data-testid="restore-identity-btn"
                      >
                        {copy.identity.restoreButton}
                      </Button>
                    </VStack>
                  </Box>
                )}
              </VStack>
            ) : (
              <Text fontSize="sm" color="textMuted">
                {copy.identity.notReady}
              </Text>
            )}
          </Box>

          {/* Advanced Settings Section */}
          <Box>
            <HStack justify="space-between" align="center">
              <Heading as="h2" size="md">
                {copy.advanced.sectionTitle}
              </Heading>
              <Button
                size="sm"
                variant="ghost"
                onClick={advancedDisclosure.onToggle}
                data-testid="advanced-settings-toggle"
              >
                {advancedDisclosure.isOpen
                  ? copy.advanced.toggleCollapse
                  : copy.advanced.toggleExpand}
              </Button>
            </HStack>
            <Collapse in={advancedDisclosure.isOpen} animateOpacity>
              <Box pt={4}>
                {/* npub (public key) — a technical identity detail, shown here
                    under Advanced. Backup/restore live in the Identity section. */}
                {identityHydrated && npub && (
                  <Box mb={6} pb={4} borderBottom="1px solid" borderColor="borderSubtle">
                    <Text fontSize="sm" color="textMuted" mb={1}>
                      {copy.identity.npubLabel}
                    </Text>
                    <HStack spacing={3} flexWrap="wrap">
                      <Code
                        fontSize="sm"
                        px={3}
                        py={2}
                        borderRadius="md"
                        bg="surfaceMutedBg"
                        userSelect="all"
                        data-testid="identity-npub-display"
                      >
                        {truncateNpub(npub)}
                      </Code>
                      <NpubQrButton
                        label={copy.identity.showQr}
                        onClick={ownQrDisclosure.onOpen}
                        data-testid="show-own-npub-qr-btn"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleCopyNpub}
                        data-testid="copy-npub-btn"
                      >
                        {npubCopied ? copy.identity.copiedNpub : copy.identity.copyNpub}
                      </Button>
                    </HStack>

                    <NpubQrModal
                      isOpen={ownQrDisclosure.isOpen}
                      onClose={ownQrDisclosure.onClose}
                      title={copy.identity.qrModalTitle}
                      mode="display"
                      npub={npub}
                      qrErrorMessage={copy.identity.qrGenerationError}
                    />
                  </Box>
                )}

                {/* Relay management */}
                <Heading as="h3" size="sm" mb={3}>
                  {copy.advanced.relays.sectionTitle}
                </Heading>
                <Text fontSize="sm" color="textMuted" mb={3}>
                  {copy.advanced.relays.discoverabilityNote}
                </Text>

                {removeRelayError && (
                  <Alert status="error" borderRadius="md" mb={3} size="sm">
                    <AlertIcon />
                    <AlertDescription fontSize="sm">{removeRelayError}</AlertDescription>
                  </Alert>
                )}

                <VStack
                  align="stretch"
                  spacing={2}
                  mb={3}
                  data-testid="relay-list"
                >
                  {relayList.map((url) => {
                    const { label, colorScheme } = relayStatusLabel(
                      relayStatuses[url],
                      copy.advanced.relays,
                    );
                    return (
                      <HStack
                        key={url}
                        justify="space-between"
                        data-testid={`relay-row-${relayTestId(url)}`}
                        bg="surfaceMutedBg"
                        px={3}
                        py={2}
                        borderRadius="md"
                        flexWrap="wrap"
                        gap={2}
                      >
                        <Text fontSize="sm" wordBreak="break-all" flex="1">
                          {url}
                        </Text>
                        <Badge colorScheme={colorScheme} fontSize="xs">
                          {label}
                        </Badge>
                        <Button
                          size="xs"
                          variant="ghost"
                          colorScheme="danger"
                          onClick={() => handleRemoveRelay(url)}
                          data-testid={`remove-relay-btn-${relayTestId(url)}`}
                        >
                          {copy.advanced.relays.removeBtn}
                        </Button>
                      </HStack>
                    );
                  })}
                </VStack>

                {/* Add relay input */}
                <HStack mb={1}>
                  <Input
                    value={addRelayInput}
                    onChange={(e) => {
                      setAddRelayInput(e.target.value);
                      setAddRelayError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddRelay();
                    }}
                    placeholder={copy.advanced.relays.addPlaceholder}
                    size="sm"
                    bg="surfaceBg"
                    data-testid="add-relay-input"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleAddRelay}
                    data-testid="add-relay-btn"
                    flexShrink={0}
                  >
                    {copy.advanced.relays.addBtn}
                  </Button>
                </HStack>
                {addRelayError && (
                  <Text fontSize="sm" color="red.500" mb={2} data-testid="add-relay-error">
                    {addRelayError}
                  </Text>
                )}

                <HStack mt={3} spacing={2}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleResetRelays}
                    data-testid="reset-relays-btn"
                  >
                    {copy.advanced.relays.resetBtn}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void handleSaveRelays()}
                    data-testid="save-relays-btn"
                  >
                    {copy.advanced.relays.saveBtn}
                  </Button>
                </HStack>

                {/* NIP-46 Remote Signer */}
                <Box mt={6} pt={4} borderTop="1px solid" borderColor="borderSubtle">
                  <Heading as="h3" size="sm" mb={2}>
                    {copy.advanced.nip46.sectionTitle}
                  </Heading>

                  {signerMode !== 'nip46' ? (
                    /* Local mode: show connect options */
                    <VStack align="stretch" spacing={3}>
                      <Text fontSize="sm" color="textMuted">
                        {copy.advanced.nip46.description}
                      </Text>
                      <VStack align="stretch" spacing={1} fontSize="sm" color="textMuted">
                        <Text>• {copy.advanced.nip46.disclosureGroupFast}</Text>
                        <Text>• {copy.advanced.nip46.disclosureIdentityLeaves}</Text>
                        <Text>• {copy.advanced.nip46.disclosureDmSlow}</Text>
                      </VStack>

                      {nip46ConnectError && (
                        <Alert status="error" borderRadius="md" size="sm">
                          <AlertIcon />
                          <AlertDescription fontSize="sm">{nip46ConnectError}</AlertDescription>
                        </Alert>
                      )}

                      {nip46ConnectMethod === null && (
                        <HStack spacing={2} flexWrap="wrap">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setNip46ConnectMethod('qr')}
                            data-testid="nip46-connect-qr-btn"
                          >
                            {copy.advanced.nip46.connectQrBtn}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setNip46ConnectMethod('paste')}
                            data-testid="nip46-connect-paste-btn"
                          >
                            {copy.advanced.nip46.connectPasteBtn}
                          </Button>
                        </HStack>
                      )}

                      {nip46ConnectMethod === 'qr' && (
                        <VStack align="stretch" spacing={3}>
                          <Box>
                            <Text fontSize="sm" mb={1}>{copy.advanced.nip46.relayInputLabel}</Text>
                            <Input
                              value={nip46Relay}
                              onChange={(e) => setNip46Relay(e.target.value)}
                              placeholder={copy.advanced.nip46.relayInputPlaceholder}
                              size="sm"
                              bg="surfaceBg"
                              data-testid="nip46-relay-input"
                            />
                          </Box>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleGenerateNip46QR()}
                            isLoading={nip46QrLoading}
                            data-testid="nip46-generate-qr-btn"
                          >
                            {copy.advanced.nip46.generateQrBtn}
                          </Button>
                          {nip46QrDataUrl && (
                            <VStack align="stretch" spacing={2}>
                              <Image
                                src={nip46QrDataUrl}
                                alt="nostrconnect QR code"
                                maxW="256px"
                                data-testid="nip46-qr-image"
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void handleNip46CopyUri()}
                                data-testid="nip46-copy-uri-btn"
                              >
                                Copy URI
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => void handleConfirmNostrConnect()}
                                isLoading={nip46Connecting}
                                data-testid="nip46-confirm-connect-btn"
                              >
                                {copy.advanced.nip46.confirmConnectBtn}
                              </Button>
                            </VStack>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => { setNip46ConnectMethod(null); setNip46QrDataUrl(null); setNip46QrUri(null); setNip46ConnectError(null); }}
                            data-testid="nip46-cancel-btn"
                          >
                            {copy.advanced.dangerZone.wipeCancel}
                          </Button>
                        </VStack>
                      )}

                      {nip46ConnectMethod === 'paste' && (
                        <VStack align="stretch" spacing={3}>
                          <Box>
                            <Text fontSize="sm" mb={1}>{copy.advanced.nip46.pasteUriLabel}</Text>
                            <Textarea
                              value={nip46PasteUri}
                              onChange={(e) => setNip46PasteUri(e.target.value)}
                              placeholder={copy.advanced.nip46.pasteUriPlaceholder}
                              rows={3}
                              size="sm"
                              bg="surfaceBg"
                              data-testid="nip46-paste-uri-input"
                            />
                          </Box>
                          <HStack spacing={2}>
                            <Button
                              size="sm"
                              onClick={() => void handleConnectBunkerUri()}
                              isLoading={nip46Connecting}
                              isDisabled={!nip46PasteUri.trim()}
                              data-testid="nip46-connect-bunker-btn"
                            >
                              {copy.advanced.nip46.connectBtn}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setNip46ConnectMethod(null); setNip46PasteUri(''); setNip46ConnectError(null); }}
                            >
                              {copy.advanced.dangerZone.wipeCancel}
                            </Button>
                          </HStack>
                        </VStack>
                      )}
                    </VStack>
                  ) : (
                    /* NIP-46 mode: show connected state */
                    <VStack align="stretch" spacing={3}>
                      {signerReconnecting ? (
                        <HStack>
                          <Spinner size="sm" />
                          <Text fontSize="sm">{copy.advanced.nip46.reconnecting}</Text>
                        </HStack>
                      ) : signerError ? (
                        <VStack align="stretch" spacing={2}>
                          <Alert status="warning" borderRadius="md" size="sm">
                            <AlertIcon />
                            <AlertDescription fontSize="sm">
                              {copy.advanced.nip46.errorUnreachable}
                            </AlertDescription>
                          </Alert>
                          <HStack spacing={2}>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={handleRetryNip46}
                              data-testid="nip46-retry-btn"
                            >
                              {copy.advanced.nip46.retryBtn}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={handleDisconnectBunker}
                              data-testid="nip46-disconnect-btn"
                            >
                              {copy.advanced.nip46.disconnect}
                            </Button>
                          </HStack>
                        </VStack>
                      ) : (
                        <VStack align="stretch" spacing={2}>
                          <Text fontSize="sm" color="green.500">
                            {copy.advanced.nip46.connected}
                          </Text>
                          {npub && (
                            <Text fontSize="sm" color="textMuted">
                              {copy.advanced.nip46.connectedAs}{' '}
                              <Code fontSize="xs">{truncateNpub(npub)}</Code>
                            </Text>
                          )}
                          {!signerAvailable && (
                            <Alert status="warning" borderRadius="md" size="sm">
                              <AlertIcon />
                              <AlertDescription fontSize="sm">
                                {copy.advanced.nip46.signerUnavailable}
                              </AlertDescription>
                            </Alert>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            colorScheme="danger"
                            onClick={handleDisconnectBunker}
                            data-testid="nip46-disconnect-btn"
                          >
                            {copy.advanced.nip46.disconnect}
                          </Button>
                        </VStack>
                      )}
                    </VStack>
                  )}
                </Box>

                {/* NIP-07 Browser Extension */}
                <Box mt={6} pt={4} borderTop="1px solid" borderColor="borderSubtle">
                  <Heading as="h3" size="sm" mb={2}>
                    {copy.advanced.nip07.sectionTitle}
                  </Heading>

                  {signerMode !== 'nip07' ? (
                    /* Not in nip07 mode: show connect option */
                    <VStack align="stretch" spacing={3}>
                      <Text fontSize="sm" color="textMuted">
                        {copy.advanced.nip07.description}
                      </Text>

                      {nip07ConnectError && (
                        <Alert
                          status="error"
                          borderRadius="md"
                          size="sm"
                          data-testid={
                            nip07ConnectError === copy.advanced.nip07.nip44MissingError
                              ? 'nip07-nip44-error'
                              : undefined
                          }
                        >
                          <AlertIcon />
                          <AlertDescription fontSize="sm">{nip07ConnectError}</AlertDescription>
                        </Alert>
                      )}

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleConnectNip07()}
                        isLoading={nip07Connecting}
                        loadingText={copy.advanced.nip07.connecting}
                        data-testid="nip07-connect-btn"
                      >
                        {copy.advanced.nip07.connectBtn}
                      </Button>
                    </VStack>
                  ) : (
                    /* nip07 mode: show connected state */
                    <VStack align="stretch" spacing={2}>
                      <Text fontSize="sm" color="green.500">
                        {copy.advanced.nip07.connected}
                      </Text>
                      {npub && (
                        <Text fontSize="sm" color="textMuted">
                          {copy.advanced.nip07.connectedAs}{' '}
                          <Code fontSize="xs">{truncateNpub(npub)}</Code>
                        </Text>
                      )}
                      {signerError === 'nip07_unavailable' && (
                        <Alert status="warning" borderRadius="md" size="sm">
                          <AlertIcon />
                          <AlertDescription fontSize="sm">
                            {copy.advanced.nip07.reconnectError}
                          </AlertDescription>
                        </Alert>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        colorScheme="danger"
                        onClick={handleDisconnectNip07}
                        data-testid="nip07-disconnect-btn"
                      >
                        {copy.advanced.nip07.disconnect}
                      </Button>
                    </VStack>
                  )}
                </Box>

                {/* Call connectivity (TURN relay + IP privacy) — advanced
                    networking knobs; calls work out of the box on the
                    openrelayproject default, so this lives under Advanced.
                    Hidden while the call feature is disabled (CALLS_ENABLED):
                    the components are retained, just not rendered. */}
                {CALLS_ENABLED && (
                <Box
                  mt={6}
                  pt={4}
                  borderTop="1px solid"
                  borderColor="borderSubtle"
                  data-testid="call-settings-section"
                >
                  <Heading as="h3" size="sm" mb={2}>
                    {copy.calls.callSettings}
                  </Heading>
                  <VStack align="stretch" spacing={3} mt={2}>
                    <Text fontSize="sm" color="textMuted">
                      {copy.calls.turnHelp}
                    </Text>
                    <FormControl>
                      <FormLabel fontSize="sm">{copy.calls.turnServerUrl}</FormLabel>
                      <Input
                        value={turnUrl}
                        onChange={(e) => setTurnUrl(e.target.value)}
                        placeholder="turn:your-server.example.com:3478"
                        size="sm"
                        bg="surfaceBg"
                        data-testid="turn-server-url-input"
                      />
                    </FormControl>
                    <FormControl>
                      <FormLabel fontSize="sm">{copy.calls.turnUsername}</FormLabel>
                      <Input
                        value={turnUsername}
                        onChange={(e) => setTurnUsername(e.target.value)}
                        placeholder=""
                        size="sm"
                        bg="surfaceBg"
                        data-testid="turn-username-input"
                      />
                    </FormControl>
                    <FormControl>
                      <FormLabel fontSize="sm">{copy.calls.turnCredential}</FormLabel>
                      <Input
                        type="password"
                        value={turnCredential}
                        onChange={(e) => setTurnCredential(e.target.value)}
                        placeholder=""
                        size="sm"
                        bg="surfaceBg"
                        data-testid="turn-credential-input"
                      />
                    </FormControl>
                    <Box>
                      <Button
                        size="sm"
                        onClick={handleSaveTurnConfig}
                        data-testid="save-turn-config-btn"
                      >
                        {copy.calls.saveTurnConfig}
                      </Button>
                    </Box>

                    {/* IP Privacy Toggle */}
                    <Box pt={2} borderTop="1px solid" borderColor="borderSubtle">
                      <Text fontSize="sm" color="textMuted" mb={2}>
                        {copy.calls.ipPrivacyHelp}
                      </Text>
                      <FormControl display="flex" alignItems="center">
                        <Switch
                          id="ip-privacy-toggle"
                          isChecked={ipPrivacy}
                          onChange={handleIpPrivacyToggle}
                          data-testid="ip-privacy-toggle"
                          mr={3}
                        />
                        <FormLabel htmlFor="ip-privacy-toggle" mb={0} fontSize="sm">
                          {copy.calls.ipPrivacyMode}
                        </FormLabel>
                      </FormControl>
                    </Box>
                  </VStack>
                </Box>
                )}

                {/* Danger Zone */}
                <Box mt={6} pt={4} borderTop="1px solid" borderColor="red.200">
                  <Heading as="h3" size="sm" mb={2} color="red.500">
                    {copy.advanced.dangerZone.title}
                  </Heading>
                  <Text fontSize="sm" color="textMuted" mb={3}>
                    {copy.advanced.dangerZone.wipeWarning}
                  </Text>

                  {!wipeDisclosure.isOpen ? (
                    <Button
                      size="sm"
                      colorScheme="danger"
                      variant="outline"
                      onClick={wipeDisclosure.onOpen}
                      data-testid="danger-zone-wipe-btn"
                    >
                      {copy.advanced.dangerZone.wipeBtn}
                    </Button>
                  ) : (
                    <VStack align="stretch" spacing={2}>
                      <Input
                        value={wipeConfirmInput}
                        onChange={(e) => setWipeConfirmInput(e.target.value)}
                        placeholder={copy.advanced.dangerZone.wipeConfirmPrompt}
                        size="sm"
                        bg="surfaceBg"
                        data-testid="danger-zone-confirm-input"
                      />
                      <HStack spacing={2}>
                        <Button
                          size="sm"
                          colorScheme="danger"
                          isDisabled={wipeConfirmInput !== copy.advanced.dangerZone.wipeConfirmWord}
                          onClick={() => {
                            resetAllData();
                            window.location.reload();
                          }}
                          data-testid="danger-zone-confirm-btn"
                        >
                          {copy.advanced.dangerZone.wipeConfirmBtn}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            wipeDisclosure.onClose();
                            setWipeConfirmInput('');
                          }}
                        >
                          {copy.advanced.dangerZone.wipeCancel}
                        </Button>
                      </HStack>
                    </VStack>
                  )}
                </Box>
              </Box>
            </Collapse>
          </Box>
        </VStack>
      </Box>

      {/* Relay backup restore confirmation dialog */}
      <Modal
        isOpen={backupRestoreDisclosure.isOpen}
        onClose={handleCloseBackupRestore}
        isCentered
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{copy.identity.backupRestoreTitle}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Text>{copy.identity.backupRestoreBody}</Text>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="ghost"
              mr={3}
              onClick={handleSkipBackupRestore}
            >
              {copy.identity.backupRestoreSkip}
            </Button>
            <Button colorScheme="brand" onClick={handleConfirmBackupRestore}>
              {copy.identity.backupRestoreConfirm}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
