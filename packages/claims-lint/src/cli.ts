import { globSync, readFileSync } from 'node:fs';
import { join, matchesGlob, sep } from 'node:path';
import { applyAllowlist, parseAllowlist } from './allowlist.ts';
import { ALWAYS_EXCLUDED, parseConfig } from './config.ts';
import { scanText, type MarkerProblem, type Violation } from './scan.ts';

export const CONFIG_FILE = 'claims-lint.config.json';

export interface RunOptions {
  /** Repository root holding `claims-lint.config.json`. */
  readonly cwd: string;
  /** Emit GitHub Actions `::error` annotations instead of plain lines. */
  readonly githubActions: boolean;
}

export interface RunResult {
  /** 0: clean. 1: banned claims or bad exceptions. 2: the tool could not run. */
  readonly exitCode: 0 | 1 | 2;
  readonly output: string[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function escapeData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function formatViolation(v: Violation, githubActions: boolean): string {
  const text = `${v.message} (matched "${v.match}")`;
  if (githubActions) {
    return `::error file=${escapeProperty(v.file)},line=${String(v.line)},col=${String(v.column)},title=${escapeProperty(`claims-lint ${v.rule}`)}::${escapeData(text)}`;
  }
  return `${v.file}:${String(v.line)}:${String(v.column)} ${v.rule} ${text}`;
}

function formatMarker(p: MarkerProblem, githubActions: boolean): string {
  if (githubActions) {
    return `::error file=${escapeProperty(p.file)},line=${String(p.line)},col=${String(p.column)},title=${escapeProperty(`claims-lint marker ${p.kind}`)}::${escapeData(p.message)}`;
  }
  return `${p.file}:${String(p.line)}:${String(p.column)} marker-${p.kind} ${p.message}`;
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** Lists the files to scan, as sorted POSIX paths relative to the root. */
export function discoverFiles(
  cwd: string,
  include: readonly string[],
  exclude: readonly string[],
): string[] {
  const excluded = [...ALWAYS_EXCLUDED, ...exclude];
  const found = new Set<string>();
  for (const path of globSync([...include], { cwd })) {
    const posix = path.split(sep).join('/');
    if (!excluded.some((glob) => matchesGlob(posix, glob))) {
      found.add(posix);
    }
  }
  return [...found].sort();
}

export function run(options: RunOptions): RunResult {
  let config;
  let allowlist;
  try {
    config = parseConfig(readJson(join(options.cwd, CONFIG_FILE)));
    allowlist = parseAllowlist(readJson(join(options.cwd, config.allowlist)));
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, output: [`claims-lint: cannot start: ${reason}`] };
  }

  const files = discoverFiles(options.cwd, config.include, config.exclude);
  const violations: Violation[] = [];
  const markerProblems: MarkerProblem[] = [];
  for (const file of files) {
    const result = scanText(file, readFileSync(join(options.cwd, file), 'utf8'));
    violations.push(...result.violations);
    markerProblems.push(...result.markerProblems);
  }
  const allowed = applyAllowlist(violations, allowlist);

  const output = [
    ...allowed.violations.map((v) => formatViolation(v, options.githubActions)),
    ...markerProblems.map((p) => formatMarker(p, options.githubActions)),
    ...allowed.unused.map(
      (e) =>
        `${config.allowlist}: unused allowlist entry for ${e.rule} in ${e.file} ("${e.text}"); remove it`,
    ),
  ];
  const problems = allowed.violations.length + markerProblems.length + allowed.unused.length;
  if (problems === 0) {
    output.push(`claims-lint: ${plural(files.length, 'file')} scanned, no banned claims`);
    return { exitCode: 0, output };
  }
  output.push(
    `claims-lint: ${plural(files.length, 'file')} scanned, ${plural(allowed.violations.length, 'banned claim')}, ${plural(markerProblems.length + allowed.unused.length, 'bad exception')}`,
  );
  return { exitCode: 1, output };
}
