// The executive summary (PLAN §16 "Reports"): automated pass rate over time, open findings by
// impact, and the coverage disclosure, as an accessible HTML document that prints to a tagged
// PDF. Every chart has a text alternative and a data table with the same numbers (ADR-226).
import { blocksToHtml, type Block } from './blocks.ts';
import {
  impactChart,
  impactSummary,
  passRate,
  passRateChart,
  rateSummary,
  type ImpactCounts,
  type RatePoint,
} from './charts.ts';
import { classifyCoverage, type CoverageInput } from './coverage.ts';
import { safeWebUrl } from './escape.ts';
import { reportDocument, type ReportDocument } from './document.ts';
import { markup, type Html } from './html.ts';
import { translator, type Locale, type Translator } from './i18n.ts';
import { automationLimitBlock, coverageBlocks } from './sections.ts';
import {
  ReportInputError,
  requireCount,
  requireDate,
  requireItems,
  requireLine,
  requireOneOf,
} from './validate.ts';
import { IMPACTS, PLATFORMS, type Platform } from './vocabulary.ts';

export interface SummaryScan {
  readonly finishedAt: Date;
  readonly checksRun: number;
  readonly checksPassed: number;
}

export interface SummaryInput {
  readonly locale: string;
  readonly site: { readonly name: string; readonly url: string; readonly platform: Platform };
  readonly generatedAt: Date;
  readonly period?: { readonly from: Date; readonly to: Date };
  /** Scans with results (succeeded or partial), in any order. */
  readonly scans: readonly SummaryScan[];
  /** Open findings from the latest scan, by impact. */
  readonly openFindings: ImpactCounts;
  readonly fixes?: { readonly verified: number; readonly proposed: number };
  readonly coverage: CoverageInput;
}

export interface RenderedSummary {
  readonly locale: Locale;
  readonly fallback: boolean;
  readonly document: ReportDocument;
}

/** Most scans one chart plots; older ones are left out of the chart and the table. */
export const MAX_CHART_SCANS = 400;

function figure(id: string, caption: string, summary: string, chart: Html, table: Html): Block {
  return {
    kind: 'markup',
    text: summary,
    html: markup`<figure>
<figcaption id="${id}-caption">${caption}</figcaption>
${chart}
<p id="${id}-summary">${summary}</p>
</figure>
${table}`,
  };
}

function rateTable(t: Translator, points: readonly RatePoint[]): Html {
  const rows = points.map(
    (p) =>
      markup`<tr><th scope="row">${t.date(p.at)}</th><td class="num">${t.number(p.passed)}</td><td class="num">${t.number(p.run)}</td><td class="num">${t.percent(passRate(p))}</td></tr>\n`,
  );
  return markup`<table>
<caption>${t.text('summary_pass_rate_caption')}</caption>
<thead><tr><th scope="col">${t.text('summary_column_scan_date')}</th><th scope="col" class="num">${t.text('summary_column_passed')}</th><th scope="col" class="num">${t.text('summary_column_run')}</th><th scope="col" class="num">${t.text('summary_column_rate')}</th></tr></thead>
<tbody>
${rows}</tbody>
</table>`;
}

function impactTable(t: Translator, counts: ImpactCounts): Html {
  const order = [...IMPACTS].reverse();
  const total = order.reduce((sum, i) => sum + counts[i], 0);
  const rows = order.map(
    (i) =>
      markup`<tr><th scope="row">${t.text(`label_impact_${i}`)}</th><td class="num">${t.number(counts[i])}</td></tr>\n`,
  );
  return markup`<table>
<caption>${t.text('summary_impact_caption')}</caption>
<thead><tr><th scope="col">${t.text('summary_column_impact')}</th><th scope="col" class="num">${t.text('summary_column_open')}</th></tr></thead>
<tbody>
${rows}<tr><th scope="row">${t.text('summary_impact_total')}</th><td class="num">${t.number(total)}</td></tr>
</tbody>
</table>`;
}

export function renderSummary(input: SummaryInput): RenderedSummary {
  const t = translator(input.locale);
  const site = requireLine('site.name', input.site.name);
  requireOneOf('site.platform', input.site.platform, PLATFORMS);
  if (safeWebUrl(input.site.url) === undefined) {
    throw new ReportInputError('site.url', 'must be an absolute https or http URL');
  }
  const generatedAt = requireDate('generatedAt', input.generatedAt);
  const coverage = classifyCoverage(input.coverage);
  const points: RatePoint[] = requireItems('scans', input.scans)
    .map((s, i) => {
      const f = `scans[${String(i)}]`;
      const run = requireCount(`${f}.checksRun`, s.checksRun);
      const passed = requireCount(`${f}.checksPassed`, s.checksPassed);
      if (passed > run) throw new ReportInputError(`${f}.checksPassed`, 'cannot exceed checksRun');
      if (run === 0)
        throw new ReportInputError(`${f}.checksRun`, 'a scan with results ran at least one check');
      return { at: requireDate(`${f}.finishedAt`, s.finishedAt), passed, run };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-MAX_CHART_SCANS);
  const counts = Object.fromEntries(
    IMPACTS.map((i) => [i, requireCount(`openFindings.${i}`, input.openFindings[i])]),
  ) as Record<(typeof IMPACTS)[number], number>;

  const blocks: Block[] = [];
  const meta: string[] = [];
  if (input.period !== undefined) {
    const from = requireDate('period.from', input.period.from);
    const to = requireDate('period.to', input.period.to);
    if (from > to) throw new ReportInputError('period', 'from must not be after to');
    meta.push(t.text('summary_period', { from: t.date(from), to: t.date(to) }));
  }
  meta.push(t.text('summary_generated', { date: t.date(generatedAt) }));
  blocks.push({ kind: 'paragraph', meta: true, content: [meta.join(' ')] });

  blocks.push({ kind: 'heading', level: 2, content: [t.text('summary_key_figures_heading')] });
  const latest = points.at(-1);
  const figures: string[] = [
    latest === undefined
      ? t.text('summary_no_scans')
      : t.text('summary_latest_pass', {
          date: t.date(latest.at),
          passed: latest.passed,
          total: latest.run,
          rate: t.percent(passRate(latest)),
        }),
    t.text('summary_open_findings_count', { count: IMPACTS.reduce((n, i) => n + counts[i], 0) }),
  ];
  if (input.fixes !== undefined) {
    figures.push(
      t.text('summary_fixes_verified', {
        count: requireCount('fixes.verified', input.fixes.verified),
      }),
      t.text('summary_fixes_waiting', {
        count: requireCount('fixes.proposed', input.fixes.proposed),
      }),
    );
  }
  blocks.push({
    kind: 'markup',
    text: figures.join('\n'),
    html: markup`<ul class="figures">\n${figures.map((f) => markup`<li>${f}</li>\n`)}</ul>`,
  });

  blocks.push({ kind: 'heading', level: 2, content: [t.text('summary_pass_rate_heading')] });
  if (points.length === 0) {
    blocks.push({ kind: 'paragraph', content: [t.text('summary_no_scans')] });
  } else {
    blocks.push(
      figure(
        'pass-rate',
        t.text('summary_pass_rate_caption'),
        rateSummary(t, points),
        passRateChart(t, points, 'pass-rate'),
        rateTable(t, points),
      ),
    );
  }

  blocks.push({ kind: 'heading', level: 2, content: [t.text('summary_impact_heading')] });
  blocks.push(
    figure(
      'impact',
      t.text('summary_impact_caption'),
      impactSummary(t, counts),
      impactChart(t, counts, 'impact'),
      impactTable(t, counts),
    ),
  );

  blocks.push(...coverageBlocks(t, coverage, true));

  blocks.push({ kind: 'heading', level: 2, content: [t.text('summary_about_heading')] });
  blocks.push(automationLimitBlock(t));
  blocks.push({ kind: 'paragraph', content: [t.text('summary_about_rate')] });
  blocks.push({ kind: 'paragraph', content: [t.text('summary_about_impact')] });

  const title = t.text('summary_title', { site });
  return {
    locale: t.locale,
    fallback: t.fallback,
    document: reportDocument({
      lang: t.locale,
      title,
      body: markup`<h1>${title}</h1>\n${blocksToHtml(blocks)}`,
    }),
  };
}
