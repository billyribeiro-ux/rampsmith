/**
 * Prepares a product image for an alt-text call (PLAN §13): decodes it with `sharp`, turns it
 * to its display orientation, shrinks it to the 1008 px long edge the cost model assumes and
 * writes it again without any metadata, so EXIF, XMP, IPTC and comments (which can hold names
 * and locations) never reach the model. Image bytes are never logged (PLAN §19).
 */
import { ALT_TEXT_LONG_EDGE, type ImageInput } from '@rampsmith/ai';
import { JobFailure } from '@rampsmith/queue';
import sharp from 'sharp';

/** Formats the engine decodes. SVG, PDF and the rest of libvips' loaders stay off. */
const DECODABLE = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff']);

/** Larger downloads are refused before they are decoded. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** A decompression-bomb guard: sharp refuses images with more pixels than this. */
const MAX_SOURCE_PIXELS = 100_000_000;
const JPEG_QUALITY = 85;

function unreadable(message: string): JobFailure {
  return new JobFailure('permanent', { code: 'image_unreadable', message });
}

/**
 * Returns the image as the JPEG (or, with transparency, PNG) that `@rampsmith/ai` sends. Only
 * the first frame of an animation is kept.
 */
export async function prepareImage(source: Uint8Array): Promise<ImageInput> {
  if (source.byteLength === 0 || source.byteLength > MAX_SOURCE_BYTES) {
    throw unreadable('the image is empty or larger than 25 MB');
  }
  try {
    const options = { limitInputPixels: MAX_SOURCE_PIXELS, failOn: 'error' } as const;
    const meta = await sharp(source, options).metadata();
    if (!DECODABLE.has(meta.format)) {
      throw unreadable('the image format is not supported');
    }
    const pipeline = sharp(source, options).rotate().resize({
      width: ALT_TEXT_LONG_EDGE,
      height: ALT_TEXT_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const transparent = meta.hasAlpha;
    const { data, info } = await (
      transparent ? pipeline.png() : pipeline.jpeg({ quality: JPEG_QUALITY })
    ).toBuffer({ resolveWithObject: true });
    return {
      mediaType: transparent ? 'image/png' : 'image/jpeg',
      base64: data.toString('base64'),
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    if (error instanceof JobFailure) throw error;
    // sharp's messages can name a file or a codec, never the pixels; keep only a fixed text.
    throw unreadable('the image could not be decoded');
  }
}
