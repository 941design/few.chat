import type { MediaAttachment } from '@internet-privacy/marmot-ts';
import { parseMediaImetaTag as parseGroupMediaImetaTag } from '@941design/marmot-engine/core';

export function buildImetaTag(attachment: MediaAttachment, role: 'full' | 'thumb'): string[] {
  const tag: string[] = ['imeta'];

  tag.push(`url ${attachment.url}`);
  tag.push(`m ${attachment.type}`);
  tag.push(`x ${attachment.sha256}`);

  if (attachment.size !== undefined) {
    tag.push(`size ${attachment.size}`);
  }
  if (attachment.dimensions !== undefined) {
    tag.push(`dim ${attachment.dimensions}`);
  }
  if (attachment.blurhash !== undefined) {
    tag.push(`blurhash ${attachment.blurhash}`);
  }

  tag.push(`filename ${attachment.filename}`);
  tag.push(`n ${attachment.nonce}`);
  tag.push(`v ${attachment.version}`);
  tag.push(`role ${role}`);

  return tag;
}

// ---------------------------------------------------------------------------
// Group media (encrypted-media-v1, library codec). Built beside the legacy
// `buildImetaTag` above, which the old marmot-ts media path still uses until
// the cutover (S18) and the sweep (S22).
// ---------------------------------------------------------------------------

export type GroupImageRole = 'full' | 'thumb';

/**
 * The role of a group imeta tag: the value of its first `role <value>` field, `thumb` only when that value is
 * exactly `thumb`; a missing or any other role is `full`. The one classifier behind both attachment extraction
 * and the load size cap, so the two can never disagree about which tag is a thumbnail.
 */
export function groupImageRoleOf(tag: readonly unknown[]): GroupImageRole {
  const role = tag.find((part): part is string => typeof part === 'string' && part.startsWith('role '));
  return role === 'role thumb' ? 'thumb' : 'full';
}

/**
 * The imeta tag of ONE `group.encryptMedia` result, plus the app's `role` field.
 *
 * The library tag is the whole media metadata (version, locators, ciphertext and plaintext
 * hash, nonce, type, filename, dim, thumbhash); the app adds only `role` (unknown fields are
 * ignored by the codec). It never carries the plaintext bytes. Fails loudly, before anything
 * is uploaded or sent, when the tag could not be rendered by any receiver: not exactly one
 * valid tag, a role already present, or no fetchable `blossom-v1` locator (the library
 * rejects a non-https / non-routable Blossom locator, and a cache-only locator is not
 * fetchable by anyone else).
 */
export function buildGroupImetaTag(
  libraryImeta: readonly (readonly string[])[],
  role: GroupImageRole,
): string[] {
  if (role !== 'full' && role !== 'thumb') throw new TypeError('buildGroupImetaTag: role must be "full" or "thumb"');
  if (!Array.isArray(libraryImeta) || libraryImeta.length !== 1) {
    throw new TypeError('buildGroupImetaTag: expected exactly one library imeta tag');
  }
  const tag = [...libraryImeta[0]];
  if (tag[0] !== 'imeta' || tag.some((part) => typeof part !== 'string')) {
    throw new TypeError('buildGroupImetaTag: not an imeta tag');
  }
  if (tag.some((part) => part === 'role' || part.startsWith('role '))) {
    throw new TypeError('buildGroupImetaTag: the library tag already carries a role');
  }
  const attachment = parseGroupMediaImetaTag(tag);
  if (!attachment) {
    throw new TypeError(
      'buildGroupImetaTag: the library imeta tag is not a valid encrypted-media-v1 attachment ' +
        '(is the Blossom server an https URL on a routable host?)',
    );
  }
  if (!attachment.locators.some((l) => l.kind === 'blossom-v1')) {
    throw new TypeError('buildGroupImetaTag: the imeta tag has no blossom-v1 locator (nothing a receiver could fetch)');
  }
  return [...tag, `role ${role}`];
}
