import { parseMediaImetaTag, type MediaAttachment as GroupMediaAttachment } from '@internet-privacy/marmot-ts';
import { parseMediaImetaTag as parseGroupMediaImetaTag, type MediaAttachment as EngineMediaAttachment } from '@941design/marmot-engine/core';
import type { EncryptedMedia, EncryptMediaOptions } from '@941design/marmot';
import { MAX_OUTPUT_BYTES } from '@/src/config/blossom';
import type { GroupRumorSender, SendableGroup } from '@/src/lib/marmot/send';
import { buildGroupImetaTag, groupImageRoleOf, type GroupImageRole } from '@/src/lib/media/imetaTag';

export const DIRECT_MEDIA_VERSION = 'few-dm-media-v1' as const;

export type DirectMediaAttachment = {
  url?: string;
  sha256: string;
  type: string;
  filename: string;
  nonce: string;
  version: typeof DIRECT_MEDIA_VERSION;
  size?: number;
  dimensions?: string;
  blurhash?: string;
};

export type ChatMediaAttachment = GroupMediaAttachment | DirectMediaAttachment;

export type ImageMessageContent = {
  type: 'image';
  version: 1;
  caption: string;
};

/**
 * Image-message attachments keyed by role.
 *
 * This is the *persisted* shape: parsed from the original `imeta` tags so the
 * `full` vs `thumb` classification stays explicit. Earlier we stored a flat
 * `MediaAttachment[]` and inferred role from filename or index — that broke
 * for any sender outside Few's exact filename convention.
 */
export type RoledAttachments = {
  full: ChatMediaAttachment | null;
  thumb: ChatMediaAttachment | null;
};

export function buildImageMessageContent(caption: string): string {
  const content: ImageMessageContent = { type: 'image', version: 1, caption };
  return JSON.stringify(content);
}

export function parseImageMessageContent(content: string): ImageMessageContent | null {
  try {
    const parsed = JSON.parse(content);
    // Strict version check: a future sender stamping `version: 2` must fail
    // closed on this older client rather than be silently coerced to v1 and
    // mis-rendered.
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.type !== 'image' ||
      parsed.version !== 1
    ) {
      return null;
    }
    return {
      type: 'image',
      version: 1,
      caption: typeof parsed.caption === 'string' ? parsed.caption : '',
    };
  } catch {
    return null;
  }
}

export function extractAttachmentsByRole(tags: string[][]): RoledAttachments {
  const result: RoledAttachments = { full: null, thumb: null };

  for (const tag of tags) {
    if (tag[0] !== 'imeta') continue;

    let role: string | undefined;
    for (let i = 1; i < tag.length; i++) {
      if (tag[i].startsWith('role ')) {
        role = tag[i].slice(5);
        break;
      }
    }

    const attachment = parseMediaImetaTag(tag);
    if (!attachment) continue;

    if (role === 'thumb') {
      result.thumb = attachment;
    } else {
      // role 'full' or missing (treat as full per spec)
      result.full = attachment;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Group image messages over the library (encrypted-media-v1). Built beside the
// legacy marmot-ts path above, which the old hooks still use until the cutover
// (S18); the legacy exports are deleted by the sweep (S22).
//
// Privacy: the only bytes that ever leave the device for Blossom are the
// library's ciphertext. The plaintext is held in the local decrypted cache only.
// ---------------------------------------------------------------------------

/** The kind-9 chat kind an image message travels as (a plain chat row, not a signal; kind registry `APP_RUMOR_KINDS`). */
const GROUP_IMAGE_MESSAGE_KIND = 9;

export const GROUP_MEDIA_VERSION = 'encrypted-media-v1' as const;

/** A parsed group attachment together with the exact imeta tag it was parsed from (what `decryptMedia` takes). */
export type GroupImageAttachment = {
  attachment: EngineMediaAttachment;
  imeta: string[];
};

export type GroupRoledAttachments = {
  full: GroupImageAttachment | null;
  thumb: GroupImageAttachment | null;
};

/**
 * Parses the `imeta` tags of a group image message with the library codec.
 *
 * Tags the codec rejects (legacy mip04 records, a `blurhash` field, an http or unsafe-host
 * Blossom locator, malformed hashes) are skipped, never partially trusted. A missing `role` is
 * `full`; the FIRST valid tag of a role wins, so a later duplicate cannot replace the attachment
 * a receiver already resolved.
 */
export function extractGroupAttachmentsByRole(tags: string[][]): GroupRoledAttachments {
  const result: GroupRoledAttachments = { full: null, thumb: null };
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== 'imeta') continue;
    const attachment = parseGroupMediaImetaTag(tag);
    if (!attachment) continue;
    const slot = groupImageRoleOf(tag);
    if (result[slot] === null) result[slot] = { attachment, imeta: [...tag] };
  }
  return result;
}

/**
 * Cache identity of a group attachment record. The ciphertext hash alone would let a forged
 * record (other nonce / plaintext hash) hit an honest record's cache slot and surface its
 * plaintext; binding all four fields makes every distinct record cache-distinct, so a forgery
 * always falls through to fetch + decrypt, where the AEAD rejects it.
 */
export function groupAttachmentFingerprint(attachment: {
  ciphertextSha256: string;
  plaintextSha256: string;
  nonce: string;
  version: string;
}): string {
  return `${attachment.ciphertextSha256}:${attachment.plaintextSha256}:${attachment.nonce}:${attachment.version}`;
}

/** The decrypted-media cache the service reads and writes (the few-media-blobs / few-media-meta stores). */
export interface GroupMediaCachePort {
  getBlob(groupId: string, fingerprint: string): Promise<{ bytes: Uint8Array; type: string } | null>;
  setBlob(groupId: string, fingerprint: string, data: { bytes: Uint8Array; type: string }): Promise<void>;
  addMessageRef(groupId: string, fingerprint: string, messageId: string): Promise<void>;
}

/** The slice of the library group handle the service uses (plus `SendableGroup` for the send). */
export interface GroupMediaGroup extends SendableGroup {
  /** The group's current MLS epoch (the library handle's getter): a commit racing a send is detected through it. */
  readonly epoch: bigint;
  encryptMedia(bytes: Uint8Array, options?: EncryptMediaOptions): Promise<EncryptedMedia>;
  decryptMedia(media: EncryptedMedia): Promise<Uint8Array>;
}

export interface GroupImageServiceDeps {
  /** The S6 sender (seam `SendGroupRumor`): its `prepare(...).send()` is the one way the kind-9 message goes out. */
  sender: Pick<GroupRumorSender, 'prepare'>;
  /** Uploads CIPHERTEXT to Blossom, resolves with the blob URL. Never handed plaintext. */
  upload: (ciphertext: Uint8Array) => Promise<string>;
  /** Fetches the ciphertext an attachment's locators name (hash-verified). */
  download: (attachment: EngineMediaAttachment, maxBytes: number) => Promise<Uint8Array>;
  cache: GroupMediaCachePort;
  /** Blossom server base URLs written into the imeta locators (`<server>/<ciphertext sha256>`). */
  blossomServers: readonly string[];
  /** Cache write failures are reported here and never fail a send or a load; default `console.warn`. */
  warn?: (message: string, error: unknown) => void;
  /** Largest full-image ciphertext a receiver accepts; default {@link MAX_GROUP_IMAGE_CIPHERTEXT_BYTES}. Thumbs: {@link MAX_GROUP_THUMB_CIPHERTEXT_BYTES}. */
  maxCiphertextBytes?: number;
  /** A load whose download has not settled by then fails (and frees its in-flight slot); default 60 s. */
  loadTimeoutMs?: number;
}

/** One processed image blob handed to `sendImage` (the plaintext bytes; they are encrypted before anything leaves). */
export interface GroupImageBlob {
  bytes: Uint8Array;
  /** `<width>x<height>` render hint. */
  dim?: string;
  /** thumbhash preview (the codec rejects `blurhash`). */
  thumbhash?: string;
}

export interface SendGroupImageInput {
  caption: string;
  full: GroupImageBlob;
  thumb: GroupImageBlob;
  /** Canonical media type of both blobs; default `image/webp`. */
  mediaType?: string;
  /** Filename stem; the blobs are `<stem>.webp` and `<stem>.thumb.webp`. Default `image`. */
  baseName?: string;
  /** 0..100 over both uploads. */
  onProgress?: (pct: number) => void;
}

export interface SentGroupImage {
  rumorId: string;
  createdAt: number;
  full: GroupImageAttachment;
  thumb: GroupImageAttachment;
}

export interface LoadGroupImageRef {
  /**
   * The imeta tag of the attachment (`GroupImageAttachment.imeta`). The attachment is parsed from THIS tag by the
   * service, never taken from a separately supplied record: the tag is also what `decryptMedia` authenticates, so
   * a record and a tag that disagree cannot cache one record's plaintext under another's identity.
   */
  imeta: readonly string[];
  /** The message carrying the attachment: recorded as a reference of the cached blob. */
  messageId?: string;
}

export interface GroupImageService {
  /**
   * Encrypts both blobs with `group.encryptMedia`, uploads the two ciphertexts, then sends ONE kind-9 image
   * message whose imeta tags are the library's. Rejects (nothing sent) when encryption or an upload fails;
   * rejects with the sender's error when the send fails. After a successful send the plaintext is cached
   * (best effort: a cache failure never fails a published send).
   */
  sendImage(group: GroupMediaGroup, input: SendGroupImageInput): Promise<SentGroupImage>;
  /**
   * The decrypted image for an attachment. A cache hit is served WITHOUT downloading or calling
   * `decryptMedia` (this is what keeps an already-decrypted image after a reload); a miss downloads the
   * ciphertext, decrypts it through `group.decryptMedia` and caches the plaintext. Concurrent loads of one
   * attachment share one download + decrypt.
   */
  loadImage(group: Pick<GroupMediaGroup, 'id' | 'decryptMedia'>, ref: LoadGroupImageRef): Promise<{ bytes: Uint8Array; type: string }>;
}

/** AEAD tag and framing slack on top of a plaintext cap. */
const CIPHERTEXT_SLACK_BYTES = 1024;

/** Largest full-size image: plaintext on send, plaintext plus AEAD slack as ciphertext on receive. */
export const MAX_GROUP_IMAGE_BYTES = MAX_OUTPUT_BYTES;
/** Largest ciphertext a receiver downloads for a full image: the 5 MB output cap plus the AEAD tag, with slack. */
export const MAX_GROUP_IMAGE_CIPHERTEXT_BYTES = MAX_GROUP_IMAGE_BYTES + CIPHERTEXT_SLACK_BYTES;
/** Largest thumbnail (a 320 px preview is tens of KB): plaintext on send. */
export const MAX_GROUP_THUMB_BYTES = 512 * 1024;
/** Largest ciphertext a receiver downloads for a thumbnail. */
export const MAX_GROUP_THUMB_CIPHERTEXT_BYTES = MAX_GROUP_THUMB_BYTES + CIPHERTEXT_SLACK_BYTES;

/**
 * Media types a group image may carry, on send and on receive: the raster formats the app produces and renders.
 * An explicit allowlist, not a prefix test: `image/svg+xml` is an active-content format and must never reach an
 * `<img>`/blob URL of this origin from a sender's say-so.
 */
export const GROUP_IMAGE_MEDIA_TYPES: readonly string[] = ['image/webp', 'image/jpeg', 'image/png', 'image/gif'];

/** Canonical form of a caller-supplied media type: trimmed, lower-cased, `image/jpg` aliased to `image/jpeg`. */
function canonicalImageType(mediaType: string): string {
  const t = mediaType.trim().toLowerCase();
  return t === 'image/jpg' ? 'image/jpeg' : t;
}

function assertGroupImageType(mediaType: string, what: string): void {
  if (!GROUP_IMAGE_MEDIA_TYPES.includes(mediaType)) {
    throw new GroupMediaError('unsupported-media-type', `refusing to ${what} a ${mediaType} attachment as an image`);
  }
}

const DEFAULT_LOAD_TIMEOUT_MS = 60_000;

export class GroupMediaError extends Error {
  constructor(
    public readonly code:
      | 'unsupported-media-type'
      | 'too-large'
      | 'plaintext-upload-refused'
      | 'bad-upload'
      | 'invalid-attachment'
      | 'epoch-advanced'
      | 'load-timeout',
    message: string,
  ) {
    super(message);
    this.name = 'GroupMediaError';
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function requireFn(deps: object, name: string): void {
  if (typeof (deps as Record<string, unknown>)[name] !== 'function') {
    throw new TypeError(`createGroupImageService: ${name} is required`);
  }
}

export function createGroupImageService(deps: GroupImageServiceDeps): GroupImageService {
  if (!deps || typeof deps !== 'object') throw new TypeError('createGroupImageService: deps are required');
  if (!deps.sender || typeof deps.sender.prepare !== 'function') throw new TypeError('createGroupImageService: sender.prepare is required');
  requireFn(deps, 'upload');
  requireFn(deps, 'download');
  if (
    !deps.cache ||
    typeof deps.cache.getBlob !== 'function' ||
    typeof deps.cache.setBlob !== 'function' ||
    typeof deps.cache.addMessageRef !== 'function'
  ) {
    throw new TypeError('createGroupImageService: cache (getBlob, setBlob, addMessageRef) is required');
  }
  if (!Array.isArray(deps.blossomServers) || deps.blossomServers.length === 0 || deps.blossomServers.some((s) => typeof s !== 'string' || s === '')) {
    throw new TypeError('createGroupImageService: blossomServers must be a non-empty list of URLs');
  }
  const { sender, upload, download, cache } = deps;
  const blossomServers = deps.blossomServers.map((s) => s.replace(/\/+$/, ''));
  const warn = deps.warn ?? ((message: string, error: unknown) => console.warn(message, error));
  const maxCiphertextBytes = deps.maxCiphertextBytes ?? MAX_GROUP_IMAGE_CIPHERTEXT_BYTES;
  const loadTimeoutMs = deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const inFlight = new Map<string, Promise<{ bytes: Uint8Array; type: string }>>();

  async function encryptAndUpload(
    group: GroupMediaGroup,
    blob: GroupImageBlob,
    filename: string,
    mediaType: string,
    role: GroupImageRole,
    report: (pct: number) => void,
  ): Promise<{ tag: string[]; attachment: EngineMediaAttachment; plaintext: Uint8Array }> {
    const enc = await group.encryptMedia(blob.bytes, {
      mediaType,
      filename,
      ...(blob.dim !== undefined ? { dim: blob.dim } : {}),
      ...(blob.thumbhash !== undefined ? { thumbhash: blob.thumbhash } : {}),
      blossomServers,
    });
    // Never upload plaintext: the library's ciphertext must differ from the input and be non-empty.
    if (!(enc.ciphertext instanceof Uint8Array) || enc.ciphertext.length === 0 || sameBytes(enc.ciphertext, blob.bytes)) {
      throw new GroupMediaError('plaintext-upload-refused', 'encryptMedia did not return ciphertext; refusing to upload');
    }
    // Validate the tags BEFORE the upload: a tag no receiver could render must not cost an upload.
    const tag = buildGroupImetaTag(enc.imeta, role);
    const attachment = parseGroupMediaImetaTag(tag);
    if (!attachment) throw new GroupMediaError('bad-upload', 'unreachable: validated imeta tag does not parse');
    assertGroupImageType(attachment.mediaType, 'send');
    const url = await upload(enc.ciphertext);
    if (!attachment.locators.some((l) => l.kind === 'blossom-v1' && locatorMatchesUpload(l.value, url, attachment.ciphertextSha256))) {
      throw new GroupMediaError('bad-upload', 'the Blossom server did not store the blob the imeta locator names');
    }
    report(100);
    return { tag, attachment, plaintext: blob.bytes };
  }

  // A send that fails after an upload (thumb upload, epoch race, publish) leaves that ciphertext on the Blossom
  // server: blossomClient has no authenticated DELETE, so this is an accepted residual (S7 result.json). The blob
  // is ciphertext only, unreferenced by any message.

  async function sendImage(group: GroupMediaGroup, input: SendGroupImageInput): Promise<SentGroupImage> {
    if (typeof group.epoch !== 'bigint') throw new TypeError('sendImage: group.epoch (bigint) is required');
    const mediaType = canonicalImageType(input.mediaType ?? 'image/webp');
    assertGroupImageType(mediaType, 'send');
    if (input.full.bytes.length > MAX_GROUP_IMAGE_BYTES) {
      throw new GroupMediaError('too-large', `image of ${input.full.bytes.length} bytes exceeds ${MAX_GROUP_IMAGE_BYTES}`);
    }
    if (input.thumb.bytes.length > MAX_GROUP_THUMB_BYTES) {
      throw new GroupMediaError('too-large', `thumbnail of ${input.thumb.bytes.length} bytes exceeds ${MAX_GROUP_THUMB_BYTES}`);
    }
    const stem = input.baseName && input.baseName !== '' ? input.baseName : 'image';
    input.onProgress?.(0);
    // Progress never runs backwards or twice: an epoch retry reports only what exceeds the first round's high-water mark.
    let reported = 0;

    let full!: Awaited<ReturnType<typeof encryptAndUpload>>;
    let thumb!: Awaited<ReturnType<typeof encryptAndUpload>>;
    // A commit between the encryption and the send would leave the media encrypted under a superseded epoch's
    // keys: re-encrypt and re-upload once, then give up with a retryable error rather than publish it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const epoch = group.epoch;
      let done = 0;
      const report = (pct: number) => {
        const overall = Math.round((done * 100 + pct) / 2);
        if (overall > reported) {
          reported = overall;
          input.onProgress?.(overall);
        }
      };
      full = await encryptAndUpload(group, input.full, `${stem}.webp`, mediaType, 'full', (p) => {
        report(p);
        done = 1;
      });
      thumb = await encryptAndUpload(group, input.thumb, `${stem}.thumb.webp`, mediaType, 'thumb', report);
      if (group.epoch === epoch) break;
      if (attempt === 1) {
        throw new GroupMediaError('epoch-advanced', 'the group changed epoch while the image was being sent; try again');
      }
    }

    const prepared = sender.prepare(group, GROUP_IMAGE_MESSAGE_KIND, buildImageMessageContent(input.caption), [full.tag, thumb.tag]);
    await prepared.send();

    // Published: the send is a success whatever happens next. The cache is a sender-side convenience
    // (the image re-downloads and decrypts like any receiver's otherwise); failing here would invite a
    // retry that publishes a duplicate message.
    try {
      const fullKey = groupAttachmentFingerprint({ ...full.attachment, version: GROUP_MEDIA_VERSION });
      const thumbKey = groupAttachmentFingerprint({ ...thumb.attachment, version: GROUP_MEDIA_VERSION });
      await Promise.all([
        cache.setBlob(group.id, fullKey, { bytes: full.plaintext, type: full.attachment.mediaType }),
        cache.setBlob(group.id, thumbKey, { bytes: thumb.plaintext, type: thumb.attachment.mediaType }),
        cache.addMessageRef(group.id, fullKey, prepared.id),
        cache.addMessageRef(group.id, thumbKey, prepared.id),
      ]);
    } catch (err) {
      warn('[groupImageService] post-publish cache write failed; the image will be fetched and decrypted on reload', err);
    }
    return {
      rumorId: prepared.id,
      createdAt: prepared.rumor.created_at,
      full: { attachment: full.attachment, imeta: full.tag },
      thumb: { attachment: thumb.attachment, imeta: thumb.tag },
    };
  }

  async function loadImage(group: Pick<GroupMediaGroup, 'id' | 'decryptMedia'>, ref: LoadGroupImageRef): Promise<{ bytes: Uint8Array; type: string }> {
    // Untrusted sender input: the attachment is derived from the very tag `decryptMedia` will authenticate.
    if (!ref || !Array.isArray(ref.imeta)) throw new GroupMediaError('invalid-attachment', 'loadImage: imeta tag is required');
    const imeta = [...ref.imeta];
    const attachment = parseGroupMediaImetaTag(imeta);
    if (!attachment) throw new GroupMediaError('invalid-attachment', 'loadImage: not a valid encrypted-media-v1 imeta tag');
    // Only raster images are fetched, cached or served, hit or miss.
    assertGroupImageType(attachment.mediaType, 'load');
    const role = groupImageRoleOf(imeta);
    const cap = role === 'thumb' ? MAX_GROUP_THUMB_CIPHERTEXT_BYTES : maxCiphertextBytes;
    const fingerprint = groupAttachmentFingerprint(attachment);
    // The role is part of the key: a thumb-role request must not impose its smaller cap on a concurrent full load.
    const flightKey = `${group.id}:${role}:${fingerprint}`;
    const existing = inFlight.get(flightKey);
    if (existing) {
      // The shared load records only its first caller's message; this caller's message is noted once it settles.
      const shared = await existing;
      await noteRef(group.id, fingerprint, ref.messageId);
      return shared;
    }
    const work = (async () => {
      const cached = await cache.getBlob(group.id, fingerprint);
      if (cached) {
        await noteRef(group.id, fingerprint, ref.messageId);
        return { bytes: cached.bytes, type: cached.type };
      }
      const ciphertext = await withTimeout(download(attachment, cap), loadTimeoutMs);
      if (ciphertext.length > cap) {
        throw new GroupMediaError('too-large', `ciphertext of ${ciphertext.length} bytes exceeds ${cap}`);
      }
      const bytes = await group.decryptMedia({ ciphertext, imeta: [imeta], locator: attachment.ciphertextSha256 });
      const decrypted = { bytes, type: attachment.mediaType };
      try {
        await cache.setBlob(group.id, fingerprint, decrypted);
        await noteRef(group.id, fingerprint, ref.messageId);
      } catch (err) {
        warn('[groupImageService] cache write failed; the image decrypts again next time', err);
      }
      return decrypted;
    })();
    inFlight.set(flightKey, work);
    // Settled either way: the entry is dropped, and a failure with no consumer left is not an unhandled rejection.
    work.then(
      () => inFlight.delete(flightKey),
      () => inFlight.delete(flightKey),
    );
    return work;
  }

  async function noteRef(groupId: string, fingerprint: string, messageId: string | undefined): Promise<void> {
    if (messageId === undefined) return;
    try {
      await cache.addMessageRef(groupId, fingerprint, messageId);
    } catch (err) {
      warn('[groupImageService] message ref write failed', err);
    }
  }

  return { sendImage, loadImage };
}

/**
 * Whether the URL the Blossom server returned names the blob the locator names: a Blossom blob is
 * addressed by its SHA-256 (optionally with a file extension), so the last path segment must be the
 * ciphertext hash. A server that stored something else (or answered with another blob's URL) is refused.
 */
function locatorMatchesUpload(locatorValue: string, uploadedUrl: string, ciphertextSha256: string): boolean {
  try {
    const uploaded = new URL(uploadedUrl);
    const locator = new URL(locatorValue);
    // The blob must live on the server the locator names, not merely carry the right file name.
    if (uploaded.origin !== locator.origin) return false;
    const last = uploaded.pathname.split('/').pop() ?? '';
    return last.replace(/\.[A-Za-z0-9]+$/, '') === ciphertextSha256 && locator.pathname.split('/').pop() === ciphertextSha256;
  } catch {
    return false;
  }
}

/** Settles with `promise`, or rejects `load-timeout` after `ms`; the timer never outlives the race. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GroupMediaError('load-timeout', `the download did not finish within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
