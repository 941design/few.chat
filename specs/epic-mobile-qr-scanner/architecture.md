# Architecture — Mobile QR-Code Scanner

## Paradigm

Modular monolith, package-by-feature, within the existing Next.js static-export
app (`app/`). This epic adds no new top-level architecture — it plugs a first
live entry point into two existing seams (the QR lib and the Layout navigation
chrome).

## Module Map

| Module | Purpose | Location | Owned data |
|---|---|---|---|
| QR lib | Pure scan-payload classification + destination resolution; existing generation + card-validation seam | `app/src/lib/qr.ts` (+ existing `contactCard.ts`, `nostrKeys.ts`, `marmot/inviteLinkGeneration.ts` for shape reference) | `resolveScanDestination` (new), `normaliseScanPayload` (existing), group-invite validator (new) |
| Navigation UI | Mobile chrome — bottom bar, hamburger, and the new scanner FAB entry point | `app/src/components/Layout.tsx` (+ new `QrScanFab` component if extracted) | FAB render block, scanner-open state |
| Scanner UI | Camera decode surface (existing, reused) | `app/src/components/groups/NpubQrScanner.tsx`, `NpubQrModal.tsx` | unchanged — consumed, not modified (a non-group framing may warrant a thin app-level wrapper) |
| i18n | User-facing copy | `app/src/lib/i18n.ts` | new `scanner` namespace (EN + DE) |

## Boundary Rules

- No direct imports across module boundaries except through declared seams.
- The Navigation UI consumes the QR lib's `resolveScanDestination` (a pure
  string→string|null function) and the Scanner UI's `onScan` string contract. It
  does not re-implement card/invite parsing.
- The QR lib stays DOM-free and pure (unit-testable in the repo's no-DOM vitest
  environment). No `router`, no `window` navigation inside it — it returns a
  destination *string*; the UI performs `router.push`.
- The Scanner UI (`NpubQrScanner`) is reused as-is; if a group-namespaced framing
  is unavoidable, introduce a thin app-level wrapper rather than editing the
  group component's semantics.

## Seams

- **`resolveScanDestination(value: string): string | null`** (QR lib → Navigation
  UI). The load-bearing behavioral seam. Card branch delegates to
  `normaliseScanPayload`→`parseContactCard`; group-invite branch is new,
  shape-validating (path `/groups/` + `join`/`admin`/`name`), origin-agnostic.
- **`onScan(payload: string)`** (Scanner UI → Navigation UI). Existing string
  contract; the FAB's handler passes the payload to `resolveScanDestination`.

## Implementation Constraints

- Static export: navigate only to query-param / fragment URLs the existing
  generators produce (`/add#c=…`, `/groups?join=…&admin=…&name=…`). No new
  `[param].tsx`.
- Mobile-only + hamburger-exclusion: the FAB must bypass `navItems` and use
  Chakra `display={{ base, md:'none' }}` gating plus the `!hideBottomNav`
  predicate.
- Privacy invariant (`CLAUDE.md`): no relay writes, no kind-0 publish. Decoding
  is local; navigation triggers only already-audited flows. Verified structurally
  in AC-PRIV-1.
- All user-visible strings via `useCopy()`; EN + DE both required.

## Order-Sensitive Composition

This epic does **not** compose order-sensitive subsystems. There is no
concurrency, redelivery, crash-recovery, merge/convergence, event-sourced
projection, or multi-writer flow introduced. The scan→classify→navigate path is a
single synchronous, idempotent client-side transform that hands off to existing
(separately-owned) resolution flows. No whole-flow ordering guarantee is at
stake. No downstream order-sensitivity derivation is required.
