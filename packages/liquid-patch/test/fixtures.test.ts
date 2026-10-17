import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dawnSource, readDawnBytes } from './dawn.ts';

/** Git's object id for a file: SHA-1 of `blob <length>\0<bytes>`. */
function gitBlobId(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

function listFiles(dir: URL, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const url = new URL(name, dir);
    return statSync(url).isDirectory()
      ? listFiles(new URL(`${name}/`, dir), `${prefix}${name}/`)
      : [`${prefix}${name}`];
  });
}

describe('vendored Dawn fixtures', () => {
  const source = dawnSource();

  it('pin one Dawn commit', () => {
    expect(source.repository).toBe('https://github.com/Shopify/dawn');
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('are byte-identical to the blobs of that commit, license included', () => {
    for (const [path, blob] of Object.entries(source.blobs)) {
      expect(gitBlobId(readDawnBytes(path)), path).toBe(blob);
    }
  });

  it('contain nothing beyond the recorded files and the source record', () => {
    const onDisk = listFiles(new URL('./fixtures/dawn/', import.meta.url)).sort();
    expect(onDisk).toEqual([...Object.keys(source.blobs), 'SOURCE.json'].sort());
  });
});
