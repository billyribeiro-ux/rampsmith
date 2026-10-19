// The extension's files as Shopify CLI deploys them. Shopify CLI 4.9.4 (the PLAN §7 pin)
// globs `*/*` inside the extension, skipping .git, node_modules, .DS_Store, *.toml and a few
// editor files, and refuses any directory other than assets, blocks, locales and snippets,
// and any file type those directories do not allow (read from the CLI's bundled source,
// 17 Oct 2026; ADR-161). Root-level files are never uploaded.
import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { EXTENSION_DIR } from './paths.ts';

/** Shopify CLI 4.9.4's allowed directories and extensions. */
export const CLI_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  assets: ['.jpg', '.jpeg', '.json', '.js', '.css', '.png', '.svg', '.wasm'],
  blocks: ['.liquid'],
  locales: ['.json'],
  snippets: ['.liquid'],
};

/** Limits Shopify enforces at deploy (theme app extension configuration page, 17 Oct 2026). */
export const LIMITS = {
  totalBytes: 10 * 1024 * 1024,
  liquidBytes: 100 * 1024,
  blocks: 30,
  localeFiles: 100,
  localeFileBytes: 15 * 1024,
} as const;

/** Root-level files: kept out of the deploy by the CLI's `*\/*` glob. */
export const ROOT_FILES = ['.theme-check.yml', 'shopify.extension.toml', 'tsconfig.json'] as const;

export interface ExtensionFile {
  /** POSIX path relative to the extension, e.g. `blocks/accessibility.liquid`. */
  readonly path: string;
  readonly dir: string;
  readonly ext: string;
  readonly bytes: number;
}

/** Every entry directly inside the extension directory. */
export function rootEntries(): string[] {
  return readdirSync(EXTENSION_DIR).sort();
}

/** Every file below the extension root, at any depth, as the CLI would see it. */
export function deployedFiles(): ExtensionFile[] {
  const files: ExtensionFile[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(EXTENSION_DIR, relative))) {
      const path = relative === '' ? name : `${relative}/${name}`;
      const absolute = join(EXTENSION_DIR, path);
      if (statSync(absolute).isDirectory()) walk(path);
      else if (relative !== '') {
        files.push({
          path,
          dir: path.slice(0, path.indexOf('/')),
          ext: extname(name),
          bytes: statSync(absolute).size,
        });
      }
    }
  };
  walk('');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
