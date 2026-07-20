import { describe, it, expect } from 'vitest';
import { getCopy } from '@/src/lib/i18n';

/**
 * Epic: block-contact, story S5 (AC-COPY-1 through AC-COPY-6).
 *
 * Reconciliation note: AC-COPY-1/AC-COPY-2 name `copy.contacts.archiveAction`/
 * `unarchiveAction`, but no such keys exist or are consumed anywhere in the
 * app — the live archive/unarchive button (`app/pages/profile.tsx`) reads
 * `copy.profile.archiveAction`/`copy.profile.unarchiveAction`. This suite
 * asserts against the actual keys backing the user-visible surface
 * (`copy.profile.*`) rather than adding an orphan, unconsumed
 * `copy.contacts.archiveAction`/`unarchiveAction` pair.
 */
describe('block-contact copy relabel (S5)', () => {
  it('AC-COPY-1: profile.archiveAction resolves to Block contact / Kontakt blockieren', () => {
    expect(getCopy('en').profile.archiveAction).toBe('Block contact');
    expect(getCopy('de').profile.archiveAction).toBe('Kontakt blockieren');
  });

  it('AC-COPY-2: profile.unarchiveAction resolves to Unblock contact / Kontakt entsperren', () => {
    expect(getCopy('en').profile.unarchiveAction).toBe('Unblock contact');
    expect(getCopy('de').profile.unarchiveAction).toBe('Kontakt entsperren');
  });

  it('AC-COPY-3: contacts.hiddenBadge resolves to Blocked / Blockiert', () => {
    expect(getCopy('en').contacts.hiddenBadge).toBe('Blocked');
    expect(getCopy('de').contacts.hiddenBadge).toBe('Blockiert');
  });

  it('AC-COPY-4: contacts.archivedDetailNotice is destructive-blocked copy, distinct from the prior hidden-view wording, in both locales', () => {
    const en = getCopy('en').contacts.archivedDetailNotice;
    const de = getCopy('de').contacts.archivedDetailNotice;

    expect(en).toBeTruthy();
    expect(de).toBeTruthy();
    expect(en).not.toBe(de);
    expect(en).not.toMatch(/hidden from the default list view/i);
    expect(de).not.toMatch(/ausgeblendet.*einblendest/i);
    // Must communicate both the destructive (deletion) and blocking facts.
    expect(en).toMatch(/blocked/i);
    expect(en).toMatch(/deleted/i);
    expect(de).toMatch(/blockiert/i);
    expect(de).toMatch(/gelöscht/i);
  });

  it('AC-COPY-5: hidden-filter controls use "Blocked contacts" phrasing (en) and corresponding German phrasing (de)', () => {
    const en = getCopy('en').contacts;
    const de = getCopy('de').contacts;

    expect(en.hideHiddenOption).toBe('Hide blocked contacts');
    expect(en.showHiddenOption(0)).toBe('Show blocked contacts');
    expect(en.showHiddenOption(3)).toBe('Show blocked contacts (3)');
    expect(en.hiddenOnlyBody(1)).toBe('1 blocked contact is currently filtered out.');
    expect(en.hiddenOnlyBody(2)).toBe('2 blocked contacts are currently filtered out.');

    expect(de.hideHiddenOption).toBe('Blockierte Kontakte ausblenden');
    expect(de.showHiddenOption(0)).toBe('Blockierte Kontakte anzeigen');
    expect(de.showHiddenOption(3)).toBe('Blockierte Kontakte anzeigen (3)');
    expect(de.hiddenOnlyBody(1)).toBe('1 blockierter Kontakt wird aktuell ausgeblendet.');
    expect(de.hiddenOnlyBody(2)).toBe('2 blockierte Kontakte werden aktuell ausgeblendet.');

    // No prior "Hidden contacts" / "Versteckte Kontakte" wording remains.
    expect(en.hideHiddenOption).not.toMatch(/hidden/i);
    expect(en.showHiddenOption(0)).not.toMatch(/hidden/i);
    expect(de.hideHiddenOption).not.toMatch(/versteckt/i);
    expect(de.showHiddenOption(0)).not.toMatch(/versteckt/i);
  });

  it('AC-COPY-6: new confirm-dialog copy keys are present, non-empty, and distinct in both locales', () => {
    const en = getCopy('en').contacts;
    const de = getCopy('de').contacts;

    for (const key of ['blockConfirmTitle', 'blockConfirmBody', 'blockConfirmButton', 'blockCancelButton'] as const) {
      expect(typeof en[key]).toBe('string');
      expect(en[key].length).toBeGreaterThan(0);
      expect(typeof de[key]).toBe('string');
      expect(de[key].length).toBeGreaterThan(0);
      expect(en[key]).not.toBe(de[key]);
    }

    // The body must warn about both consequences: history deletion + blocking.
    expect(en.blockConfirmBody).toMatch(/delete/i);
    expect(en.blockConfirmBody).toMatch(/messaging|message/i);
    expect(de.blockConfirmBody).toMatch(/gelöscht/i);
    expect(de.blockConfirmBody).toMatch(/nachrichten/i);
  });
});
