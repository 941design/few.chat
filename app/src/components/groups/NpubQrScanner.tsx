import React, { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertIcon, Box, Spinner, Text, VStack } from '@chakra-ui/react';
import { canUseCameraQrScanner, normaliseScanPayload } from '@/src/lib/qr';
import { useCopy } from '@/src/context/LanguageContext';

/**
 * Classifies a camera-start failure (thrown by `qr-scanner`'s `scanner.start()`,
 * which itself surfaces `getUserMedia` rejections) into the two message
 * branches the catch block below chooses between (epic: mobile-qr-scanner,
 * story S2 gate-remediation). Extracted as a pure, exported function so the
 * branch selection is unit-testable without jsdom/renderHook (this repo has
 * neither — see `npubQrScannerOnScanOptional.test.ts`'s precedent), since
 * Playwright's `--use-fake-device-for-media-stream
 * --use-fake-ui-for-media-stream` flags mean this repo's e2e suite can never
 * exercise a real permission-denied or camera-unavailable rejection.
 *
 * Looks at both `name` and `message` (lowercased) — real `getUserMedia`
 * rejections are `DOMException`s whose `name` (e.g. `NotAllowedError`,
 * `PermissionDeniedError`) carries the signal, and browsers vary in whether
 * the `message` text also repeats it. A non-`Error` throw, or an `Error`
 * whose name/message carry neither signal (e.g. `NotFoundError`,
 * `OverconstrainedError`), classifies as `'unavailable'` — matching the
 * original inline `err.message.toLowerCase()`-only check byte-for-byte for
 * every shape that check could already distinguish.
 */
export function classifyCameraError(err: unknown): 'permission-denied' | 'unavailable' {
  if (!(err instanceof Error)) return 'unavailable';
  const haystack = `${err.name} ${err.message}`.toLowerCase();
  const denied =
    haystack.includes('denied') ||
    haystack.includes('permission') ||
    haystack.includes('notallowed') ||
    haystack.includes('not allowed');
  return denied ? 'permission-denied' : 'unavailable';
}

type NpubQrScannerProps = {
  invalidPayloadMessage: string;
  permissionDeniedMessage: string;
  unavailableMessage: string;
  hint: string;
  /**
   * Called with the validated, normalised scan payload — a bare npub OR (epic:
   * contact-card-exchange, story S4) a contact-card onboarding link / raw card
   * payload. `normaliseScanPayload` (qr.ts) is what accepts the wider set of
   * shapes; this callback still just carries a plain string, so callers parse it
   * (via `parseContactCard`) when they need the decoded pubkey/profile.
   *
   * Optional (epic: mobile-qr-scanner, story S2 gate-remediation): a caller
   * that supplies `onRawScan` never reaches this callback (see below), so it
   * has nothing to pass. Making it required forced `QrScanFab` to pass a
   * `() => {}` placeholder, and an inline arrow is a fresh function identity
   * on every render — since this prop sits in the camera-lifecycle effect's
   * dependency array below, that placeholder tore down and restarted the
   * live camera on every unrelated parent re-render. Omitting it is now the
   * stable choice; when omitted the effect dependency is `undefined`, which
   * is referentially stable across renders.
   */
  onScan?: (value: string) => void;
  /**
   * Additive, optional escape hatch (epic: mobile-qr-scanner, story S2).
   * When provided, the decode callback bypasses `normaliseScanPayload` /
   * `onScan` entirely and hands the raw decoded string straight to this
   * callback instead — `normaliseScanPayload` only recognises card/npub
   * shapes, so a caller that needs to classify a wider set of payloads
   * (e.g. also routing group-invite URLs) supplies its own classifier
   * here. Return `true` to stop the scanner (mirrors the existing
   * successful-match behavior); return `false` to keep scanning without
   * surfacing an error (mirrors the existing invalid-payload behavior,
   * minus the built-in error message — the caller owns that UI instead).
   *
   * This component renders only inside `NpubQrModal`'s `mode='scan'`
   * branch — the one production `NpubQrModal` usage (`ShareContactCard`)
   * passes `mode="display"` and never mounts the scanner at all, so
   * `QrScanFab` (S2) is currently the sole live caller, and it supplies
   * `onRawScan`. Omitting `onRawScan` preserves the legacy `onScan` /
   * `normaliseScanPayload` path below for any future scan-mode caller
   * that wants the built-in card/npub classification instead of its own.
   */
  onRawScan?: (raw: string) => boolean;
  /**
   * Additive, optional override for the "starting camera" overlay text
   * (epic: mobile-qr-scanner, story S2). Defaults to
   * `copy.groups.qrStartingCamera` when omitted, so existing callers that
   * don't pass this prop see byte-for-byte identical copy.
   */
  startingMessage?: string;
};

export default function NpubQrScanner({
  invalidPayloadMessage,
  permissionDeniedMessage,
  unavailableMessage,
  hint,
  onScan,
  onRawScan,
  startingMessage,
}: NpubQrScannerProps) {
  const copy = useCopy();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<{
    stop: () => void;
    destroy: () => void;
  } | null>(null);
  const handledRef = useRef(false);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canUseCameraQrScanner()) {
      setStarting(false);
      setError(unavailableMessage);
      return;
    }

    let mounted = true;

    async function startScanner() {
      try {
        const { default: QrScanner } = await import('qr-scanner');
        const video = videoRef.current;

        if (!video || !mounted) return;

        const hasCamera = await QrScanner.hasCamera();
        if (!hasCamera) {
          setError(unavailableMessage);
          setStarting(false);
          return;
        }

        const scanner = new QrScanner(
          video,
          (result: { data: string }) => {
            if (handledRef.current) return;

            if (onRawScan) {
              const handled = onRawScan(result.data);
              if (handled) {
                handledRef.current = true;
                scanner.stop();
              }
              return;
            }

            const scannedValue = normaliseScanPayload(result.data);
            if (!scannedValue) {
              setError(invalidPayloadMessage);
              return;
            }

            handledRef.current = true;
            scanner.stop();
            onScan?.(scannedValue);
          },
          {
            onDecodeError: () => {},
            preferredCamera: 'environment',
            highlightScanRegion: true,
            returnDetailedScanResult: true,
            maxScansPerSecond: 8,
          }
        );

        scannerRef.current = scanner;
        await scanner.start();

        if (!mounted) {
          scanner.stop();
          scanner.destroy();
          return;
        }

        setStarting(false);
      } catch (err) {
        const classification = classifyCameraError(err);
        setError(classification === 'permission-denied' ? permissionDeniedMessage : unavailableMessage);
        setStarting(false);
      }
    }

    void startScanner();

    return () => {
      mounted = false;
      handledRef.current = false;
      if (scannerRef.current) {
        scannerRef.current.stop();
        scannerRef.current.destroy();
        scannerRef.current = null;
      }
    };
  }, [invalidPayloadMessage, onScan, onRawScan, permissionDeniedMessage, unavailableMessage]);

  return (
    <VStack spacing={4} align="stretch">
      {error && (
        <Alert status="warning" borderRadius="md" data-testid="npub-qr-scan-error">
          <AlertIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Box
        position="relative"
        borderRadius="lg"
        overflow="hidden"
        bg="black"
        minH="280px"
        display="flex"
        alignItems="center"
        justifyContent="center"
      >
        <Box
          as="video"
          ref={videoRef}
          muted
          playsInline
          w="100%"
          h="100%"
          objectFit="cover"
          data-testid="npub-qr-video"
        />
        {starting && (
          <VStack
            data-testid="npub-qr-starting-overlay"
            spacing={3}
            position="absolute"
            inset={0}
            bg="rgba(0, 0, 0, 0.55)"
            color="white"
            justify="center"
          >
            <Spinner />
            <Text fontSize="sm">{startingMessage ?? copy.groups.qrStartingCamera}</Text>
          </VStack>
        )}
      </Box>

      <Text fontSize="sm" color="textMuted">
        {hint}
      </Text>
    </VStack>
  );
}
