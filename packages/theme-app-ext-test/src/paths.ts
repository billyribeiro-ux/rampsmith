// Where the theme app extension lives. The script is located with import.meta.resolve so the
// dependency graph (knip) sees the test suite use it; nothing here executes it in Node.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** extensions/theme-app-ext/assets/rampsmith-barrier-report.js */
export const SCRIPT_FILE = fileURLToPath(
  import.meta.resolve('../../../extensions/theme-app-ext/assets/rampsmith-barrier-report.js'),
);
/** extensions/theme-app-ext */
export const EXTENSION_DIR = dirname(dirname(SCRIPT_FILE));
/** The repository root, which holds claims-lint and its config. */
export const REPO_DIR = dirname(dirname(EXTENSION_DIR));

export const BLOCK_FILE = join(EXTENSION_DIR, 'blocks', 'accessibility.liquid');
export const SNIPPETS_DIR = join(EXTENSION_DIR, 'snippets');
const LOCALES_DIR = join(EXTENSION_DIR, 'locales');
export const STOREFRONT_LOCALE = join(LOCALES_DIR, 'en.default.json');
export const SCHEMA_LOCALE = join(LOCALES_DIR, 'en.default.schema.json');
export const STYLES_FILE = join(SNIPPETS_DIR, 'rampsmith-a11y-styles.liquid');
