// app/tests/unit/groups/cameraErrorClassification.test.ts
//
// Gate-remediation coverage (epic: mobile-qr-scanner, story S2) for
// AC-SCAN-1's camera-unavailable and permission-denied message branches in
// `NpubQrScanner.tsx`. Both branches are structurally correct but were
// e2e-unreachable: this repo's Playwright config always launches chromium
// with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`,
// so a real camera is always present and permission is always auto-granted
// — the catch block that distinguishes "permission denied" from "camera
// unavailable" never fires under e2e.
//
// `classifyCameraError` (exported from NpubQrScanner.tsx) is the pure
// extraction of that catch block's branch-selection logic. This repo has no
// jsdom / @testing-library / renderHook (see npubQrScannerOnScanOptional.test.ts's
// precedent and layoutImprintFooter.test.ts / npubQrModal.test.ts before it),
// so the component itself is never rendered here — only the extracted pure
// function is exercised directly.
import { describe, expect, it } from 'vitest';
import { classifyCameraError } from '@/src/components/groups/NpubQrScanner';

describe('classifyCameraError — permission-denied vs unavailable branch selection (AC-SCAN-1)', () => {
  it('classifies a NotAllowedError (name-based) as permission-denied', () => {
    const err = new Error('');
    err.name = 'NotAllowedError';
    expect(classifyCameraError(err)).toBe('permission-denied');
  });

  it('classifies a PermissionDeniedError (name-based) as permission-denied', () => {
    const err = new Error('');
    err.name = 'PermissionDeniedError';
    expect(classifyCameraError(err)).toBe('permission-denied');
  });

  it.each([
    ['Permission denied', 'message containing "denied"'],
    ['Camera permission is required', 'message containing "permission"'],
    ['NotAllowedError: dismissed', 'message containing "notallowed" (no space)'],
    ['The request was not allowed by the user agent', 'message containing "not allowed" (with space)'],
    ['PERMISSION DENIED', 'case-insensitive uppercase message'],
  ])('classifies a generic Error with %s as permission-denied (%s)', (message) => {
    expect(classifyCameraError(new Error(message))).toBe('permission-denied');
  });

  it('classifies a generic Error with an unrelated message as unavailable', () => {
    expect(classifyCameraError(new Error('Something went wrong'))).toBe('unavailable');
  });

  it('classifies a NotFoundError (no camera device) as unavailable', () => {
    const err = new Error('Requested device not found');
    err.name = 'NotFoundError';
    expect(classifyCameraError(err)).toBe('unavailable');
  });

  it('classifies an OverconstrainedError as unavailable', () => {
    const err = new Error('Constraints could not be satisfied');
    err.name = 'OverconstrainedError';
    expect(classifyCameraError(err)).toBe('unavailable');
  });

  it('classifies a non-Error throw as unavailable', () => {
    expect(classifyCameraError('boom')).toBe('unavailable');
    expect(classifyCameraError(undefined)).toBe('unavailable');
    expect(classifyCameraError({ message: 'permission denied' })).toBe('unavailable');
  });
});
