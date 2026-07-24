# Mobile QR-Code Scanner

**Status**: pre-implementation

## Problem

few.chat produces shareable QR codes for its externally-addressable links —
contact/pairing cards (`https://few.chat/add#c=…`) and group invites
(`https://few.chat/groups/?join=…&admin=…&name=…`). Today a user can *show* a QR
(display-mode `NpubQrModal` on the contact-share and settings screens) but there
is **no live way to scan one**. The camera-scan half of the infrastructure —
`NpubQrScanner`, `normaliseScanPayload`, the `qr-scanner` dependency — is fully
built and unit-tested but has zero production callers: `mode="scan"` is never
instantiated anywhere in the app.

The result is an asymmetric flow: to add a contact or join a group by QR, the
receiving user must fall back to an external camera app that opens the link in a
browser, rather than scanning inside few.chat. On mobile — the only place a
rear camera and physical QR co-location make scanning natural — there is no
entry point at all.

## Solution

Add a **mobile-only** QR-scanner entry point: an elevated circular
floating-action button (FAB) centered above the bottom tab bar. Tapping it opens
the existing camera scanner. A decoded payload is classified as one of the
few.chat link shapes and the user is navigated straight to the same destination
URL the corresponding QR *generator* produces — reusing each destination page's
existing deep-link resolution (welcome/confirmation/join UX) rather than
inventing a new route. Anything that is not a recognised few.chat link is
rejected in-scanner with a clear message; the camera keeps scanning.

The FAB is deliberately **not** added to `navItems` (which drives both the bottom
bar and the hamburger overlay), so it never appears in the hamburger menu. It is
desktop-invisible (Chakra `base`/`md` responsive gating, matching every other
mobile-only surface in `Layout.tsx`).

## Scope

### In Scope

- A mobile-only, bottom-center elevated FAB entry point rendered from
  `Layout.tsx`, gated to the mobile breakpoint and to the same route-visibility
  rule as the bottom tab bar (hidden on open-chat routes where the composer owns
  the bottom of the viewport).
- Opening the existing `NpubQrScanner` (camera decode) from the FAB.
- A pure classification+routing seam that accepts exactly two few.chat link
  shapes — contact/pairing card and group invite — and rejects everything else,
  resolving each accepted shape to the destination URL its generator produces.
- Navigating straight to the resolved destination on a successful scan
  (no intermediate in-scanner confirmation).
- Camera-unavailable / permission-denied / invalid-payload feedback surfaced in
  the scanner UI.
- New i18n copy (EN + DE) under a dedicated `scanner` namespace (the app-wide
  scanner is not group-scoped, so it does not reuse the `groups.*` QR keys).

### Out of Scope

- Any desktop scanner entry point.
- Adding the scanner to the hamburger menu, the header, or `navItems`.
- New QR **generation** surfaces (display-mode is unchanged).
- Accepting link shapes the app does not itself generate as external QRs
  (internal `?invite=` / `?id=` / `?manageLinks=` deep links, bare group ids).
- A generic/extensible link-registry abstraction — the classifier handles the
  two shapes that exist today with a clean two-branch dispatch, not a plugin
  system.
- Changing how the destination pages (`/add`, `/groups`) resolve their deep
  links — the scanner routes to the existing URLs unchanged.

## Design Decisions

- **DD1 — Route to generator URLs, don't re-implement resolution.** The scanner
  `router.push`es to `/add#c=<payload>` for cards and
  `/groups?join=…&admin=…&name=…` for group invites — the exact URLs
  `buildShareUrl` (`contactCard.ts`) and `buildInviteUrl`
  (`inviteLinkGeneration.ts`) emit. `add.tsx` and `groups.tsx` already own the
  inbound resolution; the scanner reuses it rather than duplicating parse/verify
  logic. (Chosen behavior: navigate straight to destination.)

- **DD2 — Card validation reuses `normaliseScanPayload`.** The contact-card
  branch delegates decode + signature verification to the existing
  `normaliseScanPayload` (`qr.ts:40`) → `parseContactCard` seam. A card whose
  signature fails to verify is rejected, never downgraded. No new card-parsing
  code.

- **DD3 — Group-invite validation is new, minimal, and pattern-based.** A
  group-invite URL is recognised structurally: an absolute URL whose pathname is
  the `/groups/` invite path and which carries a well-formed `join` nonce, a
  valid `admin` npub, and a `name`. This lives beside `normaliseScanPayload` in
  the QR lib. It validates shape only — the actual join is `groups.tsx`'s job
  once navigated. Origin is **not** pinned to `few.chat` (invite links are built
  from the live `window.location.origin`, so a self-hosted/branded deployment
  must scan its own invites); the `/groups/` path + required params are the
  discriminator.

- **DD4 — Elevated FAB, not a bar slot.** The entry point is its own fixed
  element centered horizontally and raised above the bottom bar's z-index (bar is
  `zIndex 10`), visually distinct from the two nav tabs. It bypasses `navItems`
  entirely so it stays out of the hamburger.

- **DD5 — Privacy invariant is preserved by construction.** QR decoding is local
  (camera → `qr-scanner`, in-page). Navigating to `/add` or `/groups` triggers
  only the existing, already-audited flows. No profile metadata is published;
  this feature adds no relay writes. (See `CLAUDE.md` privacy invariant.)

- **DD6 — Reject non-few.chat QRs, keep scanning.** A decoded value that is
  neither a valid card nor a valid group invite produces an "unrecognised link"
  message and the scanner continues; it never navigates and never surfaces raw
  scanned content.

## Technical Approach

### New: scan classification + routing (`app/src/lib/`)

A pure function — call it `resolveScanDestination(value: string): string | null`
(placed in `qr.ts` or a sibling `scanRouting.ts`) — that:

1. Tries the card branch: `normaliseScanPayload(value)` → on success returns
   `` `/add#c=${payload}` `` (or the app's canonical card deep-link path).
2. Tries the group-invite branch: parse `value` as a URL; require the `/groups/`
   invite pathname and valid `join` (hex nonce), `admin` (npub via
   `npubToPubkeyHex`), and non-empty `name`; on success return the normalised
   `/groups?join=…&admin=…&name=…` path.
3. Returns `null` otherwise.

Fully unit-testable (no DOM), mirroring the existing `qr.test.ts` /
`qr.mutation-gaps.test.ts` precedent. This is the load-bearing behavioral seam.

### New: mobile FAB entry point (`app/src/components/…`, wired in `Layout.tsx`)

- A `QrScanFab` component (or an inline block in `Layout.tsx` analogous to the
  bottom-nav block at ~617–691) rendered as a fixed, horizontally-centered,
  elevated button, `display={{ base: 'flex', md: 'none' }}`, gated by the same
  `!hideBottomNav` predicate as the bottom bar, `zIndex` above the bar, honoring
  `env(safe-area-inset-bottom)`.
- Not added to `navItems`.
- On tap, opens the scanner. Reuse `NpubQrScanner` directly, or `NpubQrModal`
  with `mode="scan"` — whichever gives the cleanest app-wide (non-group) framing.
  Guard with `canUseCameraQrScanner()`; on camera-unavailable /
  permission-denied, show the corresponding message.
- On a decoded value, call `resolveScanDestination`; if non-null, `router.push`
  to it and close the scanner; if null, show the unrecognised-link message and
  keep scanning.

### i18n (`app/src/lib/i18n.ts`)

- New `scanner` namespace: FAB aria-label, scanner title/hint, starting-camera,
  camera-permission-denied, unavailable, unrecognised-link. EN + DE. The existing
  dead `groups.qr*` / `scanQr` keys are left untouched (out of scope to remove).

## Stories

- **S1 — Scan classification & destination routing (lib).** Implement
  `resolveScanDestination` and the new group-invite validator beside the existing
  card seam. Pure, fully unit-tested: accepts a valid contact card and a valid
  group invite, rejects bare/invalid npub-only values that aren't cards,
  malformed group-invite URLs, signature-failing cards, and arbitrary non-few.chat
  URLs/text. Owning module: QR lib.

- **S2 — Mobile FAB scanner entry point (UI).** Add the elevated bottom-center
  mobile-only FAB in `Layout.tsx`, excluded from `navItems`/hamburger, gated to
  the bottom-bar visibility rule; open the camera scanner; route decoded payloads
  via S1's resolver straight to the destination; handle
  camera-unavailable/permission-denied/unrecognised-link; add the `scanner` i18n
  namespace (EN + DE). Owning module: Layout / navigation UI.

## Non-Goals

- No desktop entry point, no hamburger entry, no header entry.
- No new QR generation.
- No extensible/plugin link registry.
- No change to `/add` or `/groups` inbound resolution.
- No relay writes / no profile broadcast (privacy invariant).

## Amendments

- **2026-07-24 — AC-ROUTE-5 tightened (scheme/domain-wrapper marker bypass).**
  S1's card branch originally gated only on the `#c=` marker being present.
  Review (Codex P2, "arbitrary-domain URL embedding a valid `#c=` payload
  accepted") found that any URL — including a non-http(s) scheme such as
  `nostr:` or `ftp:`, or an http(s) URL on an unrelated domain/pathname —
  that merely carried a `#c=` fragment was wrongly treated as a card. The
  fix (`app/src/lib/qr.ts`) requires the card branch to be an absolute
  http(s) URL scoped to the `/add` or `/add/` pathname before the marker is
  considered; AC-ROUTE-5 now states this explicitly rather than leaving it
  implicit in the implementation. Regression tests:
  `app/tests/unit/qr-scan-destination.test.ts` — "rejects an arbitrary-domain
  URL whose fragment embeds an otherwise-valid card payload" and "rejects a
  non-http scheme (ftp://) embedding a valid #c= payload".

## Manual Validation

| ID | Criterion | Gap evidence | Owner | Adjudicated |
|----|-----------|--------------|-------|-------------|
| MV-1 | On a physical mobile device, the rear camera opens from the FAB and a real few.chat contact-card QR scans and lands on the add-contact flow. | The project's e2e convention forbids driving a real camera (scanner specs simulate via `page.goto('/add#c=…')`); `qr-scanner`/`getUserMedia` cannot be exercised headlessly. Cheapest automated alternative — a unit test of `resolveScanDestination` — covers routing but not the live camera→decode→navigate path. |  |  |
