import React, { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Heading,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react';
import { useCopy } from '@/src/context/LanguageContext';
import { useMarmot } from '@/src/context/MarmotContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useProfile } from '@/src/context/ProfileContext';
import {
  readLocationHash,
  extractCardPayloadFromHash,
  resolveAddDeepLink,
  type AddDeepLinkOutcome,
} from '@/src/lib/addDeepLink';
import { attemptOrQueuePairingEcho, type PendingIntentSendContext } from '@/src/lib/pairing/pendingIntent';
import { deriveInviterName } from '@/src/lib/contactInviteLine';
import { hasShareableName } from '@/src/lib/shareCard';
import WelcomeInvite from '@/src/components/WelcomeInvite';

/**
 * Builds the lazy NDK/signer-resolving send context `attemptOrQueuePairingEcho`
 * needs (epic: contact-pairing-code, story S4). Module-level and pure over its
 * params — shared by both call sites below (the fresh-add path and the
 * review-remediated already_exists/returning-scanner path) so the
 * `resolveSendDeps` closure is written once, not duplicated.
 */
function buildPendingIntentSendContext(
  ownPubkeyHex: string,
  ownPrivateKeyHex: string,
  nickname: string,
): PendingIntentSendContext {
  return {
    ownPubkeyHex,
    ownPrivateKeyHex,
    ownProfile: { nickname, createdAt: Math.floor(Date.now() / 1000) },
    resolveSendDeps: async () => {
      const [{ connectNdk }, { activeEventSignerOverride, createPrivateKeySigner }] = await Promise.all([
        import('@/src/lib/ndkClient'),
        import('@/src/lib/marmot/signerAdapter'),
      ]);
      const ndk = await connectNdk(ownPrivateKeyHex);
      const signer = activeEventSignerOverride.current ?? createPrivateKeySigner(ownPrivateKeyHex);
      return { ndk, signEvent: signer.signEvent };
    },
  };
}

/**
 * `/add` — static onboarding/deep-link page (epic: contact-card-exchange,
 * story S7). Reads a contact card from `window.location.hash` (fragment,
 * never a query param — DD 9, AC-UX-3) and drives the existing add-contact
 * flow (S4's `processContactInput`, which itself owns the single
 * `parseContactCard` call and S2's `importCard`).
 *
 * A static top-level page (no `[param].tsx` dynamic segment — CLAUDE.md
 * static-export constraint), so it resolves identically on a fresh direct
 * load and on a reload.
 *
 * Two modes (AC-UX-7):
 *   (a) visitor already has a local identity -> the add completes as soon as
 *       the hash is read.
 *   (b) visitor has no local identity yet -> this app auto-generates one on
 *       first mount (NostrIdentityContext; there is no separate onboarding
 *       wizard to route into). The page shows a brief "setting up…" state
 *       until `useNostrIdentity().hydrated` flips true — which is exactly
 *       the moment the auto-generated identity becomes available — then
 *       completes the add. The card is held only in the retained hash/page
 *       state across that wait; it is never transmitted to the server in
 *       either mode (AC-SEC-1).
 *
 * On a SUCCESSFUL add this page is not a visible stop: it `router.replace`s
 * straight to `/contacts?id=<pubkeyHex>&added=1`, selecting the just-added
 * contact and letting the contacts page render the green "Contact added"
 * confirmation. `replace` (not `push`) keeps `/add` out of history, so it is
 * omitted as an intermediary. Only the non-success outcomes (no card / parse
 * or add error) remain rendered here, where there is no contact to navigate to.
 *
 * Epic: contact-pairing-code, story S4 (RD-7). When the scanned card carries
 * an unexpired `pairing` field (`processContactInput`'s `pairingEcho`
 * candidate), this page is also the scanner-side reciprocation trigger: a
 * named scanner echoes immediately (AC-SCAN-1/8, still redirecting to
 * `/contacts`, now carrying `&pairing=sent|pending` for the honesty-copy
 * wiring on that page) and a nameless one is redirected to `/profile?pairing=1`
 * instead (AC-SCAN-5) — the pending intent is durably persisted first
 * (`pendingIntent.ts#attemptOrQueuePairingEcho`), so the redirect never risks
 * losing the echo.
 *
 * Epic: first-visit-invite-welcome, story S3 (AC-CONTACT-1..5, AC-NAME-2,
 * AC-RETURN-1). A GENUINE first-time visitor (`useNostrIdentity().
 * isFreshIdentity`, S1's seam — true only when no identity existed in
 * storage at this page load's init) who opens a contact-card link is shown
 * the blended `WelcomeInvite` (contact variant) INSTEAD of the "setting
 * up…"/redirecting flow above: the effect below holds off calling
 * `resolveAddDeepLink` (so `processContactInput`/the add itself does not run
 * yet) until the newcomer submits a non-blank name. The inviter's name is
 * decoded read-only for display via `deriveInviterName`
 * (contactInviteLine.ts), which composes the same `parseContactCard` seam
 * `processContactInput` uses internally — no duplicated decode/signature
 * logic, and (being a pure fragment decode) no relay read and no broadcast
 * of the newcomer's own data (AC-PRIV-2). Submitting the welcome screen (a)
 * saves the entered name locally via the existing `saveProfile` (never a
 * broadcast — AC-PRIV-1), then (b) unblocks the SAME add-effect below,
 * which runs completely unchanged — including the pending-pairing-echo
 * check, which now reads the just-saved name inline instead of deferring to
 * `/profile?pairing=1` (AC-NAME-2; only the ordering changed, never the echo
 * mechanism itself). A returning user (`isFreshIdentity === false`) never
 * sees this branch — the effect below runs exactly as it did before this
 * story (AC-RETURN-1).
 */
export default function AddPage(): JSX.Element {
  const copy = useCopy();
  const router = useRouter();
  const { hydrated, isFreshIdentity, pubkeyHex, privateKeyHex } = useNostrIdentity();
  const { profile, saveProfile } = useProfile();
  const { notifyKnownPeersChanged } = useMarmot();
  const [outcome, setOutcome] = useState<AddDeepLinkOutcome | null>(null);
  // Guards processContactInput (and therefore parseContactCard, VQ-S7-002)
  // from ever running more than once per page load, even across React
  // StrictMode's double-invoke or repeated hydration-state re-renders.
  const settledRef = useRef(false);

  // Epic: first-visit-invite-welcome, story S3. The raw `#c=` fragment
  // payload, read once on mount — independent of identity hydration, so the
  // welcome-vs-spinner decision below doesn't have to wait on it. This is
  // ONLY the pure marker-extraction addDeepLink.ts already does (never a
  // second `parseContactCard`/decode call) — `deriveInviterName` below is
  // what actually decodes, for display only.
  const [cardPayload, setCardPayload] = useState<string | null>(null);
  useEffect(() => {
    const hash = readLocationHash(typeof window === 'undefined' ? undefined : window);
    setCardPayload(extractCardPayloadFromHash(hash));
  }, []);

  const inviterName = useMemo(
    () => (cardPayload !== null ? deriveInviterName(cardPayload) : null),
    [cardPayload],
  );
  const [welcomeConfirmed, setWelcomeConfirmed] = useState(false);
  const [welcomeNameValue, setWelcomeNameValue] = useState('');
  // True only for a genuine first-time visitor who opened a contact-card
  // link and hasn't yet submitted the welcome screen (AC-CONTACT-1). A
  // returning user (isFreshIdentity === false) is never true here, so their
  // flow below is byte-identical to pre-S3 behavior (AC-RETURN-1).
  //
  // Implicit ordering dependency (gate-remediation, Finding C): this reads
  // `cardPayload`, which the effect above commits asynchronously (one tick
  // after mount) — `hydrated`/`isFreshIdentity` from useNostrIdentity() also
  // flip true asynchronously, on a separate effect in a separate provider.
  // `showContactWelcome` is only correct because `cardPayload` is already
  // committed (non-null-or-confirmed-null) by the time `hydrated &&
  // isFreshIdentity` becomes true in practice. A future refactor of either
  // effect's timing (e.g. deferring the hash read, or resolving identity
  // synchronously) could silently flip this comparison's assumptions —
  // re-verify AC-CONTACT-1 if either effect's scheduling changes.
  const showContactWelcome = hydrated && isFreshIdentity && cardPayload !== null && !welcomeConfirmed;

  function handleContactWelcomeSubmit(): void {
    if (!hasShareableName(welcomeNameValue)) return; // defense-in-depth; the button is already disabled (AC-CONTACT-5).
    // Persist the name locally BEFORE unblocking the add-effect below
    // (AC-CONTACT-4a). `profile.nickname` is a dependency of that effect, so
    // once it re-runs it reads the just-saved name — this is what lets the
    // pending-pairing-echo check (pendingIntent.ts, unchanged) satisfy its
    // existing name requirement inline instead of deferring to
    // `/profile?pairing=1` (AC-NAME-2). saveProfile only ever writes locally
    // — no broadcast, no new publish path (AC-PRIV-1).
    saveProfile({ ...profile, nickname: welcomeNameValue });
    setWelcomeConfirmed(true);
  }

  useEffect(() => {
    // `window` is always defined here in practice — React never runs effects
    // during the static export's build-time prerender pass, so this can only
    // fire client-side. The guard is still explicit (matches this repo's
    // convention, e.g. DirectMessageNotificationsWatcher.tsx) and is what
    // makes `readLocationHash`'s `undefined` branch a real, tested case
    // rather than a check that never differs (VQ-S7-001).
    if (settledRef.current) return;
    // Epic: first-visit-invite-welcome, story S3 (AC-CONTACT-1). Hold off:
    // the newcomer is looking at the welcome screen and hasn't submitted a
    // name yet. `processContactInput` (via resolveAddDeepLink) must not run
    // until they do — this is what keeps the add from completing silently
    // ahead of the welcome screen's own action.
    if (showContactWelcome) return;
    const hash = readLocationHash(typeof window === 'undefined' ? undefined : window);
    const result = resolveAddDeepLink(hash, hydrated, pubkeyHex);
    setOutcome(result);
    if (result.state === 'awaiting_identity') return;
    settledRef.current = true;
    if (result.state !== 'complete') return;

    if (result.ok) {
      // Mirrors AddContactModal.tsx's handleAdd — bump the revision so the
      // always-mounted watchers refresh their cached knownPeers ref
      // immediately instead of waiting for an unrelated change.
      notifyKnownPeersChanged();

      // Epic: contact-pairing-code, story S4 (RD-7). A v2 code with an
      // unexpired pairing field carries a reciprocation candidate —
      // `processContactInput`'s pure decision, computed above. Route it
      // through the SAME persist-then-attempt core the retry queue uses
      // (attemptOrQueuePairingEcho), so an interrupted send can never be
      // lost (AC-SCAN-3): the intent is durably persisted before this
      // effect ever awaits the network.
      const pairingEcho = result.pairingEcho;
      if (pairingEcho && pubkeyHex && privateKeyHex) {
        const ctx = buildPendingIntentSendContext(pubkeyHex, privateKeyHex, profile.nickname);
        void attemptOrQueuePairingEcho(pairingEcho, ctx)
          .catch(() => 'queued-for-retry' as const)
          .then((status) => {
            if (status === 'deferred') {
              // AC-SCAN-5: nameless scanner — route to name setup BEFORE
              // landing on the issuer's contact. The intent is already
              // durably persisted; the deferred echo fires automatically
              // once a name is saved (profile.tsx's saveProfile
              // chokepoint, AC-SCAN-6) or on a later online/mount drain.
              router.replace(`/profile?pairing=1&issuer=${pairingEcho.issuerPubkeyHex}`);
            } else if (status === 'expired') {
              // The card's expiresAt lapsed in the moments between the
              // synchronous parse and this async attempt (an extremely
              // narrow race) — degrade exactly like AC-SCAN-2's plain
              // expired-code path: no pairing query param, no honesty copy.
              router.replace(`/contacts?id=${result.pubkeyHex}&added=1`);
            } else {
              // 'sent' | 'queued-for-retry' — the add itself already
              // succeeded regardless of echo outcome; a failed send
              // retries later (AC-SCAN-3) and never blocks this UX.
              router.replace(
                `/contacts?id=${result.pubkeyHex}&added=1&pairing=${status === 'sent' ? 'sent' : 'pending'}`,
              );
            }
          });
      } else {
        // Success is not shown here: hand off to the contacts page with the
        // new contact selected and let it render the green confirmation.
        // `replace` keeps this /add hop out of history (AC: omit intermediary).
        router.replace(`/contacts?id=${result.pubkeyHex}&added=1`);
      }
      return;
    }

    // A RETURNING scanner — `already_exists` because the contact already
    // existed (a one-directional contact from before this epic, a peer from a
    // shared group, or simply a reload of the same card). This is NOT a
    // dead-end: land them on that contact's DM page, exactly the destination a
    // fresh add reaches, so re-opening a known contact's card always takes you
    // to the chat. `&exists=1` (never `&added=1`, since nothing was newly
    // added) tells the contact page to surface the informative "already in
    // your contacts" banner over the DM instead of the green "Contact added"
    // confirmation.
    //
    // Epic: block-contact, story S4 (AC-VIEW-13). Gated on `!result.blocked`:
    // a blocked re-add is a full cut-off in both directions (DD-2) with no DM
    // to open, so it falls through to the existing already_exists error alert
    // rendered below. processContactInput never carries `pubkeyHex` for a
    // blocked result, so `result.pubkeyHex` also fails here — the `!blocked`
    // guard is defense-in-depth, making the invariant visible at this call
    // site rather than resting solely on the upstream suppression.
    if (result.error === 'already_exists' && !result.blocked && result.pubkeyHex) {
      const targetPubkeyHex = result.pubkeyHex;
      // Epic: contact-pairing-code, story S4 (RD-7). A v2 code with an
      // unexpired pairing field must still reciprocate on this
      // returning-scanner path — routed through the SAME durable
      // persist-then-attempt core as a fresh add so an interrupted send is
      // never lost (AC-SCAN-3). `result.pairingEcho` is only ever populated
      // for exactly this branch (processContactInput.ts).
      const pairingEcho = result.pairingEcho;
      if (pairingEcho && pubkeyHex && privateKeyHex) {
        const ctx = buildPendingIntentSendContext(pubkeyHex, privateKeyHex, profile.nickname);
        void attemptOrQueuePairingEcho(pairingEcho, ctx)
          .catch(() => 'queued-for-retry' as const)
          .then((status) => {
            if (status === 'deferred') {
              // AC-SCAN-5: nameless scanner — route to name setup BEFORE
              // landing on the issuer's contact, identical to the fresh-add
              // deferred branch. The intent is already durably persisted; the
              // echo fires once a name is saved (profile.tsx's saveProfile
              // chokepoint, AC-SCAN-6) or on a later online/mount drain.
              router.replace(`/profile?pairing=1&issuer=${pairingEcho.issuerPubkeyHex}`);
            } else {
              // 'sent' | 'queued-for-retry' | 'expired' — the reciprocation
              // outcome never blocks the UX; land on the DM regardless.
              router.replace(`/contacts?id=${targetPubkeyHex}&exists=1`);
            }
          });
      } else {
        router.replace(`/contacts?id=${targetPubkeyHex}&exists=1`);
      }
      return;
    }
  }, [hydrated, pubkeyHex, privateKeyHex, profile.nickname, notifyKnownPeersChanged, router, showContactWelcome]);

  function getErrorMessage(errorCode: string | undefined): string {
    switch (errorCode) {
      case 'invalid_npub':
        return copy.contacts.addContactErrorInvalidNpub;
      case 'self':
        return copy.contacts.addContactErrorSelf;
      case 'already_exists':
        return copy.contacts.addContactErrorAlreadyExists;
      case 'unsupported_version':
        return copy.contacts.addContactErrorUnsupportedVersion;
      default:
        return copy.contacts.addContactErrorGeneric;
    }
  }

  // Epic: first-visit-invite-welcome, story S3. A first-time visitor with a
  // contact card in the URL sees the blended welcome screen INSTEAD of the
  // page's normal chrome below (no "setting up…" spinner, no "Add contact"
  // heading/"Go to Contacts" link — there's no contact yet to navigate to).
  // AC-CONTACT-2/3: `inviterName === null` renders no invite line at all
  // (WelcomeInviteProps' documented contract) while the pitch, name input,
  // and action still render.
  if (showContactWelcome) {
    return (
      <>
        <Head>
          <title>{`${copy.add.pageTitle} - ${copy.appName}`}</title>
        </Head>
        <WelcomeInvite
          inviteLine={inviterName !== null ? copy.welcome.contactInviteLine(inviterName) : null}
          nameValue={welcomeNameValue}
          onNameChange={setWelcomeNameValue}
          primaryActionLabel={copy.welcome.contactPrimaryAction}
          primaryActionDisabled={!hasShareableName(welcomeNameValue)}
          onPrimaryAction={handleContactWelcomeSubmit}
        />
      </>
    );
  }

  // A non-blocked `already_exists` re-add is navigated to the contact's DM
  // page by the effect above (with `&exists=1`, where the contact page shows
  // the informative "already in your contacts" banner), exactly like a fresh
  // add navigates on — so it must show the same brief "redirecting" state
  // here, never the dead-end already_exists error alert. A blocked re-add
  // carries no `pubkeyHex` and still falls through to that alert.
  const isRedirectingReAdd =
    outcome !== null &&
    outcome.state === 'complete' &&
    !outcome.ok &&
    outcome.error === 'already_exists' &&
    !outcome.blocked &&
    !!outcome.pubkeyHex;

  let body: JSX.Element;
  if (outcome === null || outcome.state === 'awaiting_identity') {
    body = (
      <VStack spacing={4} py={10} data-testid="add-page-setting-up">
        <Spinner />
        <Text color="textMuted">{copy.add.settingUp}</Text>
      </VStack>
    );
  } else if (outcome.state === 'complete' && (outcome.ok || isRedirectingReAdd)) {
    // Add succeeded (or a known contact was re-opened) — the effect is
    // navigating to /contacts?id=… . Show a brief redirecting state rather
    // than a terminal success/error alert; a fresh add's green confirmation
    // is rendered on the contacts page.
    body = (
      <VStack spacing={4} py={10} data-testid="add-page-redirecting">
        <Spinner />
        <Text color="textMuted">{copy.add.redirecting}</Text>
      </VStack>
    );
  } else if (outcome.state === 'no_card') {
    body = (
      <Alert status="warning" borderRadius="md" data-testid="add-page-no-card">
        <AlertIcon />
        <AlertDescription>{copy.add.noCard}</AlertDescription>
      </Alert>
    );
  } else {
    body = (
      <Alert status="error" borderRadius="md" data-testid="add-page-error">
        <AlertIcon />
        <AlertDescription>{getErrorMessage(outcome.error)}</AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      <Head>
        <title>{`${copy.add.pageTitle} - ${copy.appName}`}</title>
      </Head>
      <Box data-testid="add-page" maxW="480px" mx="auto">
        <Heading as="h1" size="lg" mb={4}>
          {copy.add.heading}
        </Heading>
        {body}
        <Box mt={6}>
          <NextLink href="/contacts" passHref legacyBehavior>
            <Button as="a" variant="ghost" size="sm" data-testid="add-page-go-to-contacts">
              {copy.add.goToContacts}
            </Button>
          </NextLink>
        </Box>
      </Box>
    </>
  );
}
