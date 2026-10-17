import { describe, expect, it } from 'vitest';
import { auditMediaAlt } from '../src/data/media-alt.ts';
import { fileStem, filenamePattern } from '../src/data/filename.ts';

const resource = 'gid://shopify/MediaImage/7';

describe('auditMediaAlt', () => {
  it('flags missing, empty and blank alt text', () => {
    for (const alt of [null, '', '   ']) {
      const [f, ...rest] = auditMediaAlt({ resource, alt });
      expect(rest).toEqual([]);
      expect(f).toMatchObject({
        ruleId: 'rs-media-alt-empty',
        criteria: ['1.1.1'],
        impact: 'serious',
        outcome: 'violation',
        bestPractice: false,
        location: { resource, field: 'alt', start: 0, end: (alt ?? '').length },
      });
    }
  });

  it('flags filename-like alt text with the pattern that matched', () => {
    expect(auditMediaAlt({ resource, alt: 'IMG_1234.JPG' })[0]).toMatchObject({
      ruleId: 'rs-media-alt-filename',
      data: { pattern: 'extension' },
      location: { start: 0, end: 12 },
    });
    expect(auditMediaAlt({ resource, alt: 'DSC01234' })[0]?.data).toEqual({ pattern: 'camera' });
    expect(
      auditMediaAlt({
        resource,
        alt: 'blue-dress',
        fileName: 'https://cdn.example.test/files/blue-dress.jpg?v=1',
      })[0]?.data,
    ).toEqual({ pattern: 'matches-file-name' });
  });

  it('accepts descriptive alt text', () => {
    for (const alt of [
      'Blue linen dress, front view',
      '2-pack of wool socks',
      'T-shirt',
      'Model wearing the jacket',
    ]) {
      expect(auditMediaAlt({ resource, alt, fileName: 'IMG_0001.jpg' })).toEqual([]);
    }
  });
});

describe('filenamePattern', () => {
  it('recognises each pattern', () => {
    expect(filenamePattern('photo.webp')).toBe('extension');
    expect(filenamePattern('Screenshot 2026-10-01 at 10.00.00')).toBe('camera');
    expect(filenamePattern('PXL_20261001_101010')).toBe('camera');
    expect(filenamePattern('banner_1200x600')).toBe('dimensions');
    expect(filenamePattern('front_view_final')).toBe('underscore');
    expect(filenamePattern('3f2a9c1e-4b5d-4e6f-8a7b-9c0d1e2f3a4b')).toBe('hash');
    expect(filenamePattern('Front', 'front.png')).toBe('matches-file-name');
  });

  it('returns null for empty or ordinary text', () => {
    expect(filenamePattern('   ')).toBeNull();
    expect(filenamePattern('Size 10 shoe in black')).toBeNull();
    expect(filenamePattern('decaf', 'deadbeef.png')).toBeNull();
  });
});

describe('fileStem', () => {
  it('strips directories, query strings and the extension', () => {
    expect(fileStem('https://cdn.example.test/a/b/c.d.jpg?v=2#x')).toBe('c.d');
    expect(fileStem('plain')).toBe('plain');
    expect(fileStem('.hidden')).toBe('.hidden');
  });
});
