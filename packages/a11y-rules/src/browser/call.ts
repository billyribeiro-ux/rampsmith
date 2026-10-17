// Calls into the in-page probe, installing it on first use or after a navigation.
// Playwright API: https://playwright.dev/docs/api/class-page#page-evaluate
import type { Page } from 'playwright-core';
import { PROBE_KEY, installProbe, type ProbeApi } from './probe.ts';

type Method = keyof ProbeApi;
type Result<M extends Method> = Awaited<ReturnType<ProbeApi[M]>>;

async function invoke<M extends Method>(
  page: Page,
  method: M,
  args: Parameters<ProbeApi[M]>,
): Promise<{ installed: false } | { installed: true; value: unknown }> {
  return page.evaluate(
    async ([key, name, params]) => {
      const slot = (globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>)[
        Symbol.for(key)
      ];
      if (slot === undefined) return { installed: false as const };
      const fn = slot[name];
      if (typeof fn !== 'function') throw new Error(`probe method ${name} is missing`);
      const value: unknown = await (fn as (...a: readonly unknown[]) => unknown)(...params);
      return { installed: true as const, value };
    },
    [PROBE_KEY, method, args] as const,
  );
}

/** Runs one probe method in the page and returns its JSON result. */
export async function probe<M extends Method>(
  page: Page,
  method: M,
  ...args: Parameters<ProbeApi[M]>
): Promise<Result<M>> {
  let outcome = await invoke(page, method, args);
  if (!outcome.installed) {
    await page.evaluate(installProbe, PROBE_KEY);
    outcome = await invoke(page, method, args);
  }
  if (!outcome.installed) throw new Error('the probe could not be installed in the page');
  return outcome.value as Result<M>;
}

/** Waits two animation frames, so style and layout changes are painted. */
export async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}
