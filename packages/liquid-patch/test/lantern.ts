/**
 * Reads the hand-written fixture theme in test/fixtures/lantern. Every file there was written
 * for Rampsmith (ADR-241): no third-party theme code is vendored in this repository.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';

const ROOT = new URL('./fixtures/lantern/', import.meta.url);

export function readLantern(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

function listFiles(dir: URL, prefix: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const url = new URL(name, dir);
      return statSync(url).isDirectory()
        ? listFiles(new URL(`${name}/`, dir), `${prefix}${name}/`)
        : [`${prefix}${name}`];
    });
}

/** Every file of the fixture theme: theme-relative path to contents. */
export function lanternTheme(): Map<string, string> {
  return new Map(listFiles(ROOT, '').map((path) => [path, readLantern(path)]));
}
