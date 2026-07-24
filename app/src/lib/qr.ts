import { npubToPubkeyHex } from '@/src/lib/nostrKeys';
import { parseContactCard } from '@/src/lib/contactCard';

export function normaliseNpubPayload(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const stripped = trimmed.toLowerCase().startsWith('nostr:')
    ? trimmed.slice('nostr:'.length).trim()
    : trimmed;

  return npubToPubkeyHex(stripped) ? stripped : null;
}

/**
 * Card-aware sibling of {@link normaliseNpubPayload} (epic: contact-card-exchange,
 * story S4) — the shared QR-scan validation seam consumed by `NpubQrScanner`, and
 * from there by every scan-mode `NpubQrModal` caller (`AddContactModal` in this
 * story, `InviteMemberModal` in S5). `normaliseNpubPayload` itself is left
 * unmodified: it is still used, as-is, by `MarmotContext.inviteByNpub`, which is
 * out of this story's scope.
 *
 * Accepts everything `normaliseNpubPayload` does (a bare npub, optionally
 * `nostr:`-prefixed) PLUS a contact-card onboarding link
 * (`https://few.chat/add#c=<payload>`) or a raw base64url card payload. All
 * decode/signature-verification logic is delegated to `parseContactCard` — the
 * single card decode seam (architecture.md DD 1) — so this function never parses
 * card bytes itself. It strips an optional `nostr:` URI prefix so the returned
 * (pre-fill) string is the bare payload; `parseContactCard` independently also
 * tolerates a `nostr:` prefix, so this strip is a convenience for the returned
 * value, not a correctness requirement of the delegation. A card whose signature
 * fails to verify is rejected here (returns `null`), never silently downgraded to
 * a bare-pubkey pass (AC-PARSE-4 / VQ-S4-006).
 *
 * Returns the normalised (prefix-stripped, trimmed) string — not the parsed
 * struct — so the `onScan` contract stays a plain string end to end; callers
 * re-parse it via `parseContactCard` when they need the decoded pubkey/profile
 * (e.g. `AddContactModal.processContactInput`).
 */
export function normaliseScanPayload(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const stripped = trimmed.toLowerCase().startsWith('nostr:')
    ? trimmed.slice('nostr:'.length).trim()
    : trimmed;

  const parsed = parseContactCard(stripped);
  if ('error' in parsed) return null;

  return stripped;
}

// ── Scan destination routing (epic: mobile-qr-scanner, story S1) ──────────
//
// The `ScanDestination` seam (specs/epic-mobile-qr-scanner/stories.json
// seams[0]): `resolveScanDestination` classifies a decoded QR-scan string
// and returns the app-relative destination to navigate to, or `null` when
// the value is neither a recognised contact/pairing card nor a group
// invite. Synchronous, pure, DOM-free — no `router`, no `window`, no
// network — and never throws for any string input. `QrScanFab` (S2)
// consumes the return value directly (`router.push`) without further shape
// verification, so every branch below is a hard gate, not a best-effort
// guess.

/**
 * Marker locating an embedded card payload inside a scanned card link's
 * hash fragment (`https://<origin>/add#c=<payload>`). Mirrors
 * `contactCard.ts`'s private `CARD_LINK_FRAGMENT_MARKER` and
 * `addDeepLink.ts`'s `CARD_HASH_MARKER` — kept as its own local constant
 * here (neither is exported) rather than a new export from either module,
 * per this story's scope (no changes to contactCard.ts). This is pure
 * substring extraction, not card parsing — decode and signature
 * verification stay exclusively inside `parseContactCard`, reached via
 * `normaliseScanPayload` below (DD2).
 */
const CARD_LINK_FRAGMENT_MARKER = '#c=';

/**
 * Derive the `/add#c=` fragment payload from the value
 * `normaliseScanPayload` already validated (trimmed, `nostr:`-stripped,
 * signature-verified where signed). A bare npub or a raw base64url payload
 * IS already the payload; a full card link carries the marker, and the
 * payload trails it.
 */
function extractCardLinkPayload(normalisedValue: string): string {
  const markerIdx = normalisedValue.indexOf(CARD_LINK_FRAGMENT_MARKER);
  return markerIdx === -1 ? normalisedValue : normalisedValue.slice(markerIdx + CARD_LINK_FRAGMENT_MARKER.length);
}

/**
 * Pathname `buildInviteUrl` (marmot/inviteLinkGeneration.ts) always builds
 * group-invite links at — trailing slash, per `trailingSlash: true` in
 * next.config.mjs (the canonically served path for a static export).
 */
const GROUP_INVITE_PATHNAME = '/groups/';

/**
 * Pathname `buildShareUrl` (contactCard.ts's `CARD_LINK_URL_PREFIX =
 * 'https://few.chat/add#c='`) always builds card links at. Also accept the
 * trailing-slash variant (`/add/`) per `trailingSlash: true` in
 * next.config.mjs, mirroring `GROUP_INVITE_PATHNAME` above.
 */
const CARD_LINK_PATHNAME = '/add';
const CARD_LINK_PATHNAME_TRAILING_SLASH = '/add/';

/**
 * Detects whether `value` is an absolute http(s) URL, as opposed to the
 * other three forms `normaliseScanPayload` accepts unmodified (a bare
 * npub, a `nostr:`-prefixed npub, or a raw base64url card payload).
 * `new URL()` happily parses `nostr:npub1…` too — it is a well-formed
 * opaque URI with a non-special scheme — so this checks `protocol` rather
 * than merely catching the constructor: a `nostr:`-prefixed npub must keep
 * falling through to the unguarded delegation below, unchanged. Never
 * throws.
 */
function parseWebUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/**
 * True when `value` carries the `#c=` card-link marker, after stripping an
 * optional `nostr:` prefix and surrounding whitespace — the same
 * normalisation `normaliseScanPayload`/`normaliseNpubPayload` apply
 * internally. The marker legitimately appears ONLY inside a full `/add`
 * card-link URL (`buildShareUrl`, contactCard.ts) — a bare npub, a
 * `nostr:`-prefixed npub, and a raw base64url payload never contain it.
 * Read-only substring check; never decodes, never throws.
 */
function hasCardLinkMarker(value: string): boolean {
  const trimmed = value.trim();
  const stripped = trimmed.toLowerCase().startsWith('nostr:') ? trimmed.slice('nostr:'.length).trim() : trimmed;
  return stripped.includes(CARD_LINK_FRAGMENT_MARKER);
}

/**
 * Hex length of the 16-byte pairing/invite nonce `generateNonce()`
 * (marmot/inviteLinkGeneration.ts) produces (2 hex chars per byte).
 */
const INVITE_JOIN_NONCE_HEX_LENGTH = 32;
// No `i` flag: `generateNonce()` (marmot/inviteLinkGeneration.ts) only ever
// emits lowercase hex, so an uppercase-hex `join` nonce must fail this gate
// closed rather than pass here and (plausibly) fail a case-sensitive
// downstream match silently (gate-remediation Finding 4).
const INVITE_JOIN_NONCE_PATTERN = new RegExp(`^[0-9a-f]{${INVITE_JOIN_NONCE_HEX_LENGTH}}$`);

/**
 * Minimal, pattern-based group-invite shape validator (new — no existing
 * shared "is this scannable" helper covers this shape, per
 * exploration.json's `fewchat_link_shapes.group_invite.no_shared_validator`
 * finding). Deliberately does NOT read or compare `url.origin` /
 * `url.hostname` (AC-ROUTE-6, DD3/DD6) — a non-few.chat deployment must be
 * able to scan its own invites. `new URL()` requires an absolute URL, so a
 * bare path or relative value is rejected structurally. Returns the three
 * params verbatim (already percent-decoded by `URLSearchParams`) once all
 * three validate, else `null`. Never throws.
 */
function parseGroupInviteUrl(value: string): { join: string; admin: string; name: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.pathname !== GROUP_INVITE_PATHNAME) return null;

  const join = url.searchParams.get('join');
  const admin = url.searchParams.get('admin');
  const name = url.searchParams.get('name');
  if (!join || !admin || !name) return null;
  if (!INVITE_JOIN_NONCE_PATTERN.test(join)) return null;
  if (!npubToPubkeyHex(admin)) return null;

  return { join, admin, name };
}

/**
 * Classifies a decoded QR-scan value and resolves its destination — the
 * load-bearing behavioral seam this story creates for `QrScanFab` (S2).
 *
 * Card branch delegates entirely to `normaliseScanPayload` ->
 * `parseContactCard`: decode and signature verification are never
 * reimplemented here (DD2). A signature-failing card returns `null`, never
 * a downgraded/bare-pubkey destination (AC-ROUTE-3).
 *
 * The gate on the card branch is the `#c=` marker, not the URL scheme
 * (gate-remediation Finding 2): the marker legitimately appears ONLY inside
 * a full `/add` card-link URL, so any value carrying it (after stripping an
 * optional `nostr:` prefix, `hasCardLinkMarker`) MUST parse as an absolute
 * http(s) URL whose pathname is the add-card path (`/add` or `/add/`) —
 * origin-agnostic like the group-invite branch (AC-ROUTE-6), but gated on
 * pathname so an arbitrary-domain URL that merely embeds a `#c=` fragment
 * elsewhere is rejected (AC-ROUTE-5). Gating on the marker rather than on
 * `parseWebUrl`'s http(s)-only check also closes a scheme bypass a
 * scheme-only gate missed: `parseWebUrl` returns `null` for any non-http(s)
 * scheme (e.g. `nostr:https://evil.example/x#c=<payload>`,
 * `ftp://evil.example/x#c=<payload>`), and a gate that treated "not a web
 * URL" as automatically card-link-shaped let such values fall through
 * ungated. Values with NO marker keep delegating straight through,
 * unguarded — a bare npub, `nostr:`-prefixed npub, or raw base64url payload
 * never carries the marker and is never URL-gated.
 *
 * Group-invite branch is origin-agnostic (AC-ROUTE-6): pathname +
 * `join`/`admin`/`name` shape only.
 *
 * Returns `null` for everything else — arbitrary text, unrelated URLs, an
 * empty string, or a `/groups/` URL missing any required param
 * (AC-ROUTE-4/5).
 */
export function resolveScanDestination(value: string): string | null {
  if (hasCardLinkMarker(value)) {
    const webUrl = parseWebUrl(value);
    const isCardLinkShape =
      webUrl !== null && (webUrl.pathname === CARD_LINK_PATHNAME || webUrl.pathname === CARD_LINK_PATHNAME_TRAILING_SLASH);
    if (isCardLinkShape) {
      const cardPayload = normaliseScanPayload(value);
      if (cardPayload !== null) {
        return `/add#c=${extractCardLinkPayload(cardPayload)}`;
      }
    }
  } else {
    const cardPayload = normaliseScanPayload(value);
    if (cardPayload !== null) {
      return `/add#c=${extractCardLinkPayload(cardPayload)}`;
    }
  }

  const invite = parseGroupInviteUrl(value);
  if (invite !== null) {
    const params = new URLSearchParams();
    params.set('join', invite.join);
    params.set('admin', invite.admin);
    params.set('name', invite.name);
    return `/groups?${params.toString()}`;
  }

  return null;
}

/** Error-correction levels this app encodes at. */
export type QrErrorCorrectionLevel = 'L' | 'M';

/**
 * Shared QR *generation* seam (sibling of the scan-validation seams above).
 *
 * Both display surfaces that render a QR — `NpubQrModal` (npub / contact card)
 * and `GenerateInviteLinkModal` (group invite link) — encode through this one
 * function, so the raster options (margin, width) and the dynamic `qrcode`
 * import stay defined once. It is deliberately a plain async function rather
 * than a hook: this repo's vitest environment has no DOM renderer, so a hook
 * could not be unit-tested, whereas this can (see `qr.test.ts`).
 *
 * `qrcode` is imported dynamically to keep it out of the initial bundle — it is
 * only needed once a user actually opens a QR surface.
 *
 * Longer payloads (contact cards) encode at ECC-L to keep the module count —
 * and therefore the printed density — manageable; short payloads (a bare npub,
 * an invite URL) use the more forgiving ECC-M default.
 */
export async function generateQrDataUrl(
  value: string,
  errorCorrectionLevel: QrErrorCorrectionLevel = 'M',
): Promise<string> {
  const { default: QRCode } = await import('qrcode');
  return QRCode.toDataURL(value, {
    errorCorrectionLevel,
    margin: 2,
    width: 320,
  });
}

export function canUseCameraQrScanner(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
}
