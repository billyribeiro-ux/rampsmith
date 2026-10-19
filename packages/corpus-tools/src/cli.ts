// Command line for corpus authors (corpus/README.md):
// - `render <theme> <out-dir>` writes every page of a theme, rendered statically, plus its
//   assets, for inspection in a browser;
// - `scan <theme>` prints every axe-core result node of every page, as JSON lines;
// - `run [<theme>...] [--golden-spans] [--out <file>]` runs the integrated runner (ADR-247),
//   writes the JSON report (default test-results/corpus-report.json) and exits 1 below a gate;
// - `spans [--write]` re-finds every golden span from its anchor or pointer after a theme or
//   fixture edit, and with --write stores the new offsets (run Prettier afterwards).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { launchChromium, runPage } from './browser/check.ts';
import { loadCorpus } from './corpus.ts';
import type { GoldenFile, Span } from './golden.ts';
import { CORPUS_ROOT } from './paths.ts';
import { relocate } from './spans.ts';
import { loadManifest, storeEntry, themeDir, type Manifest, type ThemeEntry } from './manifest.ts';
import { ThemeRenderer } from './render/renderer.ts';
import { loadStore, storeObjects } from './render/store.ts';
import { jsonReport, runnerRecords } from './runner/report.ts';
import { runCorpus } from './runner/run.ts';
import { loadTheme } from './render/theme.ts';

function rendererFor(
  manifest: Manifest,
  themeName: string,
): { entry: ThemeEntry; renderer: ThemeRenderer } {
  const entry = manifest.themes.find((t) => t.name === themeName);
  if (entry === undefined) throw new Error(`no theme named ${themeName} in corpus/manifest.json`);
  const store = storeObjects(loadStore(storeEntry(manifest, entry.store).fixtures));
  return { entry, renderer: new ThemeRenderer(loadTheme(entry.name, themeDir(entry)), store) };
}

function render(themeName: string, outDir: string): void {
  const { entry, renderer } = rendererFor(loadManifest(), themeName);
  mkdirSync(join(outDir, 'assets'), { recursive: true });
  for (const page of entry.pages) {
    writeFileSync(join(outDir, `${page.id}.html`), renderer.renderPage(page));
  }
  for (const path of renderer.theme.files.keys()) {
    if (!path.startsWith('assets/')) continue;
    const name = path.slice('assets/'.length).replace(/\.liquid$/, '');
    const asset = renderer.renderAsset(name);
    if (asset !== null) writeFileSync(join(outDir, 'assets', name), asset.body);
  }
  process.stdout.write(
    `${String(entry.pages.length)} pages of ${themeName} written to ${outDir}\n`,
  );
}

/** Prints every axe-core result node of every page of a theme, as JSON lines. */
async function scan(themeName: string): Promise<void> {
  const manifest = loadManifest();
  const { entry, renderer } = rendererFor(manifest, themeName);
  const browser = await launchChromium();
  try {
    for (const spec of entry.pages) {
      const run = await runPage(browser, renderer, spec, [], manifest.checker);
      for (const node of run.nodes) {
        process.stdout.write(`${JSON.stringify({ page: spec.id, ...node })}\n`);
      }
    }
  } finally {
    await browser.close();
  }
}

function spans(write: boolean): void {
  const corpus = loadCorpus();
  const subjects = [
    ...corpus.themes.map((t) => ({
      golden: t.entry.golden,
      theme: t.theme,
      store: t.store.fixture,
    })),
    ...corpus.stores.map((s) => ({ golden: s.entry.golden, theme: null, store: s.fixture })),
  ];
  let failures = 0;
  for (const subject of subjects) {
    const path = join(CORPUS_ROOT, subject.golden);
    const file = JSON.parse(readFileSync(path, 'utf8')) as GoldenFile;
    let changed = 0;
    let fileFailures = 0;
    const move = (span: Span, where: string): Span => {
      const next = relocate(span, subject.theme, subject.store);
      if (next === null) {
        failures += 1;
        fileFailures += 1;
        process.stderr.write(`${where}: the anchor or pointer is missing or not unique\n`);
        return span;
      }
      if (JSON.stringify(next) !== JSON.stringify(span)) changed += 1;
      return next;
    };
    const findings = file.findings.map((f) => ({
      ...f,
      span: move(f.span, `${file.subject}/${f.id} span`),
      ...(f.rendersFrom === undefined
        ? {}
        : {
            rendersFrom: move(
              f.rendersFrom,
              `${file.subject}/${f.id} rendersFrom`,
            ) as typeof f.rendersFrom,
          }),
    }));
    process.stdout.write(`${subject.golden}: ${String(changed)} span(s) moved\n`);
    // A file with a span that could not be re-found is left as it is, so nothing half-moves.
    if (write && changed > 0 && fileFailures === 0)
      writeFileSync(path, `${JSON.stringify({ ...file, findings }, null, 2)}\n`);
  }
  if (failures > 0) process.exitCode = 1;
}

/** `corpus-report.json` is accompanied by `corpus-report.records.json`. */
function recordsPath(reportPath: string): string {
  return reportPath.replace(/(?:\.json)?$/u, '.records.json');
}

/** The commit the records were made against, or zeros outside a git checkout. */
function corpusCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: CORPUS_ROOT,
    }).trim();
  } catch {
    return '0000000';
  }
}

/**
 * Runs the integrated runner (ADR-247) on every failing theme, or on the named ones, writes the
 * JSON report, prints the gate numbers, and exits 1 when a gate fails.
 */
async function runAll(outPath: string, themes: readonly string[], golden: boolean): Promise<void> {
  const corpus = loadCorpus();
  const browser = await launchChromium();
  try {
    const options = { spans: golden ? ('golden' as const) : ('mapper' as const), themes };
    const run = await runCorpus(browser, corpus, options);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(jsonReport(run, options), null, 2)}\n`);
    writeFileSync(
      recordsPath(outPath),
      `${JSON.stringify(runnerRecords(run, corpusCommit()), null, 2)}\n`,
    );
    const { mapping, fixes, regressions, gates } = run.report;
    process.stdout.write(
      `mapping ${String(mapping.correct)}/${String(mapping.denominator)} correct, ` +
        `${String(mapping.wrongAboveThreshold)} wrong above ${String(mapping.threshold)}\n` +
        `fixes ${String(fixes.fixed)}/${String(fixes.targeted)} targeted fixed, ` +
        `${String(regressions.length)} regression(s)\n` +
        `gates: mapping ${gates.mapping ? 'pass' : 'FAIL'}, fixes ${gates.fixes ? 'pass' : 'FAIL'}\n` +
        `report written to ${outPath} and ${recordsPath(outPath)}\n`,
    );
    if (!run.report.passed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'render' && args.length === 2) {
  render(args[0] ?? '', args[1] ?? '');
} else if (command === 'scan' && args.length === 1) {
  await scan(args[0] ?? '');
} else if (command === 'run') {
  let outPath = 'test-results/corpus-report.json';
  let golden = false;
  const themes: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--golden-spans') golden = true;
    else if (arg === '--out') {
      i += 1;
      outPath = args[i] ?? outPath;
    } else themes.push(arg);
  }
  await runAll(outPath, themes, golden);
} else if (
  command === 'spans' &&
  (args.length === 0 || (args.length === 1 && args[0] === '--write'))
) {
  spans(args[0] === '--write');
} else {
  process.stderr.write(
    'usage: node src/cli.ts render <theme> <out-dir> | scan <theme> | run [<theme>...] [--out <file>] | spans [--write]\n',
  );
  process.exitCode = 2;
}
