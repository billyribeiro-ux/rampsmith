/**
 * The evaluation runner (PLAN §13; ADR-217). Recorded mode replays responses from
 * `eval/recorded/` and runs in CI today; live mode calls the Claude API when
 * `ANTHROPIC_API_KEY` is present (LAUNCH.md section C, row 5) and can refresh the recordings.
 * Both run the production pipeline itself: the same prompts, schemas, checks and escalation.
 */
import { InMemoryBudgetLedger } from '../budget.ts';
import { runCall, type AiCallRecord, type AiDeps } from '../calls.ts';
import { costMicroUsd } from '../cost.ts';
import { AiError } from '../errors.ts';
import { prompt } from '../prompts.ts';
import { CircuitBreaker } from '../resilience.ts';
import { generateAltText, type AltTextDraft } from '../tasks/alt-text.ts';
import type { TaskResult } from '../calls.ts';
import type { AiTransport } from '../transport.ts';
import { BUNDLED_DATASET, loadDataset } from './dataset.ts';
import { prepareGrade } from './grade.ts';
import {
  scoreCandidate,
  summarize,
  type CandidateScore,
  type EvalSummary,
  type GraderVerdict,
} from './metrics.ts';
import { RecordedTransport, RecordingTransport } from './recorded.ts';

/** Runs carry an operator tenant id; no merchant data is involved. */
export const EVAL_TENANT = 'rampsmith-eval';
/** A hard stop for one live run: $5, far above the expected cost of a few cents. */
export const EVAL_BUDGET_MICRO_USD = 5_000_000;

export interface EvalOptions {
  readonly mode: 'recorded' | 'live';
  /** Required in live mode: the SDK transport built from `ANTHROPIC_API_KEY`. */
  readonly transport?: AiTransport;
  readonly dataset?: URL;
  readonly recordings?: URL;
  /** Live mode: write every response as a recording. */
  readonly record?: boolean;
  /** Live mode: grade unsupported attributes with Sonnet 5.5. Default true in live mode. */
  readonly grade?: boolean;
  readonly limit?: number;
}

export interface EvalReport {
  readonly mode: 'recorded' | 'live';
  readonly promptVersion: string;
  readonly dataset: { readonly name: string; readonly version: number };
  readonly generatedAt: string;
  readonly summary: EvalSummary;
  /** What the same calls cost on the Batch API, the production path for bulk alt text. */
  readonly batchCostPerThousandImagesMicroUsd: number;
  readonly candidates: readonly CandidateScore[];
  readonly calls: readonly AiCallRecord[];
}

export async function runEval(options: EvalOptions): Promise<EvalReport> {
  if (options.mode === 'live' && options.transport === undefined) {
    throw new AiError(
      'ai_auth',
      'live evaluation needs ANTHROPIC_API_KEY (LAUNCH.md section C, row 5)',
    );
  }
  const { manifest, images } = loadDataset(options.dataset ?? BUNDLED_DATASET);
  const live = options.mode === 'live' ? options.transport : undefined;
  const recorder =
    live !== undefined && options.record === true
      ? new RecordingTransport(live, options.recordings)
      : undefined;
  const transport: AiTransport = recorder ?? live ?? new RecordedTransport(options.recordings);
  const calls: AiCallRecord[] = [];
  const deps: AiDeps = {
    transport,
    ledger: new InMemoryBudgetLedger(),
    breaker: new CircuitBreaker(),
    sink: {
      record: (r) => {
        calls.push(r);
        return Promise.resolve();
      },
    },
    budgetLimit: () => Promise.resolve(EVAL_BUDGET_MICRO_USD),
  };
  const grade = options.mode === 'live' && options.grade !== false;
  const selected = images.slice(0, options.limit ?? images.length);
  const candidates: CandidateScore[] = [];
  for (const item of selected) {
    if (recorder !== undefined) {
      recorder.imageId = item.id;
    }
    const before = calls.length;
    let result: TaskResult<AltTextDraft> | null = null;
    let escalated = false;
    try {
      const outcome = await generateAltText(
        deps,
        {
          image: item.image,
          productTitle: item.product_title,
          productType: item.product_type,
          primaryLocale: item.primary_locale,
        },
        { tenantId: EVAL_TENANT, interactive: true },
      );
      result = outcome.result;
      escalated = outcome.escalated;
    } catch (error: unknown) {
      if (!(error instanceof AiError)) {
        throw error;
      }
    }
    const decorative =
      result?.status === 'needs_review' && result.reasons.includes('marked_decorative');
    const alt = result?.status === 'draft' ? result.value.alt : '';
    let verdict: GraderVerdict | undefined;
    if (grade && result?.status === 'draft') {
      try {
        const graded = await runCall(
          deps,
          prepareGrade(
            {
              image: item.image,
              productTitle: item.product_title,
              productType: item.product_type,
              alt,
            },
            { tenantId: EVAL_TENANT },
          ),
          { tenantId: EVAL_TENANT },
        );
        verdict = graded.result.status === 'draft' ? graded.result.value : undefined;
      } catch (error: unknown) {
        if (!(error instanceof AiError)) {
          throw error;
        }
      }
    }
    const altCalls = calls.slice(before).filter((c) => c.task !== 'grade_alt_text');
    candidates.push(
      scoreCandidate(
        item,
        {
          result,
          escalated,
          decorative,
          alt,
          costMicroUsd: altCalls.reduce((sum, c) => sum + c.costMicroUsd, 0),
        },
        verdict,
      ),
    );
  }
  const altCalls = calls.filter((c) => c.task !== 'grade_alt_text');
  const batchCost = altCalls.reduce((sum, c) => sum + costMicroUsd(c.model, 'batch', c.usage), 0);
  return {
    mode: options.mode,
    promptVersion: prompt('alt-text').version,
    dataset: { name: manifest.name, version: manifest.version },
    generatedAt: new Date().toISOString(),
    summary: summarize(candidates),
    batchCostPerThousandImagesMicroUsd:
      candidates.length === 0 ? 0 : Math.round((batchCost / candidates.length) * 1000),
    candidates,
    calls,
  };
}

function percent(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function dollars(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

/** A short Markdown report for the terminal and the evidence file. */
export function formatReport(report: EvalReport): string {
  const s = report.summary;
  const lines = [
    `# Alt-text evaluation (${report.mode}, ${report.promptVersion})`,
    '',
    `Dataset ${report.dataset.name} v${String(report.dataset.version)}: ${String(s.images)} images.`,
    '',
    '| Metric | Value | Target |',
    '| --- | --- | --- |',
    `| Approvable unedited (proxy) | ${percent(s.approvalRate)} (${String(s.approvable)}/${String(s.images)}) | ≥ 80% |`,
    `| Unsupported attributes | ${percent(s.unsupportedRate)} | < 2% |`,
    `| Drafts naming a person | ${String(s.namedPeople)} | 0 |`,
    `| Escalated to Sonnet 5.5 | ${percent(s.escalationRate)} | — |`,
    `| Failed calls | ${String(s.failed)} | 0 |`,
    `| Mean attribute coverage | ${percent(s.meanCoverage)} | — |`,
    `| Cost per 1,000 images, synchronous | ${dollars(s.costPerThousandImagesMicroUsd)} | — |`,
    `| Cost per 1,000 images, Batch API | ${dollars(report.batchCostPerThousandImagesMicroUsd)} | about $0.10 (PLAN §13) |`,
    '',
    `Gate: ${s.gate.passed ? 'PASS' : `FAIL (${s.gate.failures.join('; ')})`}`,
    '',
    '| Image | Status | Approvable | Notes |',
    '| --- | --- | --- | --- |',
    ...report.candidates.map(
      (c) =>
        `| ${c.id} | ${c.status}${c.escalated ? ', escalated' : ''} | ${c.approvable ? 'yes' : 'no'} | ${[
          ...c.reasons,
          ...(c.coverage < 1 ? [`coverage ${percent(c.coverage)}`] : []),
          ...c.unsupported.map((u) => `unsupported "${u}"`),
          ...(c.namesPerson ? ['names a person'] : []),
        ].join('; ')} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
