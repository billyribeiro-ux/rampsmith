// The hard time cap shared by every browser check (PLAN §11: one page-state at p95 under
// 20 seconds). A check returns within `timeoutMs` plus at most GRACE_MS for in-flight work to
// stop and CLEANUP_MS for cleanup, with whatever it found before the cap.
import { findingBase } from '../rules.ts';
import type { FindingData, Outcome, PageFinding, RuleId } from '../types.ts';
import type { Target } from './protocol.ts';

export type CheckName =
  'keyboard' | 'focus-obscured' | 'reflow' | 'text-spacing' | 'media-autoplay';

export interface CheckResult {
  readonly check: CheckName;
  /** `complete`: ran to the end. `timed_out`: stopped at the cap. `error`: the page failed. */
  readonly status: 'complete' | 'timed_out' | 'error';
  readonly findings: readonly PageFinding[];
  readonly elapsedMs: number;
  readonly stats: Readonly<Record<string, number>>;
  /** First line of the error, for `error` only. Never page content. */
  readonly error?: string;
}

export interface CheckContext {
  /** True once the cap has passed; loops check it before each step. */
  expired(): boolean;
  report(ruleId: RuleId, outcome: Outcome, target: Target, data?: FindingData): void;
  readonly stats: Record<string, number>;
}

const GRACE_MS = 1_000;
const CLEANUP_MS = 2_000;

function sleep(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(resolve, ms, 'timeout'));
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return (message.split('\n', 1)[0] ?? '').slice(0, 200);
}

export async function runCapped(
  check: CheckName,
  timeoutMs: number,
  work: (ctx: CheckContext) => Promise<void>,
  cleanup?: () => Promise<void>,
): Promise<CheckResult> {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let cancelled = false;
  // Set once the work is told the cap has passed. The deadline can pass a little before the cap's
  // timer fires, so work that stops because it saw the deadline still counts as timed out.
  const told = { expired: false };
  const findings: PageFinding[] = [];
  const stats: Record<string, number> = {};
  const ctx: CheckContext = {
    expired: () => {
      if (cancelled || performance.now() > deadline) told.expired = true;
      return told.expired;
    },
    report: (ruleId, outcome, target, data) => {
      findings.push({
        ...findingBase(ruleId, outcome),
        target: [...target],
        ...(data === undefined ? {} : { data }),
      });
    },
    stats,
  };

  let failure: unknown = null;
  const running = work(ctx).then(
    () => 'done' as const,
    (error: unknown) => {
      failure = error;
      return 'failed' as const;
    },
  );
  const timer = new AbortController();
  const capped = new Promise<'timeout'>((resolve) => {
    const handle = setTimeout(resolve, Math.max(0, timeoutMs), 'timeout');
    timer.signal.addEventListener('abort', () => {
      clearTimeout(handle);
    });
  });
  const first = await Promise.race([running, capped]);
  timer.abort();
  if (first === 'timeout') {
    cancelled = true;
    await Promise.race([running, sleep(GRACE_MS)]);
  }
  if (cleanup !== undefined) {
    await Promise.race([cleanup().catch(() => undefined), sleep(CLEANUP_MS)]);
  }
  const elapsedMs = Math.round(performance.now() - started);
  const base = { check, findings: [...findings], elapsedMs, stats: { ...stats } };
  if (first === 'timeout' || (first === 'done' && told.expired)) {
    return { ...base, status: 'timed_out' };
  }
  if (first === 'failed') return { ...base, status: 'error', error: firstLine(failure) };
  return { ...base, status: 'complete' };
}
