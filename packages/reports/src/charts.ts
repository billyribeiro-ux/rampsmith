// Charts for the executive summary, drawn as inline SVG data graphics (they are charts, not
// icons, so phosphor-svelte does not apply; ADR-226). Each chart is a figure whose accessible
// name is its caption plus a visible text summary, and each is followed by a data table with
// the same numbers, so no reader depends on seeing the graphic.
import { markup, join, type Html } from './html.ts';
import type { Translator } from './i18n.ts';
import { IMPACTS, type Impact } from './vocabulary.ts';

export interface RatePoint {
  readonly at: Date;
  readonly passed: number;
  readonly run: number;
}

const W = 640;
const H = 280;
const LEFT = 64;
const RIGHT = 24;
const TOP = 16;
const BOTTOM = 48;

function fixed(n: number): string {
  return n.toFixed(1);
}

/** The ratio of passed to run checks; a scan that ran no checks has no rate. */
export function passRate(point: Pick<RatePoint, 'passed' | 'run'>): number {
  return point.run === 0 ? 0 : point.passed / point.run;
}

/** A summary of the trend, for the chart's text alternative. */
export function rateSummary(t: Translator, points: readonly RatePoint[]): string {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return t.text('summary_no_scans');
  }
  if (points.length === 1) {
    return t.text('summary_pass_rate_alt_single', {
      date: t.date(first.at),
      rate: t.percent(passRate(first)),
    });
  }
  const rates = points.map(passRate);
  return t.text('summary_pass_rate_alt', {
    count: points.length,
    first: t.date(first.at),
    last: t.date(last.at),
    firstRate: t.percent(passRate(first)),
    lastRate: t.percent(passRate(last)),
    minRate: t.percent(Math.min(...rates)),
    maxRate: t.percent(Math.max(...rates)),
  });
}

/** A line chart of pass rate per scan, evenly spaced in scan order, on a 0–100% axis. */
export function passRateChart(t: Translator, points: readonly RatePoint[], id: string): Html {
  const plotW = W - LEFT - RIGHT;
  const plotH = H - TOP - BOTTOM;
  const x = (i: number): number =>
    points.length === 1 ? LEFT + plotW / 2 : LEFT + (plotW * i) / (points.length - 1);
  const y = (rate: number): number => TOP + plotH * (1 - rate);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(
    (r) =>
      markup`<line class="grid" x1="${LEFT}" x2="${W - RIGHT}" y1="${fixed(y(r))}" y2="${fixed(y(r))}"/>
<text class="label" x="${LEFT - 8}" y="${fixed(y(r) + 4)}" text-anchor="end">${t.percent(r)}</text>
`,
  );
  const coords = points.map((p, i) => `${fixed(x(i))},${fixed(y(passRate(p)))}`);
  const dots = points.map(
    (p, i) =>
      markup`<circle class="point" cx="${fixed(x(i))}" cy="${fixed(y(passRate(p)))}" r="4"/>\n`,
  );
  const first = points[0];
  const last = points.at(-1);
  const dateY = H - BOTTOM + 20;
  const dates: Html[] = [];
  if (first !== undefined && last !== undefined) {
    if (points.length === 1) {
      dates.push(
        markup`<text class="label" x="${fixed(x(0))}" y="${dateY}" text-anchor="middle">${t.date(first.at)}</text>\n`,
      );
    } else {
      dates.push(
        markup`<text class="label" x="${fixed(x(0))}" y="${dateY}" text-anchor="start">${t.date(first.at)}</text>\n`,
        markup`<text class="label" x="${fixed(x(points.length - 1))}" y="${dateY}" text-anchor="end">${t.date(last.at)}</text>\n`,
      );
    }
  }
  const mid = fixed(TOP + plotH / 2);
  return markup`<svg class="chart" role="img" aria-labelledby="${id}-caption ${id}-summary" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" focusable="false">
${grid}<line class="axis" x1="${LEFT}" x2="${LEFT}" y1="${TOP}" y2="${H - BOTTOM}"/>
<line class="axis" x1="${LEFT}" x2="${W - RIGHT}" y1="${H - BOTTOM}" y2="${H - BOTTOM}"/>
<text class="label" x="16" y="${mid}" text-anchor="middle" transform="rotate(-90 16 ${mid})">${t.text('summary_pass_rate_axis')}</text>
${points.length > 1 ? markup`<polyline class="line" points="${coords.join(' ')}"/>\n` : ''}${dots}${dates}</svg>`;
}

export type ImpactCounts = Readonly<Record<Impact, number>>;

export function impactSummary(t: Translator, counts: ImpactCounts): string {
  return t.text('summary_impact_alt', {
    critical: counts.critical,
    serious: counts.serious,
    moderate: counts.moderate,
    minor: counts.minor,
  });
}

/** Horizontal bars, most severe first, each labelled with its impact and its count. */
export function impactChart(t: Translator, counts: ImpactCounts, id: string): Html {
  const order = [...IMPACTS].reverse();
  const max = Math.max(1, ...order.map((i) => counts[i]));
  const labelW = 112;
  const valueW = 64;
  const barH = 32;
  const gap = 16;
  const height = TOP * 2 + order.length * barH + (order.length - 1) * gap;
  const plotW = W - labelW - valueW;
  const bars = order.map((impact, i) => {
    const top = TOP + i * (barH + gap);
    const width = (plotW * counts[impact]) / max;
    const textY = top + barH / 2 + 4;
    return markup`<text class="label" x="${labelW - 8}" y="${textY}" text-anchor="end">${t.text(`label_impact_${impact}`)}</text>
<rect class="bar-${impact}" x="${labelW}" y="${top}" width="${fixed(Math.max(width, counts[impact] > 0 ? 2 : 0))}" height="${barH}"/>
<text class="label" x="${fixed(labelW + width + 8)}" y="${textY}">${t.number(counts[impact])}</text>
`;
  });
  return markup`<svg class="chart" role="img" aria-labelledby="${id}-caption ${id}-summary" viewBox="0 0 ${W} ${height}" xmlns="http://www.w3.org/2000/svg" focusable="false">
<line class="axis" x1="${labelW}" x2="${labelW}" y1="${TOP / 2}" y2="${height - TOP / 2}"/>
${join(bars)}</svg>`;
}
