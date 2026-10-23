import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The App Store listing's screenshots (LAUNCH.md section B): 3 to 6 PNG files of exactly
 * 1600 x 900 pixels, each with alt text in listing.md. Shopify's rule, read 23 October 2026
 * (ADR-301): "Screenshots should be 1600px by 900px (16:9)"; "Include 3-6 desktop screenshots";
 * "Provide alt text".
 */
const SHOTS = new URL('../../../../../listing/screenshots/', import.meta.url);
const LISTING = new URL('../../../../../listing/shopify-app-store/listing.md', import.meta.url);

function pngSize(file: URL): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  // The IHDR chunk follows the 8-byte signature: length, "IHDR", width, height.
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('listing screenshots', () => {
  const files = readdirSync(SHOTS).filter((name) => name.endsWith('.png'));

  it('are 3 to 6 files', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.length).toBeLessThanOrEqual(6);
  });

  it.each(files)('%s is 1600 x 900 pixels', (name) => {
    expect(pngSize(new URL(name, SHOTS))).toEqual({ width: 1600, height: 900 });
  });

  it('each has alt text in listing.md, without pricing or outcome promises', () => {
    const listing = readFileSync(LISTING, 'utf8');
    for (const name of files) {
      const row = listing.split('\n').find((line) => line.includes(`../screenshots/${name}\``));
      expect(row, `${name} has no row in listing.md`).toBeDefined();
      const alt = (row ?? '').split('|')[2]?.trim() ?? '';
      expect(alt.length, name).toBeGreaterThan(20);
      expect(alt.length, name).toBeLessThanOrEqual(150);
      expect(alt, name).not.toMatch(/[$€£]|\bfree\b|guarantee|compliant|certified|lawsuit/iu);
    }
  });
});
