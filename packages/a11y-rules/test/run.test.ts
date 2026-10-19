import { describe, expect, it } from 'vitest';
import { runCapped } from '../src/browser/run.ts';

const never = (): Promise<void> => new Promise<void>(() => undefined);

describe('runCapped', () => {
  it('returns complete with the findings and stats the work reported', async () => {
    const result = await runCapped('reflow', 1_000, (ctx) => {
      ctx.report('rs-reflow-horizontal-scroll', 'violation', ['#wide'], { overflowPx: 280 });
      ctx.stats['scrollWidth'] = 600;
      return Promise.resolve();
    });
    expect(result).toMatchObject({
      check: 'reflow',
      status: 'complete',
      stats: { scrollWidth: 600 },
      findings: [
        {
          ruleId: 'rs-reflow-horizontal-scroll',
          criteria: ['1.4.10'],
          impact: 'serious',
          outcome: 'violation',
          bestPractice: false,
          target: ['#wide'],
          data: { overflowPx: 280 },
        },
      ],
    });
    expect(result.error).toBeUndefined();
  });

  it('stops at the cap, keeps what was found and runs cleanup', async () => {
    let cleaned = false;
    const started = performance.now();
    const result = await runCapped(
      'keyboard',
      50,
      async (ctx) => {
        ctx.report('rs-focus-stop-hidden', 'violation', ['#a']);
        await never();
      },
      () => {
        cleaned = true;
        return Promise.resolve();
      },
    );
    const elapsed = performance.now() - started;
    expect(result.status).toBe('timed_out');
    expect(result.findings.map((f) => f.target)).toEqual([['#a']]);
    expect(cleaned).toBe(true);
    // The cap, plus at most the 1 s grace period, plus scheduling slack.
    expect(elapsed).toBeLessThan(1_800);
  });

  it('tells the work the cap has passed so loops can stop', async () => {
    let sawExpiry = false;
    const result = await runCapped('focus-obscured', 30, async (ctx) => {
      while (!ctx.expired()) await new Promise((resolve) => setTimeout(resolve, 5));
      sawExpiry = true;
    });
    expect(result.status).toBe('timed_out');
    expect(sawExpiry).toBe(true);
  });

  it('reports a failure as an error with its first line only', async () => {
    const result = await runCapped('media-autoplay', 1_000, () =>
      Promise.reject(new Error('page crashed\n    at secret stack frame')),
    );
    expect(result).toMatchObject({ status: 'error', error: 'page crashed', findings: [] });
  });

  it('bounds a cleanup that never finishes', async () => {
    const started = performance.now();
    const result = await runCapped('text-spacing', 1_000, () => Promise.resolve(), never);
    expect(result.status).toBe('complete');
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
