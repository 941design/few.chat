import { createStore, get, set, del, keys, clear } from 'idb-keyval';

const blobStore = createStore('few-media-blobs', 'blobs');
const metaStore = createStore('few-media-meta', 'meta');

type BlobEntry = { bytes: Uint8Array; type: string };
type MetaEntry = { messageIds: string[] };

/**
 * Builds the cache identity string for a media attachment.
 *
 * Binding the cache to plaintext sha256 alone lets a malicious sender
 * publish a different attachment record (different nonce) that hits the
 * same cache slot and surfaces a previously cached plaintext. Including
 * `nonce` and `version` makes each attachment record cache-distinct, so
 * a forged record always falls through to fetch+decrypt and the AEAD
 * verification rejects content that does not match its metadata.
 */
export function attachmentFingerprint(attachment: {
  sha256: string;
  nonce: string;
  version: string;
}): string {
  return `${attachment.sha256}:${attachment.nonce}:${attachment.version}`;
}

function blobKey(groupId: string, fingerprint: string): string {
  return `${groupId}:${fingerprint}`;
}

export async function setBlob(
  groupId: string,
  fingerprint: string,
  data: BlobEntry,
): Promise<void> {
  await set(blobKey(groupId, fingerprint), data, blobStore);
}

export async function getBlob(
  groupId: string,
  fingerprint: string,
): Promise<BlobEntry | null> {
  const result = await get<BlobEntry>(blobKey(groupId, fingerprint), blobStore);
  return result ?? null;
}

export async function deleteBlob(groupId: string, fingerprint: string): Promise<void> {
  await del(blobKey(groupId, fingerprint), blobStore);
}

export async function addMessageRef(
  groupId: string,
  fingerprint: string,
  messageId: string,
): Promise<void> {
  const k = blobKey(groupId, fingerprint);
  const existing = await get<MetaEntry>(k, metaStore);
  const messageIds = existing?.messageIds ?? [];
  if (!messageIds.includes(messageId)) {
    messageIds.push(messageId);
  }
  await set(k, { messageIds }, metaStore);
}

export async function removeMessageRef(
  groupId: string,
  fingerprint: string,
  messageId: string,
): Promise<void> {
  const k = blobKey(groupId, fingerprint);
  const existing = await get<MetaEntry>(k, metaStore);
  if (!existing) return;
  const messageIds = existing.messageIds.filter((id) => id !== messageId);
  await set(k, { messageIds }, metaStore);
}

export async function getMessageRefs(
  groupId: string,
  fingerprint: string,
): Promise<string[]> {
  const k = blobKey(groupId, fingerprint);
  const existing = await get<MetaEntry>(k, metaStore);
  return existing?.messageIds ?? [];
}

export async function clearGroupMedia(groupId: string): Promise<void> {
  const prefix = `${groupId}:`;
  const blobKeys = await keys<string>(blobStore);
  const metaKeys = await keys<string>(metaStore);

  await Promise.all([
    ...blobKeys.filter((k) => k.startsWith(prefix)).map((k) => del(k, blobStore)),
    ...metaKeys.filter((k) => k.startsWith(prefix)).map((k) => del(k, metaStore)),
  ]);
}

/**
 * Clear every cached media blob and metadata entry across all groups.
 * Used by resetAllData / backup-restore so decrypted attachments do not
 * survive an identity reset on shared devices.
 */
export async function clearAllMedia(): Promise<void> {
  await Promise.all([clear(blobStore), clear(metaStore)]);
}

/**
 * The decrypted-media cache as the group image service's cache port. Serves an already-decrypted image
 * after a reload without the service decrypting again.
 */
export const groupMediaCachePort = { getBlob, setBlob, addMessageRef };
