/**
 * Unit tests for the imprint-footer visibility decision
 * (`app/src/components/Layout.tsx`'s `shouldHideImprintFooter`).
 *
 * `Layout.tsx` is a component (Chakra/Next imports) — this repo has no
 * jsdom/@testing-library/renderHook precedent (see testing.md conventions),
 * so the decision worth testing directly is extracted into an exported pure
 * function, mirroring `groups.tsx`'s `shouldRedirectToGroupsList` extraction
 * (`app/tests/unit/pages/groupsManageLinksDeepLink.test.ts`). React is not
 * mounted here.
 *
 * Behavior: the footer is hidden ONLY on the two open-chat pages — the
 * direct-message thread (`/contacts?id=…`) and the group chat
 * (`/groups?id=…`). Every other page, including the two LIST views (same
 * routes, no `id`), keeps it.
 */
import { describe, it, expect } from 'vitest';
import { shouldHideImprintFooter } from '@/src/components/Layout';

describe('shouldHideImprintFooter', () => {
  it('hides the footer on the open DM thread (/contacts with id)', () => {
    expect(shouldHideImprintFooter('/contacts', 'deadbeef')).toBe(true);
  });

  it('hides the footer on the open group chat (/groups with id)', () => {
    expect(shouldHideImprintFooter('/groups', 'abc123')).toBe(true);
  });

  it('keeps the footer on the contacts LIST view (no id)', () => {
    expect(shouldHideImprintFooter('/contacts', undefined)).toBe(false);
  });

  it('keeps the footer on the groups LIST view (no id)', () => {
    expect(shouldHideImprintFooter('/groups', undefined)).toBe(false);
  });

  it('keeps the footer on other pages even when an id is present', () => {
    expect(shouldHideImprintFooter('/', 'deadbeef')).toBe(false);
    expect(shouldHideImprintFooter('/profile', 'deadbeef')).toBe(false);
    expect(shouldHideImprintFooter('/settings', 'x')).toBe(false);
  });

  it('does not hide for the group invite/join routes (no id param)', () => {
    // `/groups?invite=…` and `/groups?join=…` are not chat pages; only `id`
    // opens the detail/chat view.
    expect(shouldHideImprintFooter('/groups', undefined)).toBe(false);
  });

  it('treats a repeated id query param (string[]) as an addressed chat', () => {
    expect(shouldHideImprintFooter('/contacts', ['a', 'b'])).toBe(true);
    // An empty array carries no id, so the footer stays.
    expect(shouldHideImprintFooter('/contacts', [])).toBe(false);
  });

  it('keeps the footer on the imprint page itself', () => {
    expect(shouldHideImprintFooter('/imprint', undefined)).toBe(false);
  });
});
