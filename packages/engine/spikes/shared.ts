/**
 * Shared pieces of the spike scripts (PLAN §11). Spikes load third-party pages, so they stay
 * inside the free scanner's limits (PLAN §16): identified user agent, robots.txt honoured,
 * one page in flight, challenges recorded and never evaded.
 */
import process from 'node:process';
import { chromium, type Browser } from 'playwright';
import { robotsAllows, type RobotsResponse } from '../src/robots.ts';
import { BOT_TOKEN, userAgent } from '../src/user-agent.ts';

export const UA = userAgent(
  `spike-${process.env['GITHUB_SHA']?.slice(0, 7) ?? 'local'}`,
  process.env['BOT_INFO_URL'],
);

export interface RobotsCheck {
  readonly response: RobotsResponse | undefined;
  readonly headers: Headers | undefined;
  readonly allowed: boolean;
}

/** Fetches `origin`/robots.txt once and decides whether `path` may be loaded. */
export async function checkRobots(origin: string, path = '/'): Promise<RobotsCheck> {
  try {
    const res = await fetch(new URL('/robots.txt', origin), {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    const response = { status: res.status, text: (await res.text()).slice(0, 500_000) };
    return { response, headers: res.headers, allowed: robotsAllows(response, BOT_TOKEN, path) };
  } catch {
    return { response: undefined, headers: undefined, allowed: false };
  }
}

export async function launch(): Promise<Browser> {
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
  return chromium.launch(executablePath === undefined ? {} : { executablePath });
}

/** The value at percentile `p` (0–100), nearest rank. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
