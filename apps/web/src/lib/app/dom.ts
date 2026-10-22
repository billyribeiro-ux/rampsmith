/** Reading values from Polaris form elements, which expose `value` and `checked` as properties. */

export function valueOf(event: Event): string {
  const target = event.currentTarget as { value?: unknown } | null;
  return typeof target?.value === 'string' ? target.value : '';
}

export function checkedOf(event: Event): boolean {
  const target = event.currentTarget as { checked?: unknown } | null;
  return target?.checked === true;
}

/** Whether App Bridge's contextual save bar is available (`data-save-bar` forms use it). */
export function hasSaveBar(): boolean {
  const shopify = (globalThis as { shopify?: { saveBar?: unknown } }).shopify;
  return shopify?.saveBar !== undefined;
}

/**
 * An event listener attached with `{@attach on('keydown', handler)}`. Svelte's markup checks
 * treat a custom element, or a wrapper `div`, as non-interactive and warn about handlers
 * written as attributes on it; `<s-button>` is a real button (keyboard activation fires
 * `click` too), so the listener is attached here instead of the warning being suppressed.
 */
export function on<K extends keyof HTMLElementEventMap>(
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): (node: Element) => () => void {
  return (node) => {
    const listener = handler as EventListener;
    node.addEventListener(type, listener);
    return () => {
      node.removeEventListener(type, listener);
    };
  };
}

/** A click handler for a Polaris element: `{@attach press(handler)}`. */
export function press(handler: (event: Event) => void): (node: Element) => () => void {
  return on('click', handler);
}
