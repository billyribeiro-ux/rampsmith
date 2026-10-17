/** Reads the vendored Dawn files (test/fixtures/dawn, pinned in SOURCE.json). */
import { readFileSync } from 'node:fs';

const ROOT = new URL('./fixtures/dawn/', import.meta.url);

export interface DawnSource {
  readonly repository: string;
  readonly commit: string;
  readonly blobs: Readonly<Record<string, string>>;
}

export function readDawn(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

export function readDawnBytes(path: string): Buffer {
  return readFileSync(new URL(path, ROOT));
}

export function dawnSource(): DawnSource {
  return JSON.parse(readDawn('SOURCE.json')) as DawnSource;
}
