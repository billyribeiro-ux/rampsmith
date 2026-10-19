// Every output the package renders, from the synthetic fixtures, in each state a merchant
// can reach. The axe, claims-lint, snapshot and PDF suites all run over this one list.
import {
  remediationLogCsv,
  remediationLogJson,
  renderStatement,
  renderSummary,
  type ReportDocument,
  type StatementInput,
} from '../../src/index.ts';
import { remediationInput, statementInput, summaryInput } from '../fixtures.ts';

export interface Output {
  /** File name for snapshots and the claims-lint run. */
  readonly name: string;
  readonly content: string;
  /** Set for complete HTML documents, which axe checks and the PDF suite prints. */
  readonly document?: ReportDocument;
  /** Set for the statement fragment, which axe checks inside a minimal store page. */
  readonly fragment?: boolean;
}

function unevaluated(): StatementInput {
  const input: { latestScan?: unknown } & StatementInput = statementInput({
    findings: [],
    limitations: [],
    verifiedFixes: { count: 0, since: new Date('2026-10-01T00:00:00Z') },
  });
  delete input.latestScan;
  return input;
}

const STATEMENTS: readonly [string, StatementInput][] = [
  ['statement-known-barriers', statementInput()],
  [
    'statement-no-known-barriers',
    statementInput({
      findings: [],
      limitations: [],
      latestScan: {
        status: 'succeeded',
        finishedAt: new Date('2026-10-16T03:12:00Z'),
        pagesChecked: 1,
        checksRun: 310,
        checksPassed: 310,
      },
      coverage: { automated: [], partial: ['1.1.1'], rulesetVersion: 'axe-core 4.14.0' },
    }),
  ],
  ['statement-not-evaluated', unevaluated()],
];

export function outputs(): Output[] {
  const list: Output[] = [];
  for (const [name, input] of STATEMENTS) {
    const s = renderStatement(input);
    list.push({ name: `${name}.html`, content: s.document.html, document: s.document });
    list.push({ name: `${name}.fragment.html`, content: s.fragment, fragment: true });
    list.push({ name: `${name}.txt`, content: s.text });
  }
  const summaries: readonly [string, ReturnType<typeof summaryInput>][] = [
    ['summary', summaryInput()],
    ['summary-no-scans', summaryInput({ scans: [], fixes: { verified: 0, proposed: 1 } })],
    [
      'summary-one-scan',
      (() => {
        const input: { period?: unknown; fixes?: unknown } & ReturnType<typeof summaryInput> =
          summaryInput({
            scans: [
              { finishedAt: new Date('2026-10-16T03:12:00Z'), checksRun: 1, checksPassed: 1 },
            ],
            openFindings: { critical: 0, serious: 0, moderate: 0, minor: 0 },
          });
        delete input.period;
        delete input.fixes;
        return input;
      })(),
    ],
  ];
  for (const [name, input] of summaries) {
    const { document } = renderSummary(input);
    list.push({ name: `${name}.html`, content: document.html, document });
  }
  list.push({ name: 'remediation-log.csv', content: remediationLogCsv(remediationInput()) });
  list.push({ name: 'remediation-log.json', content: remediationLogJson(remediationInput()) });
  return list;
}

/** A minimal store page around the statement fragment, as a merchant would publish it. */
export function storePage(fragment: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Accessibility statement - Example Goods</title></head><body><main><h1>Accessibility statement</h1>${fragment}</main></body></html>`;
}
