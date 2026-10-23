import { validateImage } from '@rampsmith/ai';
import { JobFailure } from '@rampsmith/queue';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ALLOWED_LOADERS, prepareImage } from '../../src/ai/image.ts';

async function jpegWithMetadata(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#cc5500' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'Jane Doe, 12 Main Street', Artist: 'Jane Doe' } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><note>GPS 40.7,-74.0</note></x:xmpmeta>')
    .toBuffer();
}

describe('prepareImage (PLAN §13)', () => {
  it('shrinks to the 1008 px long edge, keeps the aspect ratio and strips every metadata block', async () => {
    const source = await jpegWithMetadata(2400, 1600);
    expect(source.toString('latin1')).toContain('Jane Doe');
    const image = await prepareImage(source);
    expect(image.mediaType).toBe('image/jpeg');
    expect(image.width).toBe(1008);
    expect(image.height).toBe(672);
    const bytes = Buffer.from(image.base64, 'base64');
    expect(bytes.toString('latin1')).not.toContain('Jane Doe');
    // What the AI package itself requires before a send.
    expect(() => {
      validateImage(image);
    }).not.toThrow();
  });

  it('does not enlarge a small image', async () => {
    const image = await prepareImage(await jpegWithMetadata(300, 200));
    expect([image.width, image.height]).toEqual([300, 200]);
  });

  it('turns an image to its display orientation', async () => {
    const source = await sharp({
      create: { width: 400, height: 200, channels: 3, background: '#336699' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const image = await prepareImage(source);
    expect([image.width, image.height]).toEqual([200, 400]);
  });

  it('keeps transparency as PNG and drops text chunks', async () => {
    const source = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    const image = await prepareImage(source);
    expect(image.mediaType).toBe('image/png');
    // validateImage refuses embedded metadata, text chunks included.
    expect(() => {
      validateImage(image);
    }).not.toThrow();
  });

  it('keeps the first frame of an animated GIF', async () => {
    const source = await sharp({
      create: { width: 40, height: 40, channels: 3, background: 'red' },
    })
      .gif()
      .toBuffer();
    const image = await prepareImage(source);
    expect([image.width, image.height]).toEqual([40, 40]);
  });

  it.each([
    ['empty input', Buffer.alloc(0)],
    ['text pretending to be an image', Buffer.from('<html>error page</html>')],
    [
      'an SVG, which the engine does not rasterise',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"></svg>'),
    ],
  ])('refuses %s permanently without echoing it', async (_name, source) => {
    const error: unknown = await prepareImage(source).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobFailure);
    const failure = (error as JobFailure).failure;
    expect(failure.kind).toBe('permanent');
    expect(failure.error.code).toBe('image_unreadable');
    expect(failure.error.message).not.toContain('html');
  });

  it('decodes every allowed format, so each loader name in ALLOWED_LOADERS matches the bundled libvips', async () => {
    const base = sharp({ create: { width: 24, height: 24, channels: 3, background: '#3366cc' } });
    const sources = {
      jpeg: await base.clone().jpeg().toBuffer(),
      png: await base.clone().png().toBuffer(),
      webp: await base.clone().webp().toBuffer(),
      gif: await base.clone().gif().toBuffer(),
      avif: await base.clone().avif().toBuffer(),
    };
    for (const [format, source] of Object.entries(sources)) {
      const image = await prepareImage(source);
      expect([image.width, image.height], format).toEqual([24, 24]);
    }
    expect(ALLOWED_LOADERS).toHaveLength(Object.keys(sources).length);
  });

  it('keeps SVG and TIFF loaders off, so libvips never parses them (security audit L1)', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><rect width="9" height="9"/></svg>',
    );
    const tiff = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#fff' },
    })
      .tiff()
      .toBuffer();
    for (const [name, source] of [
      ['svg', svg],
      ['tiff', tiff],
    ] as const) {
      // Not only refused by the format list: the loader itself is blocked, so sharp cannot even
      // read the metadata.
      await expect(sharp(source).metadata(), name).rejects.toThrow(/unsupported image format/i);
      const error: unknown = await prepareImage(source).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(JobFailure);
      expect((error as JobFailure).failure.error.code).toBe('image_unreadable');
    }
  });

  it('refuses a decompression bomb by pixel count', async () => {
    // 12000 x 12000 = 144 MP of one colour compresses to a few hundred KB.
    const bomb = await sharp({
      create: { width: 12000, height: 12000, channels: 3, background: '#fff' },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const error: unknown = await prepareImage(bomb).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobFailure);
  }, 120_000);
});
