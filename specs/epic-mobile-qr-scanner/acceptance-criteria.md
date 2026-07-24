# Acceptance Criteria — Mobile QR-Code Scanner

## S1 — Scan classification & destination routing (lib)

**AC-ROUTE-1** — Given a valid few.chat contact/pairing card value (a bare npub,
a `nostr:`-prefixed npub, a `https://few.chat/add#c=<payload>` link, or a raw
base64url card payload) that `parseContactCard` accepts, `resolveScanDestination`
returns the card deep-link destination (`/add#c=<payload>` form).

**AC-ROUTE-2** — Given a well-formed group-invite URL (pathname is the `/groups/`
invite path, with a valid hex `join` nonce, an `admin` value that decodes via
`npubToPubkeyHex`, and a non-empty `name`), `resolveScanDestination` returns the
`/groups?join=…&admin=…&name=…` destination, preserving all three parameters.

**AC-ROUTE-3** — A card value whose signature fails verification returns `null`
(rejected, never downgraded to a bare-pubkey pass).

**AC-ROUTE-4** — A group-invite-shaped URL missing any required parameter
(`join`, `admin`, or `name`), or with an `admin` that is not a valid npub, or a
`join` that is not a well-formed nonce, returns `null`.

**AC-ROUTE-5** — An arbitrary non-few.chat value (plain text, a random `https://`
URL, an empty string, a `/groups/` URL with no invite params) returns `null`.
This includes a value that carries a syntactically valid `#c=` card-payload
marker but is wrapped in a non-http(s) scheme (e.g. `nostr:`, `ftp:`) or whose
http(s) pathname is not `/add` or `/add/` — the card branch requires an
absolute http(s) URL scoped to the `/add` pathname before the marker is even
considered, so a scheme- or domain-wrapper cannot smuggle an otherwise-valid
`#c=` payload past the gate.

**AC-ROUTE-6** — The group-invite branch does not pin the origin to `few.chat`:
an invite URL built from a different origin (e.g. `few-chat.pages.dev` or a
localhost dev origin) with the same `/groups/` path and valid params is accepted,
so a non-`few.chat` deployment scans its own invites.

## S2 — Mobile FAB scanner entry point (UI)

**AC-FAB-1** — The scanner FAB renders only at the mobile breakpoint
(`display base` visible, `md` hidden), consistent with the other mobile-only
surfaces in `Layout.tsx`; it never renders on desktop.

**AC-FAB-2** — The FAB is horizontally centered at the bottom of the viewport and
sits visually above the bottom tab bar (z-index above the bar; safe-area inset
honored).

**AC-FAB-3** — The FAB does not appear in the hamburger overlay and is not a
member of `navItems` (the hamburger menu's item set is unchanged by this epic).

**AC-FAB-4** — The FAB follows the same route-visibility gating as the bottom tab
bar: it is hidden on the open-chat routes (`/contacts` and `/groups` with a
non-empty `id` query) where the bottom bar is hidden.

**AC-SCAN-1** — Tapping the FAB opens the camera scanner. When
`canUseCameraQrScanner()` is false (insecure context or no `getUserMedia`), the
scanner surfaces the unavailable message instead of a broken camera view; a
camera-permission denial surfaces the permission-denied message.

**AC-SCAN-2** — On decoding a valid few.chat card QR, the app navigates to the
card destination (`/add#c=…`) and closes the scanner; on decoding a valid group
invite QR, it navigates to `/groups?join=…&admin=…&name=…` and closes the
scanner.

**AC-SCAN-3** — On decoding a value that `resolveScanDestination` rejects, the
app shows the unrecognised-link message, does not navigate, does not surface the
raw scanned content, and keeps scanning.

**AC-INTL-1** — All scanner-facing strings (FAB aria-label, scanner title/hint,
starting-camera, permission-denied, unavailable, unrecognised-link) are defined
under a `scanner` i18n namespace with both `en` and `de` entries and are
consumed via `useCopy()` — no hardcoded user-visible strings in the component.

**AC-PRIV-1** — The feature performs no relay publish and broadcasts no profile
metadata: scanning decodes locally and navigation triggers only the existing
`/add` and `/groups` flows. (Privacy invariant, `CLAUDE.md`.)
