import React, { useCallback, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalOverlay,
  Text,
} from '@chakra-ui/react';
import { useRouter } from 'next/router';
import { useCopy } from '@/src/context/LanguageContext';
import ThemeIcon from '@/src/components/ThemeIcon';
import NpubQrScanner from '@/src/components/groups/NpubQrScanner';
import { resolveScanDestination } from '@/src/lib/qr';

/**
 * Mobile bottom-bar scanner tab that opens the camera scanner
 * (epic: mobile-qr-scanner, story S2). Rendered as a centered slot INSIDE
 * the bottom tab bar's list (between the two domain tabs) by Layout.tsx —
 * NOT added to `navItems`, because that array drives BOTH the bottom bar
 * AND the hamburger overlay, so joining it would leak the scanner into the
 * hamburger (AC-FAB-3). Placement inside the bar's `!hideBottomNav` /
 * `md:none` container is what gates its visibility (AC-FAB-1/AC-FAB-4) —
 * it no longer carries its own route/breakpoint gate.
 *
 * Presented as a peer of the domain tabs (themed scan icon + label) rather
 * than a floating action button, so it reads as part of the native-feeling
 * tab bar instead of hovering over it.
 *
 * A decoded value is classified via the QR lib's `resolveScanDestination`
 * seam (S1): a match navigates and closes the scanner (AC-SCAN-2); a
 * rejection shows the unrecognised-link message and keeps scanning
 * (AC-SCAN-3) — no intermediate confirmation step either way.
 *
 * Wires `NpubQrScanner` via its additive `onRawScan` prop rather than the
 * default `onScan`/`normaliseScanPayload` gate: that gate only recognises
 * card/npub shapes and would silently reject every group-invite QR before
 * ever handing it to this component. `onRawScan` hands over every decoded
 * raw string unfiltered, so `resolveScanDestination` — not `NpubQrScanner`
 * — is the sole classification authority.
 */
export default function QrScanFab() {
  const copy = useCopy();
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [rejected, setRejected] = useState(false);

  const handleOpen = useCallback(() => {
    setRejected(false);
    setIsOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setRejected(false);
  }, []);

  const handleRawScan = useCallback(
    (raw: string): boolean => {
      const destination = resolveScanDestination(raw);
      if (destination) {
        setRejected(false);
        setIsOpen(false);
        // Scanning a card link while already sitting on /add must re-run
        // add.tsx's deep-link effect (gated on `settledRef`, deps excl. the
        // hash) from a clean mount, or the modal closes with nothing else
        // happening (gate-remediation Finding 1). A bare hash change never
        // does that: a same-document hash navigation doesn't remount the
        // page, and the effect's deps deliberately exclude the hash, so it
        // never re-runs on its own. The /groups same-page case does NOT
        // need this: pages/groups.tsx reads `router.query.join/.admin/.name`
        // inline in render (no settled ref), so a query-changing
        // `router.push` while already on /groups re-renders and picks up
        // the new invite normally.
        //
        // Gate-remediation Finding B (epic mobile-qr-scanner): whether
        // `assign(destination)` alone triggers a real document reload
        // depends entirely on whether `destination`'s path is BYTE-IDENTICAL
        // to the live `window.location.pathname` — the browser treats any
        // difference (including a bare trailing slash, e.g. live `/add/`
        // vs. destination `/add#c=...`) as a genuine cross-document
        // navigation, and only an exact match as a same-document,
        // never-reloading hash change. Today `destination` has no trailing
        // slash while `trailingSlash: true` normalizes the live URL to
        // `/add/`, so `assign()` alone happens to force a real navigation —
        // but that's incidental to the current string shapes, not to *why*
        // this branch exists, and it would silently break (dead-end again)
        // if `destination` is ever canonicalized to `/add/#c=...`. Compare
        // the live pathname (captured before navigating) against the
        // destination's parsed pathname and force `reload()` ourselves only
        // in the exact-match case. Calling `reload()` unconditionally is
        // NOT safe: verified empirically that when the paths genuinely
        // differ, `assign()` already kicks off an async cross-document
        // navigation, and an immediate `reload()` races it and reloads the
        // OLD document instead — silently cancelling the intended
        // navigation to the new invite.
        if (router.pathname === '/add' && destination.startsWith('/add')) {
          const currentPath = window.location.pathname;
          const destinationPath = new URL(destination, window.location.href).pathname;
          window.location.assign(destination);
          if (destinationPath === currentPath) {
            window.location.reload();
          }
        } else {
          void router.push(destination);
        }
        return true;
      }
      setRejected(true);
      return false;
    },
    [router],
  );

  return (
    <>
      {/* Centered tab slot — mirrors the domain-tab markup in Layout.tsx's
          bottom bar (Box as="li" flex="1", column icon + 2xs label) so the
          scanner reads as a peer tab, not a floating overlay. Visibility is
          owned by the enclosing bar (`!hideBottomNav`, `md:none`). */}
      <Box as="li" flex="1">
        <Box
          as="button"
          type="button"
          onClick={handleOpen}
          aria-label={copy.scanner.fabAriaLabel}
          data-testid="qr-scan-fab"
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          gap={0.5}
          py={2}
          w="100%"
          bg="transparent"
          color="textMuted"
          _hover={{ color: 'brand.500' }}
          _active={{ color: 'brand.500' }}
        >
          <ThemeIcon name="scan" size={22} aria-hidden />
          <Text fontSize="2xs">{copy.scanner.tabLabel}</Text>
        </Box>
      </Box>

      <Modal isOpen={isOpen} onClose={handleClose} isCentered size="md">
        <ModalOverlay />
        {/* No visible header or hint text: a live camera viewfinder is a
            self-explanatory "scan" affordance (project UI rule — keep info
            texts to a minimum). `aria-label` keeps the dialog an accessible
            name for screen readers without rendering a heading. */}
        <ModalContent data-testid="qr-scan-fab-modal" aria-label={copy.scanner.title}>
          <ModalCloseButton />
          <ModalBody pt={10} pb={6}>
            {rejected && (
              <Alert status="warning" borderRadius="md" mb={4} data-testid="qr-scan-unrecognised">
                <AlertIcon />
                <AlertDescription>{copy.scanner.unrecognisedLink}</AlertDescription>
              </Alert>
            )}
            <NpubQrScanner
              invalidPayloadMessage={copy.scanner.unrecognisedLink}
              permissionDeniedMessage={copy.scanner.permissionDenied}
              unavailableMessage={copy.scanner.unavailable}
              startingMessage={copy.scanner.startingCamera}
              onRawScan={handleRawScan}
            />
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
