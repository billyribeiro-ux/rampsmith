// Interactive-state scripts (PLAN §5 R1, §11 step 5): open the main navigation by keyboard,
// add an in-stock item and open the cart drawer, change a variant, open the first modal or
// popup. Each returns the changed region's selector for a scoped re-check, or a typed reason.
// Every control is described and guarded before it is activated, and a network guard stops
// any request into checkout while the script runs (ADR-116).
import type { Page } from 'playwright-core';
import { probe } from '../browser/call.ts';
import type { Target, Trigger } from '../browser/protocol.ts';
import type { PageState } from '../types.ts';
import { guardControl, isCartAddUrl } from './guards.ts';
import { blockCheckout } from './network-guard.ts';

export type InteractiveState = Exclude<PageState, 'default'>;

export type NotFoundReason =
  | 'no_trigger'
  | 'did_not_open'
  | 'no_product_form'
  | 'sold_out'
  | 'no_variant_picker'
  | 'variant_unchanged'
  | 'navigated_away';

export type StateOutcome =
  | {
      readonly status: 'opened';
      readonly state: InteractiveState;
      /** The changed region, in axe-core's target format, for a scoped re-check. */
      readonly region: Target;
      /** The control that was activated; `null` when the state was already present. */
      readonly trigger: Target | null;
    }
  | {
      readonly status: 'not_found';
      readonly state: InteractiveState;
      readonly reason: NotFoundReason;
    }
  | {
      readonly status: 'blocked';
      readonly state: InteractiveState;
      readonly guard: 'checkout' | 'personal_data';
      readonly detail: string;
    }
  | { readonly status: 'timed_out'; readonly state: InteractiveState }
  | { readonly status: 'error'; readonly state: InteractiveState; readonly error: string };

export interface StateOptions {
  /** Hard cap in milliseconds. Default 10,000. */
  readonly timeoutMs?: number;
}

type Body = (page: Page) => Promise<StateOutcome>;

const GRACE_MS = 1_000;

function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return (message.split('\n', 1)[0] ?? '').slice(0, 200);
}

/** Runs a state script under the checkout network guard and a hard time cap. */
async function run(
  page: Page,
  state: InteractiveState,
  options: StateOptions,
  body: Body,
): Promise<StateOutcome> {
  const block = await blockCheckout(page);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = body(page).catch((error: unknown): StateOutcome => ({
      status: 'error',
      state,
      error: firstLine(error),
    }));
    const capped = new Promise<StateOutcome>((resolve) => {
      timer = setTimeout(resolve, options.timeoutMs ?? 10_000, { status: 'timed_out', state });
    });
    const outcome = await Promise.race([work, capped]);
    if (outcome.status === 'timed_out') {
      await Promise.race([work, new Promise((resolve) => setTimeout(resolve, GRACE_MS))]);
    }
    const stopped = block.blocked[0];
    if (stopped !== undefined) {
      return {
        status: 'blocked',
        state,
        guard: 'checkout',
        detail: `request to ${stopped} stopped`,
      };
    }
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await block.dispose();
  }
}

/** Focuses the trigger and presses `key`, after the guards approve it. */
async function activate(
  page: Page,
  state: InteractiveState,
  trigger: Trigger,
  key: string,
): Promise<StateOutcome | 'activated' | 'skipped'> {
  const description = await probe(page, 'describeControl', trigger.id);
  if (description === null) return 'skipped';
  const verdict = guardControl(description);
  if (!verdict.safe) {
    return { status: 'blocked', state, guard: verdict.guard, detail: verdict.detail };
  }
  if (!(await probe(page, 'focusElement', trigger.id))) return 'skipped';
  await page.keyboard.press(key);
  return 'activated';
}

async function settle(page: Page, capMs = 2_000): Promise<void> {
  await probe(page, 'quiet', 200, capMs);
}

/** Opens the main navigation with the keyboard (Enter on its toggle). */
export async function openMainNavigation(
  page: Page,
  options: StateOptions = {},
): Promise<StateOutcome> {
  const state = 'nav_open';
  return run(page, state, options, async () => {
    const triggers = await probe(page, 'navTriggers');
    if (triggers.length === 0) return { status: 'not_found', state, reason: 'no_trigger' };
    const url = withoutHash(page.url());
    for (const trigger of triggers.slice(0, 3)) {
      const step = await activate(page, state, trigger, 'Enter');
      if (step === 'skipped') continue;
      if (step !== 'activated') return step;
      await settle(page, 1_500);
      if (withoutHash(page.url()) !== url)
        return { status: 'not_found', state, reason: 'navigated_away' };
      if (await probe(page, 'isExpanded', trigger.id)) {
        const region = (await probe(page, 'regionOf', trigger.id)) ?? trigger.target;
        return { status: 'opened', state, region, trigger: trigger.target };
      }
    }
    return { status: 'not_found', state, reason: 'did_not_open' };
  });
}

/** Adds the current in-stock variant to the cart with the keyboard and finds the cart drawer. */
export async function openCartDrawer(
  page: Page,
  options: StateOptions = {},
): Promise<StateOutcome> {
  const state = 'cart_drawer';
  return run(page, state, options, async () => {
    const form = await probe(page, 'cartForm');
    if (!form.found) return { status: 'not_found', state, reason: form.reason };
    const description = await probe(page, 'describeControl', form.button);
    if (description === null) return { status: 'not_found', state, reason: 'no_product_form' };
    const verdict = guardControl(description);
    if (!verdict.safe) {
      return { status: 'blocked', state, guard: verdict.guard, detail: verdict.detail };
    }
    if (description.formAction === null || !isCartAddUrl(description.formAction)) {
      return { status: 'not_found', state, reason: 'no_product_form' };
    }
    const before = new Set(await probe(page, 'overlays'));
    const url = withoutHash(page.url());
    const step = await activate(page, state, { id: form.button, target: form.target }, 'Enter');
    if (step === 'skipped') return { status: 'not_found', state, reason: 'no_product_form' };
    if (step !== 'activated') return step;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await settle(page, 1_500);
      if (withoutHash(page.url()) !== url) {
        return { status: 'not_found', state, reason: 'navigated_away' };
      }
      const fresh = (await probe(page, 'overlays')).filter((id) => !before.has(id));
      const region = await probe(page, 'pickOverlay', fresh, 'cart');
      if (region !== null) return { status: 'opened', state, region, trigger: form.target };
    }
    return { status: 'not_found', state, reason: 'did_not_open' };
  });
}

/** Changes the variant with the keyboard: an arrow key on the option group or select. */
export async function changeVariant(page: Page, options: StateOptions = {}): Promise<StateOutcome> {
  const state = 'variant_changed';
  return run(page, state, options, async () => {
    const picker = await probe(page, 'variantPicker');
    if (picker.kind === 'none') return { status: 'not_found', state, reason: 'no_variant_picker' };
    const before = await probe(page, 'variantSignature');
    const url = withoutHash(page.url().split('?')[0] ?? '');
    const trigger = await probe(page, 'targetOf', picker.focus);
    if (trigger === null) return { status: 'not_found', state, reason: 'no_variant_picker' };
    const key = picker.kind === 'radio' ? 'ArrowRight' : 'ArrowDown';
    const step = await activate(page, state, { id: picker.focus, target: trigger }, key);
    if (step === 'skipped') return { status: 'not_found', state, reason: 'no_variant_picker' };
    if (step !== 'activated') return step;
    await settle(page);
    // Themes record the variant in the query string; only a new path is a navigation.
    if (withoutHash(page.url().split('?')[0] ?? '') !== url) {
      return { status: 'not_found', state, reason: 'navigated_away' };
    }
    if ((await probe(page, 'variantSignature')) === before) {
      return { status: 'not_found', state, reason: 'variant_unchanged' };
    }
    return { status: 'opened', state, region: picker.region, trigger };
  });
}

/** Opens the first modal or popup: one already open, or the first dialog trigger. */
export async function openFirstModal(
  page: Page,
  options: StateOptions = {},
): Promise<StateOutcome> {
  const state = 'modal';
  return run(page, state, options, async () => {
    const before = await probe(page, 'overlays');
    const open = await probe(page, 'pickOverlay', before, 'dialog-only');
    if (open !== null) return { status: 'opened', state, region: open, trigger: null };
    const navigation = (await probe(page, 'navTriggers')).map((t) => t.id);
    const triggers = await probe(page, 'modalTriggers', navigation);
    if (triggers.length === 0) return { status: 'not_found', state, reason: 'no_trigger' };
    const known = new Set(before);
    const url = withoutHash(page.url());
    for (const trigger of triggers.slice(0, 3)) {
      const step = await activate(page, state, trigger, 'Enter');
      if (step === 'skipped') continue;
      if (step !== 'activated') return step;
      await settle(page, 1_500);
      if (withoutHash(page.url()) !== url)
        return { status: 'not_found', state, reason: 'navigated_away' };
      const fresh = (await probe(page, 'overlays')).filter((id) => !known.has(id));
      const region = await probe(page, 'pickOverlay', fresh, 'dialog');
      if (region !== null) return { status: 'opened', state, region, trigger: trigger.target };
    }
    return { status: 'not_found', state, reason: 'did_not_open' };
  });
}

/** Runs the script for `state`. */
export function openState(
  page: Page,
  state: InteractiveState,
  options: StateOptions = {},
): Promise<StateOutcome> {
  switch (state) {
    case 'nav_open':
      return openMainNavigation(page, options);
    case 'cart_drawer':
      return openCartDrawer(page, options);
    case 'variant_changed':
      return changeVariant(page, options);
    case 'modal':
      return openFirstModal(page, options);
  }
}
