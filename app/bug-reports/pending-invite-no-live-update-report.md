# Bug Report: Pending group invitation not shown live on arrival (only after reload)

## Description

A pending group invitation — surfaced both as the **Groups nav pill/badge** (bottom-nav
count) and as the **invitation group card** on `/groups` — is only displayed after the
recipient reloads the page. It does not appear when the invitation arrives while the app is
already open.

## Steps to reproduce

1. User **A** opens the application (lands on the home page `/`, or any route other than
   `/groups`) and stays idle.
2. User **B** invites A to a group (B sends the MLS Welcome; it is gift-wrapped kind-1059,
   addressed to A, and lands on the relay).
3. **Expected:** A is informed of the invitation immediately — the Groups nav pill count
   increments live, and if A opens `/groups` the invitation card is already there.
4. **Actual:** A sees nothing until a **full page reload**. After reload, both the pill and
   the invitation card render correctly.

## Expected vs actual

- **Expected:** live, no-reload update of the pending-invitation pill and card on arrival —
  matching how join-requests, pairing-acks, and contacts already update live in this app.
- **Actual:** stale until a full browser reload re-reads `localStorage` on module load.

## Impact

A recipient who has the app open but is not sitting on `/groups` (the common case — the app
opens on the home page) never learns of an incoming invitation until they happen to reload.
Invitations silently pile up in `localStorage` with no user-visible signal.

## Investigation notes (lead, pre-fix)

Confirmed by two code-explorers plus direct reads — hand these to the fixer as the starting map:

- **Arrival path:** `app/src/lib/marmot/welcomeSubscription.ts:756-1093` (`sub.on('event')`).
  An uncorrelated Welcome (kind 444) is enqueued at line **1068** via
  `enqueuePendingInvitation`, then the gift-wrap eventId is marked in `SEEN_KEY`
  (lines 1074-1080). The subscription is `{kinds:[1059], '#p':[pubkey]}`, `closeOnEose:false`,
  **no `since` bound**, started globally in `MarmotContext` init
  (`app/src/context/MarmotContext.tsx:1245-1382`), not tied to `/groups`.
- **Store:** `app/src/lib/pendingInvitations.ts` — a hand-rolled `useSyncExternalStore`
  source. `writeRaw` (133-142) sets a **new** `_snapshot` array reference and calls
  `_emit()` **synchronously**; the module-load block (244-250) seeds `_snapshot` from
  `localStorage` on every fresh load.
- **Consumers:** pill in `app/src/components/Layout.tsx:94-99,110`; card in
  `app/pages/groups.tsx:1100-1104,1266-1282`. Both subscribe via the same imported
  `subscribe`/`getSnapshot` from `@/src/lib/pendingInvitations`.
- **Key reasoning — why "reload fixes it" localizes the bug:** the invitation *does* reach
  `localStorage` during the live session (reload reads it back and the `SEEN_KEY` guard
  proves the live handler ran and enqueued). So the arrival→persist path works; the break is
  that the live `_emit()` does **not** produce a React re-render in the real, idle scenario.
- **Why existing e2e masks this:** the shared helper `createGroupAndInvite`
  (`app/tests/e2e/helpers/group-setup.ts:119-186`, used by ~19 specs) keeps the invitee on
  `/groups` and asserts `pending-invitations-section` with a **30s polling `toBeVisible`**
  *while MarmotContext is actively churning* (group creation/invite/reload). Per this
  codebase's own prior learning (`boolean-derived-beside-usesyncexternalstore`,
  high-confidence, few-chat), this exact reactivity class is *"invisible to non-jsdom unit
  tests and mutation testing … and MASKED in e2e by incidental re-renders from other
  contexts (MarmotContext/profile)."* An incidental re-render within the 30s window makes the
  section appear even if `_emit()`→re-render is itself broken. The user's failing scenario is
  **idle** (no other context churning) and **off `/groups`** (no card mounted), which the
  suite never exercises.
- **Candidate root causes to distinguish via runtime repro (do NOT assume):**
  1. `pendingInvitations` module-instance duplication — `welcomeSubscription.ts` (loaded via
     the `dynamic()` MarmotContext chunk) writes/emits on a different module instance than the
     one the components subscribed to (localStorage is shared, so reload masks it). This fits
     *every* symptom including determinism.
  2. `_emit()` fires but the `useSyncExternalStore` subscription/snapshot does not trigger a
     commit (snapshot-caching / subscribe-identity issue).
  3. A genuine startup-window race (subscription opens after B's publish and the relay does
     not replay) — least likely given no `since` bound and the deterministic user report.

## Source
Reported by the user via `/base:bug` on 2026-07-25.
