// Calls into the in-page probe. Each page gets its own random key, registered as an init
// script (so later documents get the probe before their own scripts run) and installed in
// the current document on first use or after a navigation.
// Playwright API: https://playwright.dev/docs/api/class-page#page-evaluate and
// https://playwright.dev/docs/api/class-page#page-add-init-script
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { installProbe, type ProbeApi } from './probe.ts';

type Method = keyof ProbeApi;
type Result<M extends Method> = Awaited<ReturnType<ProbeApi[M]>>;

const keys = new WeakMap<Page, Promise<string>>();

function keyFor(page: Page): Promise<string> {
  let key = keys.get(page);
  if (key === undefined) {
    const value = `rampsmith.a11y-rules.probe.${randomUUID()}`;
    key = page.addInitScript(installProbe, value).then(() => value);
    keys.set(page, key);
  }
  return key;
}

async function invoke<M extends Method>(
  page: Page,
  key: string,
  method: M,
  args: Parameters<ProbeApi[M]>,
): Promise<{ installed: false } | { installed: true; value: unknown }> {
  return page.evaluate(
    async ([slotKey, name, params]) => {
      const holder = globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>;
      const slot = holder[Symbol.for(slotKey)];
      if (slot === undefined) return { installed: false as const };
      const fn = slot[name];
      if (typeof fn !== 'function' || !Object.isFrozen(slot)) {
        throw new Error(`probe method ${name} is missing`);
      }
      const value: unknown = await (fn as (...a: readonly unknown[]) => unknown)(...params);
      return { installed: true as const, value };
    },
    [key, method, args] as const,
  );
}

/** Runs one probe method in the page and returns its JSON result. */
export async function probe<M extends Method>(
  page: Page,
  method: M,
  ...args: Parameters<ProbeApi[M]>
): Promise<Result<M>> {
  const key = await keyFor(page);
  let outcome = await invoke(page, key, method, args);
  if (!outcome.installed) {
    await page.evaluate(installProbe, key);
    outcome = await invoke(page, key, method, args);
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
