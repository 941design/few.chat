import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect, useRef, useState } from 'react';
import { useMarmot } from '@/src/context/MarmotContext';
import type { ChatMediaAttachment, DirectMediaAttachment, GroupImageAttachment } from '@/src/lib/media/imageMessage';

vi.mock('@/src/lib/marmot/mediaPersistence', () => ({
  getBlob: vi.fn(),
  setBlob: vi.fn(),
  attachmentFingerprint: (a: DirectMediaAttachment) => `${a.sha256}:${a.nonce}:${a.version}`,
}));
vi.mock('@/src/context/MarmotContext', () => ({ useMarmot: vi.fn() }));
vi.mock('react', () => ({ useEffect: vi.fn(), useRef: vi.fn(), useState: vi.fn() }));

const { getBlob, setBlob } = await import('@/src/lib/marmot/mediaPersistence');
const { fetchDecryptedMedia, __resetInFlightForTests, ObjectUrlSlot, useDecryptedImage } = await import('@/src/hooks/useDecryptedImage');

const attachment: DirectMediaAttachment = {
  sha256: 'a'.repeat(64), type: 'image/webp', filename: 'photo.webp',
  nonce: 'b'.repeat(24), version: 'few-dm-media-v1',
};
const contents = { bytes: new Uint8Array([1, 2, 3]), type: 'image/webp' };

describe('useDecryptedImage effect lifetime', () => {
  let cleanup: void | (() => void);
  const setState = vi.fn();
  const getGroup = vi.fn();
  const loadImage = vi.fn();
  const decrypt = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    const ref = { current: null };
    let dependencies: readonly unknown[] | undefined;
    vi.mocked(useRef).mockReturnValue(ref);
    vi.mocked(useState).mockReturnValue([{ status: 'loading' }, setState]);
    vi.mocked(useEffect).mockImplementation((effect, next) => {
      if (dependencies && next?.every((value, i) => Object.is(value, dependencies?.[i]))) return;
      cleanup?.();
      dependencies = next;
      cleanup = effect();
    });
    getGroup.mockResolvedValue({ id: 'group' });
    loadImage.mockResolvedValue(contents);
    decrypt.mockResolvedValue(contents);
    vi.mocked(useMarmot).mockReturnValue({ getGroup, groupImages: { loadImage } } as unknown as ReturnType<typeof useMarmot>);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  const groupAttachment = {
    attachment: { nonce: 'first' },
    imeta: ['imeta', 'nonce first'],
  } as GroupImageAttachment;

  it.each([
    { kind: 'group', initial: groupAttachment, changed: { ...groupAttachment, imeta: ['imeta', 'nonce second'] }, loader: loadImage },
    { kind: 'direct', initial: attachment, changed: { ...attachment, nonce: 'c'.repeat(24) }, loader: decrypt },
  ])('keeps the $kind object URL across fresh rows and reloads for a changed nonce', async ({ initial, changed, loader }) => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const render = (value: ChatMediaAttachment) => useDecryptedImage('thread', value, decrypt);

    render(initial);
    await vi.waitFor(() => expect(setState).toHaveBeenLastCalledWith({ status: 'ready', url: expect.any(String) }));
    const { url } = setState.mock.lastCall![0];
    setState.mockClear();

    render(structuredClone(initial));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(setState).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();

    render(changed);
    expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
    expect(setState).toHaveBeenCalledWith({ status: 'loading' });
    await vi.waitFor(() => expect(setState).toHaveBeenLastCalledWith({ status: 'ready', url: expect.any(String) }));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(setState.mock.lastCall![0].url).not.toBe(url);
  });
});

describe('direct image decryption', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetInFlightForTests();
  });

  it('reads the cached plaintext without calling decrypt', async () => {
    vi.mocked(getBlob).mockResolvedValue(contents);
    const decrypt = vi.fn();
    await expect(fetchDecryptedMedia('dm:peer', attachment, decrypt)).resolves.toEqual(contents);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('shares an in-flight decrypt and caches the result under the full fingerprint', async () => {
    let finish!: (value: typeof contents) => void;
    const decrypt = vi.fn(() => new Promise<typeof contents>((resolve) => { finish = resolve; }));
    const first = fetchDecryptedMedia('dm:peer', attachment, decrypt);
    const second = fetchDecryptedMedia('dm:peer', attachment, decrypt);
    await vi.waitFor(() => expect(decrypt).toHaveBeenCalledTimes(1));
    finish(contents);
    await expect(Promise.all([first, second])).resolves.toEqual([contents, contents]);
    const fingerprint = `${attachment.sha256}:${attachment.nonce}:${attachment.version}`;
    expect(setBlob).toHaveBeenCalledExactlyOnceWith('dm:peer', fingerprint, contents);
  });

  it('does not reuse cached plaintext when the nonce changes', async () => {
    const decrypt = vi.fn().mockResolvedValue(contents);
    const changed = { ...attachment, nonce: 'c'.repeat(24) };
    await fetchDecryptedMedia('dm:peer', attachment, decrypt);
    await fetchDecryptedMedia('dm:peer', changed, decrypt);
    expect(decrypt.mock.calls).toEqual([[attachment], [changed]]);
    expect(vi.mocked(setBlob).mock.calls[0][1]).not.toBe(vi.mocked(setBlob).mock.calls[1][1]);
  });

  it('surfaces decrypt failure, with no cache write, and lets the caller retry', async () => {
    const error = new Error('bad ciphertext');
    const decrypt = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(contents);
    await expect(fetchDecryptedMedia('dm:peer', attachment, decrypt)).rejects.toBe(error);
    expect(setBlob).not.toHaveBeenCalled();
    await expect(fetchDecryptedMedia('dm:peer', attachment, decrypt)).resolves.toEqual(contents);
  });
});

describe('ObjectUrlSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if ((URL as any).createObjectURL?.mockClear) (URL as any).createObjectURL.mockClear();
    if ((URL as any).revokeObjectURL?.mockClear) (URL as any).revokeObjectURL.mockClear();
  });

  it('set() creates an object URL from the given blob and stores it', () => {
    const slot = new ObjectUrlSlot();
    const blob = new Blob([new Uint8Array([1, 2])], { type: 'image/webp' });
    const url = slot.set(blob);
    expect(url).toMatch(/^blob:/);
    expect(slot.current).toBe(url);
  });

  it('set() revokes the previous URL before creating a new one', () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const slot = new ObjectUrlSlot();
    const first = slot.set(new Blob([new Uint8Array([1])], { type: 'image/webp' }));
    const second = slot.set(new Blob([new Uint8Array([2])], { type: 'image/webp' }));

    expect(revokeSpy).toHaveBeenCalledWith(first);
    expect(slot.current).toBe(second);
    revokeSpy.mockRestore();
  });

  it('revoke() releases the current URL and clears the slot', () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const slot = new ObjectUrlSlot();
    const url = slot.set(new Blob([new Uint8Array([1])], { type: 'image/webp' }));
    slot.revoke();

    expect(revokeSpy).toHaveBeenCalledWith(url);
    expect(slot.current).toBeNull();
    revokeSpy.mockRestore();
  });

  it('revoke() is safe to call when slot is empty', () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const slot = new ObjectUrlSlot();
    expect(() => slot.revoke()).not.toThrow();
    expect(revokeSpy).not.toHaveBeenCalled();
    revokeSpy.mockRestore();
  });

  it('revoke() is idempotent', () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const slot = new ObjectUrlSlot();
    slot.set(new Blob([new Uint8Array([1])], { type: 'image/webp' }));
    slot.revoke();
    slot.revoke();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    revokeSpy.mockRestore();
  });
});
