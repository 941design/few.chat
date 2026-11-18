import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/media/imageProcessing', () => ({
  processImage: vi.fn(),
  ImageTooLargeError: class ImageTooLargeError extends Error {},
}));

const { processImage, ImageTooLargeError } = await import('@/src/lib/media/imageProcessing');
const { sendImageMessage } = await import('@/src/hooks/useImageSend');
const file = new File(['input'], 'photo.jpg', { type: 'image/jpeg' });
const processed = () => ({
  full: { blob: new Blob([new Uint8Array([1, 2])]), dimensions: '800x600' },
  thumb: { blob: new Blob([new Uint8Array([3])]), dimensions: '320x240' },
});
const group = {} as never;
const result = { rumorId: 'canonical', createdAt: 123, full: {}, thumb: {} } as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(processImage).mockResolvedValue(processed() as never);
});

describe('sendImageMessage', () => {
  it('processes the file and passes bytes, dimensions, caption and callbacks to the image service', async () => {
    const progress = vi.fn();
    const prepared = vi.fn();
    const sendImage = vi.fn(async (_group, input) => {
      input.onProgress(42);
      input.onPrepared(result);
      return result;
    });
    const sent = await sendImageMessage(file, 'hello', { group, groupImages: { sendImage } as never, onProgress: progress, onPrepared: prepared });
    expect(processImage).toHaveBeenCalledWith(file);
    expect(sendImage).toHaveBeenCalledWith(group, expect.objectContaining({
      caption: 'hello', baseName: 'photo',
      full: { bytes: new Uint8Array([1, 2]), dim: '800x600' },
      thumb: { bytes: new Uint8Array([3]), dim: '320x240' },
    }));
    expect(processImage.mock.invocationCallOrder[0]).toBeLessThan(sendImage.mock.invocationCallOrder[0]);
    expect(progress.mock.calls).toEqual([['processing'], [{ status: 'uploading', pct: 42 }], ['sent']]);
    expect(prepared).toHaveBeenCalledWith(result);
    expect(sent).toBe(result);
  });

  it('reports processing failure without invoking the service', async () => {
    vi.mocked(processImage).mockRejectedValueOnce(new ImageTooLargeError());
    const sendImage = vi.fn();
    const progress = vi.fn();
    await expect(sendImageMessage(file, '', { group, groupImages: { sendImage } as never, onProgress: progress })).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(sendImage).not.toHaveBeenCalled();
    expect(progress.mock.calls).toEqual([['processing'], ['failed']]);
  });

  it('reports service failure and permits a subsequent attempt', async () => {
    const sendImage = vi.fn().mockRejectedValueOnce(new Error('upload failed')).mockResolvedValueOnce(result);
    const progress = vi.fn();
    const deps = { group, groupImages: { sendImage } as never, onProgress: progress };
    await expect(sendImageMessage(file, '', deps)).rejects.toThrow('upload failed');
    await expect(sendImageMessage(file, '', deps)).resolves.toBe(result);
    expect(progress.mock.calls).toEqual([['processing'], ['failed'], ['processing'], ['sent']]);
    expect(sendImage).toHaveBeenCalledTimes(2);
  });
});
