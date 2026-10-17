/**
 * The Theme Check gate (PLAN §12: "pass theme-check with no new errors"; ADR-104). Runs
 * `@shopify/theme-check-common` 3.30.1 (MIT) in memory over theme snapshots, with no file
 * system and no network: `check(theme, config, { fs })` takes an injected file system
 * (https://github.com/Shopify/theme-tools/tree/main/packages/theme-check-common).
 */
import {
  FileType,
  Severity,
  check,
  recommended,
  toSourceCode,
  type AbstractFileSystem,
  type FileStat,
  type FileTuple,
  type ThemeDocset,
} from '@shopify/theme-check-common';

/** Theme-relative path to contents, such as `layout/theme.liquid`. */
export type ThemeFiles = ReadonlyMap<string, string>;

export interface ThemeOffense {
  readonly file: string;
  /** The Theme Check code, such as `TranslationKeyExists`. */
  readonly check: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
  /** Offsets of the reported range in the file, as Theme Check gives them. */
  readonly start: number;
  readonly end: number;
}

export interface ValidateOptions {
  /** Also fail on new warnings, not only on new errors. Defaults to true. */
  readonly includeWarnings?: boolean;
  /**
   * Shopify's Liquid reference (filters, objects, tags), for the checks that need it, such as
   * `UnknownFilter`. Without it those checks find nothing. The engine can pass
   * `ThemeLiquidDocsManager` from `@shopify/theme-check-docs-updater`.
   */
  readonly themeDocset?: ThemeDocset;
}

export interface ValidationResult {
  readonly ok: boolean;
  /** Offenses in `after` beyond those already in `before`, sorted by file and position. */
  readonly newOffenses: readonly ThemeOffense[];
}

/** The only recommended-set candidates that make HTTP requests (remote asset sizes). */
const NETWORK_CHECKS: ReadonlySet<string> = new Set([
  'AssetSizeCSS',
  'AssetSizeJavaScript',
  'AssetSizeAppBlockCSS',
  'AssetSizeAppBlockJavaScript',
]);

/** Shopify's recommended checks, minus any that would reach the network. */
export const OFFLINE_CHECKS = recommended.filter((c) => !NETWORK_CHECKS.has(c.meta.code));

const ROOT = 'file:///theme';

function toUri(path: string): string {
  return `${ROOT}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function fromUri(uri: string): string {
  return uri
    .slice(ROOT.length + 1)
    .split('/')
    .map(decodeURIComponent)
    .join('/');
}

/** A read-only in-memory file system over the snapshot, keyed by URI. */
function memoryFileSystem(files: ReadonlyMap<string, string>): AbstractFileSystem {
  return {
    stat(uri: string): Promise<FileStat> {
      const file = files.get(uri);
      if (file !== undefined) return Promise.resolve({ type: FileType.File, size: file.length });
      for (const key of files.keys()) {
        if (key.startsWith(`${uri}/`))
          return Promise.resolve({ type: FileType.Directory, size: 0 });
      }
      return Promise.reject(new Error(`no such file: ${uri}`));
    },
    readFile(uri: string): Promise<string> {
      const file = files.get(uri);
      return file === undefined
        ? Promise.reject(new Error(`no such file: ${uri}`))
        : Promise.resolve(file);
    },
    readDirectory(uri: string): Promise<FileTuple[]> {
      const entries = new Map<string, FileType>();
      for (const key of files.keys()) {
        if (!key.startsWith(`${uri}/`)) continue;
        const rest = key.slice(uri.length + 1);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        entries.set(`${uri}/${name}`, slash === -1 ? FileType.File : FileType.Directory);
      }
      return Promise.resolve([...entries]);
    },
  };
}

function severityName(severity: Severity): ThemeOffense['severity'] {
  if (severity === Severity.ERROR) return 'error';
  return severity === Severity.WARNING ? 'warning' : 'info';
}

/** Every offense Theme Check reports for the snapshot, including checks that crashed. */
export async function themeOffenses(
  files: ThemeFiles,
  options: Pick<ValidateOptions, 'themeDocset'> = {},
): Promise<ThemeOffense[]> {
  const byUri = new Map([...files].map(([path, source]) => [toUri(path), source]));
  const theme = [...byUri].map(([uri, source]) => toSourceCode(uri, source));
  const crashes: ThemeOffense[] = [];
  const offenses = await check(
    theme,
    {
      context: 'theme',
      settings: {},
      checks: OFFLINE_CHECKS,
      rootUri: ROOT,
      onError: (error: Error) => {
        crashes.push({
          file: '',
          check: 'CheckCrashed',
          message: error.message,
          severity: 'error',
          start: 0,
          end: 0,
        });
      },
    },
    {
      fs: memoryFileSystem(byUri),
      ...(options.themeDocset === undefined ? {} : { themeDocset: options.themeDocset }),
    },
  );
  return [
    ...offenses.map((o) => ({
      file: fromUri(o.uri),
      check: o.check,
      message: o.message,
      severity: severityName(o.severity),
      start: o.start.index,
      end: o.end.index,
    })),
    ...crashes,
  ];
}

function key(o: ThemeOffense): string {
  return `${o.file}\u0000${o.check}\u0000${o.message}`;
}

/**
 * Runs Theme Check on both snapshots and reports what `after` adds. Offenses are matched by
 * file, check and message, not position, because a patch moves text; one that appears more
 * often after than before counts as new.
 */
export async function validateNoNewOffenses(
  before: ThemeFiles,
  after: ThemeFiles,
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  const counted = (o: ThemeOffense): boolean =>
    o.severity === 'error' || (o.severity === 'warning' && options.includeWarnings !== false);
  const docs = options.themeDocset === undefined ? {} : { themeDocset: options.themeDocset };
  const [was, now] = await Promise.all([themeOffenses(before, docs), themeOffenses(after, docs)]);
  const remaining = new Map<string, number>();
  for (const o of was.filter(counted)) remaining.set(key(o), (remaining.get(key(o)) ?? 0) + 1);
  const added: ThemeOffense[] = [];
  for (const o of now.filter(counted)) {
    const left = remaining.get(key(o)) ?? 0;
    if (left > 0) remaining.set(key(o), left - 1);
    else added.push(o);
  }
  added.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start));
  return { ok: added.length === 0, newOffenses: added };
}
