/**
 * Image input for vision calls (https://platform.claude.com/docs/en/build-with-claude/vision):
 * JPEG, PNG, GIF or WebP, base64-encoded. The engine resizes each product image with `sharp`
 * to a 1008 px long edge first (PLAN §13), so a call never costs more than the cost model
 * assumes; this module refuses anything else before it reaches the API.
 */
import type { ImageBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { ALT_TEXT_LONG_EDGE } from './cost.ts';
import { AiError } from './errors.ts';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageInput {
  readonly mediaType: ImageMediaType;
  /** The image bytes, base64-encoded. */
  readonly base64: string;
  /** Dimensions after the engine's resize. */
  readonly width: number;
  readonly height: number;
}

/** Well below the API's 10 MB, and inside the 5 MB that Bedrock and Google Cloud allow. */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

function hasSignature(mediaType: ImageMediaType, bytes: Buffer): boolean {
  switch (mediaType) {
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':
      return bytes.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp':
      return (
        bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
        bytes.subarray(8, 12).toString('latin1') === 'WEBP'
      );
  }
}

/**
 * Checks an image before it is sent: an allowed media type, valid base64 within the size
 * limit, bytes that really are that format (an HTML error page from a CDN is not an image),
 * and dimensions inside the resize target.
 */
export function validateImage(image: ImageInput, maxLongEdge: number = ALT_TEXT_LONG_EDGE): void {
  const types: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!types.includes(image.mediaType)) {
    throw new AiError('ai_input_invalid', 'the image media type is not supported');
  }
  if (image.base64.length === 0 || image.base64.length > MAX_IMAGE_BASE64_BYTES) {
    throw new AiError('ai_input_invalid', 'the image is empty or larger than 5 MB in base64');
  }
  if (image.base64.length % 4 !== 0 || !BASE64.test(image.base64)) {
    throw new AiError('ai_input_invalid', 'the image is not valid base64');
  }
  const head = Buffer.from(image.base64.slice(0, 32), 'base64');
  if (!hasSignature(image.mediaType, head)) {
    throw new AiError('ai_input_invalid', 'the image bytes do not match its media type');
  }
  const { width, height } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    Math.max(width, height) > maxLongEdge
  ) {
    throw new AiError(
      'ai_input_invalid',
      `the image must be resized to at most ${String(maxLongEdge)} px on its long edge`,
    );
  }
}

export function imageBlock(image: ImageInput): ImageBlockParam {
  return {
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
  };
}
