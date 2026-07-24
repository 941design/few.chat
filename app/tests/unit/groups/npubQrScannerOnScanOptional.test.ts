// app/tests/unit/groups/npubQrScannerOnScanOptional.test.ts
//
// Regression coverage for a gate-remediation finding (epic: mobile-qr-scanner,
// story S2, post-ship review — correctness, severity 6):
//
// `QrScanFab.tsx` used to pass `onScan={() => {}}` to `NpubQrScanner` as a
// required-prop placeholder. That inline arrow is a fresh function identity
// on every `QrScanFab` render, and `NpubQrScanner`'s camera-lifecycle
// `useEffect` (NpubQrScanner.tsx ~line 149) lists `onScan` in its dependency
// array — so any unrelated parent re-render (hamburger toggle, theme change,
// async banner completion, or even the fab's own `setRejected(true)` on an
// unrecognised scan) tore the live camera down and restarted it mid-scan.
//
// The fix makes `onScan` optional and lets `QrScanFab` omit it entirely,
// since it always supplies `onRawScan` instead and the two paths are
// mutually exclusive (see the `onRawScan` branch in NpubQrScanner.tsx).
// `undefined` is referentially stable across renders, so the effect no
// longer restarts on an unrelated re-render.
//
// This repo has no jsdom / @testing-library/react (see npubQrModal.test.ts's
// precedent) and no renderHook equivalent — `NpubQrScanner` is a function
// component that calls `useState`/`useEffect`/`useRef`, so invoking it
// directly outside of React's render cycle throws "Invalid hook call"
// rather than proving anything about effect-dependency stability. A true
// mount/re-render assertion (spy on `qr-scanner`'s `start`/`stop` across a
// re-render with a stable `onRawScan` and no `onScan`) is therefore not
// feasible at this repo's unit-test level; that behavior is covered by the
// e2e suite (tests/e2e/mobile-qr-scanner-fab.spec.ts) driving a real scan.
//
// What IS feasible and load-bearing at the unit level: proving `onScan` is
// actually optional in the type contract (not just at one call site) and
// that omitting it is a legitimate props shape, not an accidental `any`.
// `ComponentProps<typeof NpubQrScanner>` pulls the type directly off the
// component's real prop type — if a future change reverts `onScan` back to
// required, this file fails `tsc --noEmit` (the gate this story's Makefile
// target runs), independently of whether it's ever executed as a runtime
// test.
import { describe, expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import NpubQrScanner from '@/src/components/groups/NpubQrScanner';

type NpubQrScannerProps = ComponentProps<typeof NpubQrScanner>;

describe('NpubQrScanner props contract — onScan is optional (gate-remediation regression, mobile-qr-scanner S2)', () => {
  it('type-checks with onScan omitted, mirroring QrScanFab (the sole live caller, which only supplies onRawScan)', () => {
    // If `onScan` were ever reverted to required, this object literal would
    // fail to satisfy `NpubQrScannerProps` and `tsc --noEmit` would fail —
    // that is the regression guard, independent of the runtime assertion
    // below.
    const props: NpubQrScannerProps = {
      invalidPayloadMessage: 'invalid',
      permissionDeniedMessage: 'denied',
      unavailableMessage: 'unavailable',
      hint: 'hint',
      onRawScan: () => true,
      // onScan intentionally omitted.
    };

    expect(props.onScan).toBeUndefined();
    expect(props.onRawScan?.('anything')).toBe(true);
  });

  it('still accepts onScan when a future scan-mode caller wants the legacy normaliseScanPayload path', () => {
    const calls: string[] = [];
    const props: NpubQrScannerProps = {
      invalidPayloadMessage: 'invalid',
      permissionDeniedMessage: 'denied',
      unavailableMessage: 'unavailable',
      hint: 'hint',
      onScan: (value) => {
        calls.push(value);
      },
    };

    props.onScan?.('npub1example');
    expect(calls).toEqual(['npub1example']);
  });
});
