/**
 * Invite context (D3, AC-CTX-1 / AC-CTX-2, privacy invariant): the sponsor-to-invitee pre-join preview.
 *
 * After an invite outcome of `delivered` or `retryable` the sponsor sends ONE addressed rumor of kind 21064
 * (`APP_INBOX_KINDS.inviteContext`) through `extensions.sendInboxRumor`, content exactly
 * `{"groupId":<id>,"name":<name>}`: no description, no admins, no profile data. The library gift-wraps it to
 * the invitee's inbox relays (NIP-59): it is an addressed private message, never a public event (AC-PRIV-2). A
 * `failed` / `declined` outcome sends nothing, and there is no retry or resend machinery: a context that does
 * not arrive leaves the invitation card on its generic label.
 *
 * The name is UNTRUSTED text on the receiving side (`sanitizeContextName`): NFC-normalised; C0/C1 controls and line
 * separators become a space; invisible format characters (zero-width, bidi, tag characters, blank fillers,
 * soft hyphen, ...) are REMOVED outright (a zero-width space inside a word does not split it), except a zero-width
 * joiner that joins two emoji (ZWJ emoji names survive) and a zero-width non-joiner between two letters (Persian/Indic
 * spelling; a doubled one is removed entirely); combining marks are capped per base; whitespace is
 * collapsed; the length is capped at `MAX_CONTEXT_NAME_LENGTH` code points on a grapheme boundary; and a result
 * with no visible character means "no name" (the card shows the generic label). The sender applies the same
 * normalisation, so a name that is already valid is sent verbatim.
 *
 * Re-entrancy: `sendInboxRumor` is an account-scope client call and rejects `reentrant` inside a library frame
 * (history sink, inbox handler, client listener). Call this from a UI handler or a queued job, exactly like
 * `inviteByPubkey`. A rejection never breaks the invite: it is reported and the invite outcome is returned unchanged. The context send runs
 * AFTER the invite result is known and is NOT awaited by `inviteByPubkey` (the invite is already committed; a slow
 * or hanging context send must not delay or fail it).
 *
 * Pure module: ports are injected and validated at construction; no React, no storage, no client import.
 */
import { getEventHash, type Rumor } from '@941design/nostr-events/event';
import { APP_INBOX_KINDS } from '../kinds';
import type { AlreadyMember, InviteGroup, InviteOptions, InviteOutcome, KeyPackageInviter, NoUsableKeyPackage } from './invite';

export const INVITE_CONTEXT_KIND: number = APP_INBOX_KINDS.inviteContext;

/**
 * Longest stored / shown context name, in CODE POINTS (not UTF-16 units). It equals the group-name cap
 * used for group creation and rename, which counts UTF-16 units: a valid group name has at most as many
 * code points as units, so it always fits unchanged. A test pins the equality of the two numbers.
 */
export const MAX_CONTEXT_NAME_LENGTH = 64;

/** Longest accepted group id string (a hex id; the bound only protects the store from hostile input). */
const MAX_GROUP_ID_LENGTH = 128;
const GROUP_ID_PATTERN = /^[0-9a-f]+$/i;

/** Most combining marks kept after one base character. */
export const MAX_COMBINING_MARKS_PER_BASE = 4;

/** C0/C1 controls and line/paragraph separators: replaced by a space (they separate words). */
const SPACE_LIKE_CONTROL = /^[\u0000-\u001f\u007f-\u009f\u2028\u2029]$/;
/**
 * Invisible characters removed outright: every Unicode format character (`Cf`: zero-width, bidi marks and
 * overrides, isolates, soft hyphen, invisible operators, tag characters, BOM, ...) plus the blank fillers that
 * render as nothing but are not `Cf`: Hangul fillers, Braille blank, Mongolian vowel separator, tag range.
 */
const INVISIBLE = /^[\p{Cf}\u115f\u1160\u3164\uffa0\u2800\u180e\u00ad\u061c\ufff9-\ufffb\u{e0000}-\u{e007f}]$/u;
const ZWJ = 0x200d;
const ZWNJ = 0x200c;
const LETTER = /^\p{L}$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
/** Characters that extend a pictographic base inside an emoji sequence (variation selector, skin tone, marks). */
const EMOJI_EXTEND = /^[\p{M}\u{1f3fb}-\u{1f3ff}]$/u;
const MARK = /^\p{M}$/u;
const VISIBLE = /[^\p{M}\s]/u;

const hasSegmenter = typeof Intl !== 'undefined' && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function';

/** Code-point-wise cleaning: controls to space, invisibles dropped (ZWJ kept between pictographs), marks capped. */
function cleanCodePoints(input: string): string {
  const points = Array.from(input);
  const out: string[] = [];
  let lastBaseIsPictographic = false;
  let lastBaseIsLetter = false;
  let marks = 0;
  for (let i = 0; i < points.length; i++) {
    const ch = points[i];
    if (SPACE_LIKE_CONTROL.test(ch)) {
      out.push(' ');
      lastBaseIsPictographic = false;
      lastBaseIsLetter = false;
      marks = 0;
      continue;
    }
    if (ch.codePointAt(0) === ZWJ) {
      if (lastBaseIsPictographic && i + 1 < points.length && PICTOGRAPHIC.test(points[i + 1])) {
        out.push(ch);
        lastBaseIsPictographic = false;
        lastBaseIsLetter = false;
      }
      continue;
    }
    if (ch.codePointAt(0) === ZWNJ) {
      // Orthographic in Persian and several Indic scripts: kept only between two letters (marks attached to the
      // first are transparent). Leading, trailing, doubled (both dropped) or next to space/digit/punctuation: removed.
      if (lastBaseIsLetter && i + 1 < points.length && LETTER.test(points[i + 1])) {
        out.push(ch);
      }
      lastBaseIsLetter = false; // a ZWNJ never chains: a doubled one drops both
      continue;
    }
    if (INVISIBLE.test(ch)) continue;
    if (MARK.test(ch)) {
      if (++marks > MAX_COMBINING_MARKS_PER_BASE) continue;
      out.push(ch);
      continue; // a mark never changes the base
    }
    marks = 0;
    out.push(ch);
    lastBaseIsLetter = LETTER.test(ch);
    if (!EMOJI_EXTEND.test(ch)) lastBaseIsPictographic = PICTOGRAPHIC.test(ch);
  }
  return out.join('');
}

/** At most `max` code points, cut on a grapheme boundary when `Intl.Segmenter` exists. */
function capByGrapheme(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  if (hasSegmenter) {
    const segmenter = new (Intl as unknown as { Segmenter: new (l?: string, o?: { granularity: 'grapheme' }) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter(undefined, { granularity: 'grapheme' });
    let kept = '';
    let count = 0;
    for (const { segment } of segmenter.segment(text)) {
      const n = Array.from(segment).length;
      if (count + n > max) break;
      kept += segment;
      count += n;
    }
    if (count > 0) return kept;
  }
  // No segmenter, or one grapheme longer than the cap: cut by code point and never leave a dangling joiner.
  return points.slice(0, max).join('').replace(/\u200d+$/, '');
}

/**
 * Normalises an untrusted group name for display: NFC; controls and line separators to a space; invisible format
 * characters removed (not replaced: `a<ZWSP>b` is `ab`), except a ZWJ between two pictographs and a ZWNJ between two letters (a doubled ZWNJ is removed entirely); at most
 * `MAX_COMBINING_MARKS_PER_BASE` combining marks per base; whitespace runs collapsed; trimmed; truncated to
 * `MAX_CONTEXT_NAME_LENGTH` code points on a grapheme boundary. Markup is NOT interpreted or stripped: the
 * result is literal text that the renderer escapes (`<b>x</b>` stays the 8 literal characters). `''` = no name
 * (also when no visible character remains).
 */
export function sanitizeContextName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const collapsed = cleanCodePoints(raw.normalize('NFC')).replace(/\s+/g, ' ').trim();
  if (!VISIBLE.test(collapsed)) return '';
  return capByGrapheme(collapsed, MAX_CONTEXT_NAME_LENGTH).trim();
}

interface InviteContextPayload {
  groupId: string;
  name: string;
}

/** The exact wire content: two keys, this order, nothing else. */
export function buildInviteContextContent(groupId: string, name: string): string {
  return JSON.stringify({ groupId, name });
}

/**
 * Parses an untrusted rumor content. Returns `null` for anything that is not a JSON object with a string
 * `groupId` (hex, bounded) and a string `name` that is non-empty after sanitising. Unknown extra keys are
 * ignored and never carried further (the result has exactly the two fields).
 */
export function parseInviteContextContent(content: unknown): InviteContextPayload | null {
  if (typeof content !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { groupId, name } = parsed as { groupId?: unknown; name?: unknown };
  if (typeof groupId !== 'string' || groupId.length === 0 || groupId.length > MAX_GROUP_ID_LENGTH || !GROUP_ID_PATTERN.test(groupId)) return null;
  const clean = sanitizeContextName(name);
  if (clean.length === 0) return null;
  return { groupId: groupId.toLowerCase(), name: clean };
}

/** The slice of `MarmotClient['extensions']` the sender uses. */
interface InboxRumorSender {
  sendInboxRumor: (input: { readonly to: string; readonly rumor: Rumor }) => Promise<{ readonly status: 'delivered' | 'retryable' | 'failed'; readonly reason?: string }>;
}

interface InviteContextSenderDeps {
  inbox: InboxRumorSender;
  /** The own account pubkey (the rumor's author). */
  ownPubkey: string;
  /** Clock, ms (rumor `created_at` is its floor in seconds). */
  now: () => number;
  /** A failed send (default `console.error`). */
  onError?: (error: unknown) => void;
}

type InviteContextSendResult = 'sent' | 'skipped' | 'failed';

interface InviteContextSender {
  /**
   * Sends the context for an invite result. `skipped` = the invite did not deliver (`failed`, `declined`, or an
   * error value): nothing is sent. `failed` = the send was rejected or reported `failed`; never throws.
   */
  sendAfterInvite: (
    result: InviteOutcome | NoUsableKeyPackage | AlreadyMember,
    target: { to: string; groupId: string; name: string },
  ) => Promise<InviteContextSendResult>;
}

function requireFn(value: unknown, name: string, owner = 'createInviteContextSender'): void {
  if (typeof value !== 'function') throw new TypeError(`${owner}: required dependency "${name}" is missing`);
}

export function createInviteContextSender(deps: InviteContextSenderDeps): InviteContextSender {
  if (!deps) throw new TypeError('createInviteContextSender: dependencies are required');
  requireFn(deps.inbox?.sendInboxRumor, 'inbox.sendInboxRumor');
  requireFn(deps.now, 'now');
  if (typeof deps.ownPubkey !== 'string' || deps.ownPubkey.length === 0) throw new TypeError('createInviteContextSender: required dependency "ownPubkey" is missing');
  const { inbox, now } = deps;
  const ownPubkey = deps.ownPubkey.toLowerCase();
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/invitations] invite context', e));

  return {
    async sendAfterInvite(result, target) {
      try {
        if ('error' in result) return 'skipped';
        const status = result.outcome.status;
        if (status !== 'delivered' && status !== 'retryable') return 'skipped';
        const name = sanitizeContextName(target.name);
        if (name.length === 0) return 'skipped'; // nothing to preview: the card keeps its generic label
        const unsigned = {
          pubkey: ownPubkey,
          created_at: Math.floor(now() / 1000),
          kind: INVITE_CONTEXT_KIND,
          tags: [] as string[][],
          content: buildInviteContextContent(target.groupId, name),
        };
        const rumor: Rumor = { ...unsigned, id: getEventHash(unsigned) };
        // Lowercase hex: the library addresses the inbox by the canonical pubkey form.
        const delivery = await inbox.sendInboxRumor({ to: target.to.toLowerCase(), rumor });
        if (delivery.status === 'failed') {
          // The reason only (a short machine code), never the rumor or the name.
          onError(new Error(`invite context delivery failed: ${typeof delivery.reason === 'string' ? delivery.reason : 'unknown'}`));
          return 'failed';
        }
        return 'sent';
      } catch (e) {
        onError(e);
        return 'failed';
      }
    },
  };
}

/** The group handle `inviteByPubkey` is given plus its display name (a `MarmotGroup` has both). */
type ContextInviteGroup = InviteGroup & { readonly name: string };

interface ContextSendingInviterDeps {
  inviter: KeyPackageInviter;
  sender: InviteContextSender;
  /** A context send that threw or rejected (default `console.error`). The invite result is unaffected. */
  onError?: (error: unknown) => void;
  /**
   * Receives the promise of each context send (never rejects; resolves to the send result, `'failed'` when it
   * threw). A hook for callers and tests that need to observe the send; `inviteByPubkey` itself never awaits it.
   */
  onContextSend?: (send: Promise<InviteContextSendResult>) => void;
}

/**
 * `KeyPackageInviter` decorated with the D3 context: the invite runs unchanged, then (only for a `delivered` /
 * `retryable` outcome) one context rumor goes to the invitee. The invite result is returned AT ONCE, as is: the
 * context send is started but not awaited (a never-settling send cannot delay the invite), and nothing in the
 * context path (target read, rumor build, send) can turn a committed invite into a rejection. Same re-entrancy
 * rule as `inviteByPubkey`.
 */
export function createContextSendingInviter(deps: ContextSendingInviterDeps): {
  inviteByPubkey: (group: ContextInviteGroup, pubkey: string, opts?: InviteOptions) => ReturnType<KeyPackageInviter['inviteByPubkey']>;
} {
  if (!deps) throw new TypeError('createContextSendingInviter: dependencies are required');
  requireFn(deps.inviter?.inviteByPubkey, 'inviter.inviteByPubkey', 'createContextSendingInviter');
  requireFn(deps.sender?.sendAfterInvite, 'sender.sendAfterInvite', 'createContextSendingInviter');
  const { inviter, sender } = deps;
  const onError = deps.onError ?? ((e: unknown) => console.error('[marmot/invitations] invite context send', e));
  const report = (e: unknown) => {
    try {
      onError(e);
    } catch {
      /* a failing error sink must not surface either */
    }
  };
  return {
    async inviteByPubkey(group, pubkey, opts) {
      const result = await inviter.inviteByPubkey(group, pubkey, opts);
      try {
        const send = Promise.resolve(sender.sendAfterInvite(result, { to: pubkey, groupId: group.id, name: group.name })).catch((e: unknown): InviteContextSendResult => {
          report(e);
          return 'failed';
        });
        deps.onContextSend?.(send);
      } catch (e) {
        report(e);
      }
      return result;
    },
  };
}
