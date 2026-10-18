#!/usr/bin/env node
/**
 * `pnpm --filter @rampsmith/ai run eval [--live] [--record] [--no-grade] [--limit N] [--out file]`
 *
 * Recorded mode needs nothing. Live mode needs `ANTHROPIC_API_KEY` (LAUNCH.md section C,
 * row 5); without it the command explains what is missing and exits 2. The key is never
 * printed. Exit 0 means the gate passed, 1 that it failed.
 */
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { createAnthropicTransport } from '../transport.ts';
import { formatReport, runEval } from './runner.ts';

// pnpm 12 forwards a literal `--` separator to the script; it is not an argument.
const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    live: { type: 'boolean', default: false },
    record: { type: 'boolean', default: false },
    'no-grade': { type: 'boolean', default: false },
    limit: { type: 'string' },
    out: { type: 'string' },
  },
});

const key = process.env['ANTHROPIC_API_KEY'] ?? '';
if (values.live && key.trim() === '') {
  process.stderr.write(
    'eval: --live needs ANTHROPIC_API_KEY, the founder input in LAUNCH.md section C, row 5.\n',
  );
  process.exit(2);
}
if (values.record && !values.live) {
  process.stderr.write('eval: --record only works with --live.\n');
  process.exit(2);
}

const report = await runEval({
  mode: values.live ? 'live' : 'recorded',
  ...(values.live ? { transport: createAnthropicTransport({ apiKey: key }) } : {}),
  record: values.record,
  grade: !values['no-grade'],
  ...(values.limit === undefined ? {} : { limit: Number.parseInt(values.limit, 10) }),
});
if (values.out !== undefined) {
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(formatReport(report));
process.exitCode = report.summary.gate.passed ? 0 : 1;
