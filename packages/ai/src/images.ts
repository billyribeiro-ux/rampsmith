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
 * Reads an image's pixel size from its header: JPEG (SOFn marker), PNG (IHDR), GIF (logical
 * screen) and WebP (VP8, VP8L and VP8X). Returns `null` when the header is not understood.
 */
export function readImageSize(
  bytes: Buffer,
  mediaType: ImageMediaType,
): { width: number; height: number } | null {
  switch (mediaType) {
    case 'image/png':
      return bytes.length >= 24 && bytes.subarray(12, 16).toString('latin1') === 'IHDR'
        ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
        : null;
    case 'image/gif':
      return bytes.length >= 10
        ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
        : null;
    case 'image/webp': {
      const chunk = bytes.subarray(12, 16).toString('latin1');
      if (chunk === 'VP8 ' && bytes.length >= 30) {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L' && bytes.length >= 25) {
        const b = bytes.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X' && bytes.length >= 30) {
        return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
      }
      return null;
    }
    case 'image/jpeg': {
      let at = 2;
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) {
          return null;
        }
        const marker = bytes[at + 1] ?? 0;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          at += 2;
          continue;
        }
        const length = bytes.readUInt16BE(at + 2);
        const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isFrame) {
          return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
        }
        at += 2 + length;
      }
      return null;
    }
  }
}

/**
 * Whether the image carries embedded metadata that can hold personal data: EXIF, XMP, IPTC or
 * comments in JPEG; text or EXIF chunks in PNG; EXIF or XMP chunks in WebP; comment extensions
 * in GIF. The engine's `sharp` resize drops metadata unless told otherwise; this check holds
 * it to that (security audit LOW-11). Colour profiles are allowed.
 */
export function hasEmbeddedMetadata(bytes: Buffer, mediaType: ImageMediaType): boolean {
  switch (mediaType) {
    case 'image/jpeg': {
      let at = 2;
      while (at + 4 <= bytes.length && bytes[at] === 0xff) {
        const marker = bytes[at + 1] ?? 0;
        if (marker === 0xda || marker === 0xd9) {
          return false;
        }
        if (marker === 0xe1 || marker === 0xed || marker === 0xfe) {
          return true;
        }
        at += 2 + bytes.readUInt16BE(at + 2);
      }
      return false;
    }
    case 'image/png': {
      let at = 8;
      while (at + 8 <= bytes.length) {
        const length = bytes.readUInt32BE(at);
        const type = bytes.subarray(at + 4, at + 8).toString('latin1');
        if (['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)) {
          return true;
        }
        if (type === 'IEND') {
          return false;
        }
        at += 12 + length;
      }
      return false;
    }
    case 'image/webp': {
      let at = 12;
      while (at + 8 <= bytes.length) {
        const type = bytes.subarray(at, at + 4).toString('latin1');
        if (type === 'EXIF' || type === 'XMP ') {
          return true;
        }
        const size = bytes.readUInt32LE(at + 4);
        at += 8 + size + (size % 2);
      }
      return false;
    }
    case 'image/gif':
      return bytes.includes(Buffer.from([0x21, 0xfe]));
  }
}

/**
 * Checks an image before it is sent: an allowed media type, valid base64 within the size
 * limit, bytes that really are that format (an HTML error page from a CDN is not an image),
 * dimensions that match the header (the cost estimate depends on them) and that sit inside
 * the resize target.
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
  const bytes = Buffer.from(image.base64, 'base64');
  if (!hasSignature(image.mediaType, bytes)) {
    throw new AiError('ai_input_invalid', 'the image bytes do not match its media type');
  }
  if (hasEmbeddedMetadata(bytes, image.mediaType)) {
    throw new AiError('ai_input_invalid', 'the image carries embedded metadata; strip it first');
  }
  const { width, height } = image;
  const actual = readImageSize(bytes, image.mediaType);
  if (actual?.width !== width || actual.height !== height) {
    throw new AiError('ai_input_invalid', 'the image dimensions do not match its header');
  }
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
