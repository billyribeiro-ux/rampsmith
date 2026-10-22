/**
 * What every App Home screen shares: the data layer, the shop, and one live region that
 * announces results (approved, undone, saved) to screen readers and shows them to everyone.
 */
import { getContext, setContext } from 'svelte';
import type { AppApi } from './api.ts';

const KEY = Symbol('rampsmith.app');

export class AppContext {
  readonly api: AppApi;
  shop = $state('');
  /** The query string App Bridge needs on in-app links (`shop`, `host`, `embedded`). */
  carry = $state('');
  /** The last result message; cleared after it is read. */
  announcement = $state('');
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(api: AppApi) {
    this.api = api;
  }

  /** Puts `text` in the live region; the same text twice still announces (a toggle). */
  announce(text: string): void {
    clearTimeout(this.#timer);
    this.announcement = '';
    this.#timer = setTimeout(() => {
      this.announcement = text;
    }, 30);
  }
}

export function setAppContext(context: AppContext): void {
  setContext(KEY, context);
}

export function getAppContext(): AppContext {
  const context = getContext<AppContext | undefined>(KEY);
  if (context === undefined) throw new Error('the App Home context is not set');
  return context;
}
