import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BASE64_BYTES, readImageSize, validateImage } from '../src/images.ts';
import { TINY_JPEG, TINY_PNG } from './fakes.ts';

describe('readImageSize', () => {
  it('reads JPEG and PNG headers', () => {
    expect(readImageSize(Buffer.from(TINY_JPEG, 'base64'), 'image/jpeg')).toEqual({
      width: 28,
      height: 28,
    });
    expect(readImageSize(Buffer.from(TINY_PNG, 'base64'), 'image/png')).toEqual({
      width: 28,
      height: 28,
    });
  });

  it('reads GIF and WebP headers', () => {
    const gif = Buffer.from('474946383961' + '0a00' + '0500', 'hex');
    expect(readImageSize(gif, 'image/gif')).toEqual({ width: 10, height: 5 });
    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF', 0, 'latin1');
    vp8x.write('WEBPVP8X', 8, 'latin1');
    vp8x.writeUIntLE(99, 24, 3);
    vp8x.writeUIntLE(49, 27, 3);
    expect(readImageSize(vp8x, 'image/webp')).toEqual({ width: 100, height: 50 });
  });

  it('returns null for headers it does not understand', () => {
    expect(readImageSize(Buffer.from('nope'), 'image/png')).toBeNull();
    expect(
      readImageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]), 'image/jpeg'),
    ).toBeNull();
  });
});

describe('validateImage', () => {
  const ok = { mediaType: 'image/jpeg' as const, base64: TINY_JPEG, width: 28, height: 28 };

  it('accepts a real image whose header matches its declared size', () => {
    expect(() => {
      validateImage(ok);
    }).not.toThrow();
  });

  it('refuses dimensions that disagree with the header, which would break the cost estimate', () => {
    expect(() => {
      validateImage({ ...ok, width: 30 });
    }).toThrow(expect.objectContaining({ code: 'ai_input_invalid' }));
  });

  it('refuses oversized payloads', () => {
    expect(() => {
      validateImage({ ...ok, base64: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 4) });
    }).toThrow(expect.objectContaining({ code: 'ai_input_invalid' }));
  });
});
