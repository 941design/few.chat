/**
 * Relay URL policy of the key-package lookup (D10), split by who chose the URL.
 *
 *  - APP-CONFIGURED relays (the user's own relay settings, validated by `isValidRelayUrl`) are used as given
 *    (canonicalised, de-duplicated): `ws://umbrel.local:4848`-style self-hosted relays must keep working.
 *  - INVITEE-ADVERTISED relays (kind 10050 / 10002) are attacker-controlled input and make the inviter's
 *    browser open a socket: they must be `wss://`, carry no credentials and name a publicly routable DNS host.
 *    Loopback, RFC 1918, link-local, ULA, CGNAT, `.local` / `.internal` / single-label names and every literal
 *    IP address are rejected (an SSRF / LAN-probing surface). `allowLocal` lifts the host and scheme rules
 *    (credentials stay refused); it exists for tests that run FakeRelays on 127.0.0.1.
 *
 * The rule is a lexical check on the URL: it cannot see what a public name resolves to (DNS rebinding), which
 * is a documented residual of the lookup.
 *
 * Pure module.
 */
import { isValidRelayUrl } from '../../relay';

/** Host suffixes that never name a public host. */
const NON_PUBLIC_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home', '.home.arpa', '.intranet', '.corp', '.private'] as const;

function canonical(u: URL): string {
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

function parse(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^wss?:\/\//i, (m) => m.toLowerCase());
  if (!isValidRelayUrl(trimmed)) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

/** A hostname that is a literal IP address (WHATWG parsing already folded `0x7f.1`-style forms into dotted quads). */
function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || /^[\d.]+$/.test(hostname);
}

/** True for a DNS name that can plausibly be resolved on the public internet (lexical rule; see module doc). */
export function isPublicDnsHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0 || isIpLiteral(host)) return false;
  if (host === 'localhost' || !host.includes('.')) return false;
  if (NON_PUBLIC_SUFFIXES.some((s) => host.endsWith(s))) return false;
  if (/^\d+$/.test(host.slice(host.lastIndexOf('.') + 1))) return false; // numeric TLD: an IPv4 spelling
  return true;
}

/**
 * An APP-CONFIGURED relay URL: valid ws:// or wss:// (as `isValidRelayUrl`), used as given. Scheme and host
 * lowercased, fragment and trailing slash dropped, query kept. null for anything else.
 */
export function normaliseRelayUrl(raw: unknown): string | null {
  const u = parse(raw);
  return u ? canonical(u) : null;
}

/**
 * An INVITEE-ADVERTISED relay URL: `wss://` only, no credentials, public DNS host (see module doc). With
 * `allowLocal` any ws/wss host without credentials passes. Canonicalised like `normaliseRelayUrl`. null otherwise.
 */
export function normaliseAdvertisedRelayUrl(raw: unknown, opts: { allowLocal?: boolean } = {}): string | null {
  const u = parse(raw);
  if (!u || u.username || u.password) return null;
  if (!opts.allowLocal && (u.protocol !== 'wss:' || !isPublicDnsHost(u.hostname))) return null;
  return canonical(u);
}
