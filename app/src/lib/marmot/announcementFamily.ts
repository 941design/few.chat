/**
 * The single "informative-announcement family" content predicate.
 *
 * epic-group-invite-lifecycle: S7 (immutability-ui) and S8
 * (immutability-receive) both need to answer the identical question — does
 * this message's content belong to the non-`image` `StructuredContent`
 * family (`invite_lifecycle`, `member_admitted`, `leave_intent`,
 * `invite_cancelled`, `group_renamed`, `call_notice`, polls)? Before this
 * module existed, S7 defined `isInformativeAnnouncement(message)` directly
 * in `app/src/lib/messageEdits/messageActionUi.ts`. S8's receive-side gate
 * needs the SAME classification but only ever has a raw `content: string` in
 * hand (a signal's target row content, or an edit's replacement content) —
 * not always a full `ChatMessage` object — so a content-level helper is
 * extracted here rather than S8 re-implementing a second, parallel
 * definition that could silently drift from S7's.
 *
 * Location choice (documented per the S8 story brief's "note the choice"
 * instruction): this could have lived inside `messageActionUi.ts` itself,
 * but that file already imports `chatPersistence.ts` (for
 * `filterVisibleMessages`/`ChatMessage`), and S8 also needs this predicate
 * inside `chatPersistence.ts` itself (the tombstone-application path,
 * DD-11's fourth apply site) — importing messageActionUi.ts FROM
 * chatPersistence.ts would create a circular import. A tiny, dependency-free
 * (besides `parseStructured`) shared module avoids that cycle while still
 * giving every consumer (`messageActionUi.ts`, `messageEdits/api.ts`,
 * `chatPersistence.ts`) the exact same function reference — ONE family
 * definition, never re-implemented.
 *
 * Deliberately does NOT import from or modify `parseStructured.ts` (S1,
 * frozen) — this module only CONSUMES `parseStructured`'s exported result
 * shape, exactly as S7's original predicate did.
 */

import { parseStructured } from '@/src/lib/marmot/parseStructured';

/**
 * True iff `content` parses (via `parseStructured`) to a non-null, non-
 * `image` `StructuredContent` — i.e. belongs to the informative-announcement
 * family. Generic over ANY parseStructured result, including announcement
 * types added after this module lands — no per-type special-casing.
 */
export function isInformativeAnnouncementContent(content: string): boolean {
  const structured = parseStructured(content);
  return structured !== null && structured.type !== 'image';
}
