import { useState, useEffect, useRef } from 'react';
import { useMarmot } from '@/src/context/MarmotContext';
import { getBlob, setBlob, attachmentFingerprint } from '@/src/lib/marmot/mediaPersistence';
import { BlossomNotFoundError } from '@/src/lib/media/blossomClient';
import type { ChatMediaAttachment, DirectMediaAttachment } from '@/src/lib/media/imageMessage';

type State =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'decrypt-failed' }
  | { status: 'not-found' };

type DecryptedMedia = { bytes: Uint8Array; type: string };

type DecryptMediaFn = (attachment: ChatMediaAttachment) => Promise<DecryptedMedia>;

// Dedup the fetch+decrypt+cache work — NOT the resulting object URL.
// Sharing object URLs across consumers makes per-consumer revoke() unsafe;
// each hook instance must own its own URL.
const inFlightDecrypts = new Map<string, Promise<DecryptedMedia>>();

export function __resetInFlightForTests(): void {
  inFlightDecrypts.clear();
}

export async function fetchDecryptedMedia(
  groupId: string,
  attachment: DirectMediaAttachment,
  decryptMedia: DecryptMediaFn,
): Promise<DecryptedMedia> {
  const fingerprint = attachmentFingerprint(attachment);
  const cached = await getBlob(groupId, fingerprint);
  if (cached) {
    return { bytes: cached.bytes, type: cached.type };
  }

  const key = `${groupId}:${fingerprint}`;
  if (!inFlightDecrypts.has(key)) {
    const promise = (async () => {
      const decrypted = await decryptMedia(attachment);

      await setBlob(groupId, fingerprint, { bytes: decrypted.bytes, type: decrypted.type });
      return decrypted;
    })();

    inFlightDecrypts.set(key, promise);
    // .finally() returns a new promise that re-rejects on the original
    // rejection — swallow it here so a failed fetch with no consumer attached
    // (e.g. cancelled callers) does not surface as an unhandled rejection.
    promise.finally(() => inFlightDecrypts.delete(key)).catch(() => {});
  }

  return inFlightDecrypts.get(key)!;
}

export class ObjectUrlSlot {
  private url: string | null = null;

  set(blob: Blob): string {
    this.revoke();
    this.url = URL.createObjectURL(blob);
    return this.url;
  }

  revoke(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }

  get current(): string | null {
    return this.url;
  }
}

export function useDecryptedImage(
  groupId: string,
  attachment: ChatMediaAttachment | null | undefined,
  decryptMedia?: DecryptMediaFn,
): State {
  const [state, setState] = useState<State>({ status: 'loading' });
  const { getGroup, groupImages } = useMarmot();
  const slotRef = useRef<ObjectUrlSlot | null>(null);
  if (slotRef.current === null) slotRef.current = new ObjectUrlSlot();

  // Group loading reads the original imeta, including its role and locators.
  // The direct decryptor also uses the URL and type beyond the cache fingerprint.
  const attachmentKey = !attachment ? null : 'imeta' in attachment
    ? JSON.stringify(['group', attachment.imeta])
    : JSON.stringify(['direct', attachmentFingerprint(attachment), attachment.url, attachment.type]);

  useEffect(() => {
    const slot = slotRef.current!;
    let cancelled = false;

    if (!attachment) {
      slot.revoke();
      setState({ status: 'loading' });
      return;
    }

    setState({ status: 'loading' });

    const load = 'imeta' in attachment
      ? (async () => {
          if (!groupImages) throw new Error('Group image service unavailable');
          const group = await getGroup(groupId);
          if (!group) throw new Error('Group not found');
          return groupImages.loadImage(group, { imeta: attachment.imeta });
        })()
      : decryptMedia
        ? fetchDecryptedMedia(groupId, attachment, decryptMedia)
        : Promise.reject(new Error('Direct image decryptor unavailable'));
    load
      .then(({ bytes, type }) => {
        if (cancelled) return;
        const url = slot.set(new Blob([bytes as unknown as BlobPart], { type }));
        setState({ status: 'ready', url });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof BlossomNotFoundError) {
          setState({ status: 'not-found' });
        } else {
          setState({ status: 'decrypt-failed' });
        }
      });

    return () => {
      cancelled = true;
      slot.revoke();
    };
    // The key contains the inputs to loading, independent of row object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, attachmentKey, decryptMedia, getGroup, groupImages]);

  return state;
}
