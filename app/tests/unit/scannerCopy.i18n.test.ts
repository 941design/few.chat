import { describe, it, expect } from 'vitest';
import { getCopy } from '@/src/lib/i18n';

/**
 * Epic: mobile-qr-scanner, story S2 (AC-INTL-1) — every scanner-facing
 * string (FAB aria-label, scanner title/hint, starting-camera,
 * permission-denied, unavailable, unrecognised-link) lives under a
 * dedicated `scanner` i18n namespace with both `en` and `de` entries,
 * mirroring `addContactByNpub.i18n.test.ts`'s exact-string-assertion
 * precedent rather than a shape-only check — a placeholder/TODO string
 * would fail these assertions just as surely as a missing key would.
 */
describe('scanner i18n keys (mobile-qr-scanner FAB + camera scanner)', () => {
  it('English copy has all scanner namespace keys, non-empty and non-placeholder', () => {
    const en = getCopy('en');
    expect(en.scanner.fabAriaLabel).toBe('Scan QR code');
    expect(en.scanner.title).toBe('Scan QR Code');
    expect(en.scanner.hint).toBe('Point the camera at a few.chat contact card or group invite QR code.');
    expect(en.scanner.startingCamera).toBe('Starting camera...');
    expect(en.scanner.permissionDenied).toBe('Camera permission was denied.');
    expect(en.scanner.unavailable).toBe('QR scanning is unavailable on this device or browser.');
    expect(en.scanner.unrecognisedLink).toBe("This QR code isn't a few.chat contact card or group invite.");
  });

  it('German copy has all scanner namespace keys, non-empty and non-placeholder', () => {
    const de = getCopy('de');
    expect(de.scanner.fabAriaLabel).toBe('QR-Code scannen');
    expect(de.scanner.title).toBe('QR-Code scannen');
    expect(de.scanner.hint).toBe(
      'Richte die Kamera auf eine few.chat-Kontaktkarte oder einen Gruppeneinladungs-QR-Code.'
    );
    expect(de.scanner.startingCamera).toBe('Kamera wird gestartet...');
    expect(de.scanner.permissionDenied).toBe('Kamerazugriff wurde verweigert.');
    expect(de.scanner.unavailable).toBe('QR-Scan ist auf diesem Gerät oder Browser nicht verfügbar.');
    expect(de.scanner.unrecognisedLink).toBe(
      'Dieser QR-Code ist keine few.chat-Kontaktkarte oder Gruppeneinladung.'
    );
  });

  it('neither language leaves a scanner key empty or equal to a TODO/placeholder marker', () => {
    for (const lang of ['en', 'de'] as const) {
      const copy = getCopy(lang);
      for (const [key, value] of Object.entries(copy.scanner)) {
        expect(value, `${lang}.scanner.${key}`).not.toBe('');
        expect(value, `${lang}.scanner.${key}`).not.toMatch(/TODO|PLACEHOLDER/i);
      }
    }
  });
});
