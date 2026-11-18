import type { MarmotGroup } from '@941design/marmot';
import type { GroupImageService, SentGroupImage } from '@/src/lib/media/imageMessage';
import { MAX_OUTPUT_BYTES } from '@/src/config/blossom';

export type SendProgress = 'processing' | { status: 'uploading'; pct: number } | 'sent' | 'failed';

export async function sendImageMessage(
  file: File,
  caption: string,
  deps: { group: MarmotGroup; groupImages: GroupImageService; onProgress: (p: SendProgress) => void; onPrepared?: (image: SentGroupImage) => void },
) {
  const { group, groupImages, onProgress } = deps;
  onProgress('processing');
  try {
    const { processImage, ImageTooLargeError } = await import('@/src/lib/media/imageProcessing');
    const processed = await processImage(file);
    if (processed.full.blob.size > MAX_OUTPUT_BYTES) throw new ImageTooLargeError();
    const result = await groupImages.sendImage(group, {
      caption,
      onPrepared: deps.onPrepared,
      full: { bytes: new Uint8Array(await processed.full.blob.arrayBuffer()), dim: processed.full.dimensions },
      thumb: { bytes: new Uint8Array(await processed.thumb.blob.arrayBuffer()), dim: processed.thumb.dimensions },
      baseName: file.name.replace(/\.[^.]+$/, '') || 'image',
      onProgress: pct => onProgress({ status: 'uploading', pct }),
    });
    onProgress('sent');
    return result;
  } catch (error) {
    onProgress('failed');
    throw error;
  }
}
