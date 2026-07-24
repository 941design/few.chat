import React, { useCallback, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  IconButton,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Text,
} from '@chakra-ui/react';
import { useRouter } from 'next/router';
import { useCopy } from '@/src/context/LanguageContext';
import NpubQrScanner from '@/src/components/groups/NpubQrScanner';
import { resolveScanDestination } from '@/src/lib/qr';

type QrScanFabProps = {
  /**
   * Same gate the mobile bottom tab bar uses (`!hideBottomNav` in
   * Layout.tsx) — the FAB shares that route-visibility predicate verbatim
   * rather than re-deriving it (AC-FAB-4).
   */
  hidden: boolean;
};

/**
 * Mobile-only floating action button that opens the camera scanner
 * (epic: mobile-qr-scanner, story S2). Deliberately rendered as a
 * standalone block from Layout.tsx rather than added to `navItems` — that
 * array drives BOTH the bottom tab bar AND the hamburger overlay, so
 * joining it would leak the scanner into the hamburger (AC-FAB-3).
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
export default function QrScanFab({ hidden }: QrScanFabProps) {
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

  if (hidden) return null;

  return (
    <>
      <IconButton
        onClick={handleOpen}
        aria-label={copy.scanner.fabAriaLabel}
        data-testid="qr-scan-fab"
        display={{ base: 'flex', md: 'none' }}
        position="fixed"
        bottom="calc(4.75rem + env(safe-area-inset-bottom))"
        left="50%"
        transform="translateX(-50%)"
        zIndex={20}
        borderRadius="full"
        w="56px"
        h="56px"
        minW="56px"
        bg="brand.500"
        color="white"
        boxShadow="lg"
        _hover={{ bg: 'brand.600' }}
        _active={{ bg: 'brand.600' }}
        icon={<Text fontSize="26px" lineHeight="1">📷</Text>}
      />

      <Modal isOpen={isOpen} onClose={handleClose} isCentered size="md">
        <ModalOverlay />
        <ModalContent data-testid="qr-scan-fab-modal">
          <ModalHeader>{copy.scanner.title}</ModalHeader>
          <ModalCloseButton />
          <ModalBody pb={6}>
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
              hint={copy.scanner.hint}
              onRawScan={handleRawScan}
            />
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
