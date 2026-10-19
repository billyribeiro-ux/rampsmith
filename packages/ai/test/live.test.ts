/**
 * Live checks against the Claude API (LAUNCH.md section E). They run whenever
 * `ANTHROPIC_API_KEY` is set (LAUNCH.md section C, row 5) and otherwise skip with a notice
 * naming that input; they never pass silently. Substitutes that pass now: the recorded
 * evaluation run (eval.test.ts) and the SDK transport on documented responses
 * (transport.test.ts).
 *
 * Live commands:
 *   ANTHROPIC_API_KEY=… pnpm --filter @rampsmith/ai test -- test/live.test.ts
 *   ANTHROPIC_API_KEY=… pnpm --filter @rampsmith/ai run eval -- --live
 */
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { InMemoryBudgetLedger } from '../src/budget.ts';
import type { AiCallRecord } from '../src/calls.ts';
import { loadDataset, runEval } from '../src/eval/index.ts';
import { CircuitBreaker } from '../src/resilience.ts';
import { generateAltText } from '../src/tasks/alt-text.ts';
import { createAnthropicTransport } from '../src/transport.ts';

const key = process.env['ANTHROPIC_API_KEY'] ?? '';
const live = key.trim() !== '';
const NOTICE = 'needs ANTHROPIC_API_KEY (LAUNCH.md section C, row 5)';

if (!live) {
  const annotation =
    process.env['GITHUB_ACTIONS'] === 'true' ? '::notice title=AI live checks skipped::' : '';
  process.stderr.write(`${annotation}AI live checks skipped: ${NOTICE}\n`);
}

describe.skipIf(!live)(`live Claude API checks (${NOTICE})`, () => {
  it('drafts alt text for one image on claude-haiku-5-5 with a schema-valid answer and a real cost', async () => {
    const { images } = loadDataset();
    const item = images.find((i) => i.id === 'espresso-cup');
    if (item === undefined) throw new Error('missing dataset image');
    const records: AiCallRecord[] = [];
    const outcome = await generateAltText(
      {
        transport: createAnthropicTransport({ apiKey: key }),
        ledger: new InMemoryBudgetLedger(),
        breaker: new CircuitBreaker(),
        sink: {
          record: (r) => {
            records.push(r);
            return Promise.resolve();
          },
        },
        budgetLimit: () => Promise.resolve(100_000),
      },
      {
        image: item.image,
        productTitle: item.product_title,
        productType: item.product_type,
        primaryLocale: 'en',
      },
      { tenantId: 'rampsmith-live-check' },
    );
    expect(['draft', 'needs_review']).toContain(outcome.result.status);
    expect(records[0]?.model).toBe('claude-haiku-5-5');
    expect(records[0]?.usage.input).toBeGreaterThan(0);
    expect(records[0]?.costMicroUsd).toBeGreaterThan(0);
    expect(records[0]?.requestId).toMatch(/^req_/u);
  }, 120_000);

  it('meets the evaluation gate on the bundled set (at least 80% approvable, under 2% unsupported)', async () => {
    const report = await runEval({
      mode: 'live',
      transport: createAnthropicTransport({ apiKey: key }),
    });
    expect(report.summary.failed).toBe(0);
    expect(report.summary.gate.failures).toEqual([]);
  }, 900_000);
});

describe.runIf(!live)('live Claude API checks', () => {
  it.skip(`skipped: ${NOTICE}`, () => undefined);
});
