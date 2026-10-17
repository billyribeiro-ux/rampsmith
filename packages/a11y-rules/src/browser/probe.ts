// The in-page probe of the browser checks and interactive-state scripts.
//
// `installProbe` is serialized by Playwright (`page.evaluate(installProbe, PROBE_KEY)`) and
// runs inside the page, so it must be self-contained: every helper is declared inside it and
// nothing from module scope is referenced. It stores its API under a global symbol
// (`Symbol.for(PROBE_KEY)`), not a named global, and returns only plain JSON data. It reads
// the page and moves focus; it never submits forms or follows links itself.
import type {
  CartForm,
  ClipRect,
  ControlDescription,
  FieldDescription,
  HiddenReason,
  IndicatorVerdict,
  MediaControl,
  MediaInfo,
  ObscuredResult,
  ReflowCulprit,
  ReflowResult,
  StepResult,
  Target,
  TextSpacingIssue,
  Trigger,
  VariantPicker,
} from './protocol.ts';

export const PROBE_KEY = 'rampsmith.a11y-rules.probe.v1';

export interface ProbeApi {
  prepareTraversal(start: 'top' | 'current'): void;
  endTraversal(): void;
  step(): StepResult;
  tabbableCount(): number;
  cycleInModalWithButton(ids: readonly number[]): boolean;
  focusById(id: number): ClipRect | null;
  focusSentinel(): void;
  obscured(): ObscuredResult;
  reflow(): ReflowResult;
  textSpacingBefore(): number;
  textSpacingApply(): void;
  textSpacingAfter(): TextSpacingIssue[];
  textSpacingRemove(): void;
  media(): MediaInfo[];
  mediaControl(id: number): MediaControl;
  navTriggers(): Trigger[];
  isExpanded(id: number): boolean;
  regionOf(id: number): Target | null;
  overlays(): number[];
  pickOverlay(ids: readonly number[], prefer: 'cart' | 'dialog' | 'dialog-only'): Target | null;
  cartForm(): CartForm;
  describeControl(id: number): ControlDescription | null;
  variantPicker(): VariantPicker;
  variantSignature(): string;
  modalTriggers(exclude: readonly number[]): Trigger[];
  focusElement(id: number): boolean;
  targetOf(id: number): Target | null;
  quiet(quietMs: number, capMs: number): Promise<void>;
}

export function installProbe(key: string): void {
  const slot = Symbol.for(key);
  const host = globalThis as unknown as Record<symbol, unknown>;
  if (host[slot] !== undefined) return;

  // ---- element identity -------------------------------------------------------------------
  const registry = new Map<number, Element>();
  const identities = new WeakMap<Element, number>();
  let nextId = 1;
  function idOf(el: Element): number {
    let id = identities.get(el);
    if (id === undefined) {
      id = nextId;
      nextId += 1;
      identities.set(el, id);
      registry.set(id, el);
    }
    return id;
  }
  function byId(id: number): Element | null {
    const el = registry.get(id);
    return el?.isConnected === true ? el : null;
  }

  // ---- selectors (axe-core target format) ---------------------------------------------------
  function uniqueId(el: Element, root: Document | ShadowRoot): string | null {
    if (el.id === '') return null;
    const sel = `#${CSS.escape(el.id)}`;
    return root.querySelectorAll(sel).length === 1 ? sel : null;
  }
  function selectorWithin(el: Element, root: Document | ShadowRoot): string {
    const parts: string[] = [];
    let node: Element | null = el;
    for (let guard = 0; node !== null && guard < 256; guard += 1) {
      const byIdSel = uniqueId(node, root);
      if (byIdSel !== null) {
        parts.unshift(byIdSel);
        break;
      }
      let part = CSS.escape(node.localName);
      const parentNode: Node | null = node.parentNode;
      const siblings: HTMLCollection | null =
        parentNode instanceof Element ||
        parentNode instanceof Document ||
        parentNode instanceof ShadowRoot
          ? parentNode.children
          : null;
      if (siblings !== null) {
        let same = 0;
        let index = 0;
        for (const sibling of Array.from(siblings)) {
          if (sibling.localName === node.localName) {
            same += 1;
            if (sibling === node) index = same;
          }
        }
        if (same > 1) part += `:nth-of-type(${String(index)})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function targetOf(el: Element): Target {
    const path: string[] = [];
    let current: Element = el;
    for (let guard = 0; guard < 32; guard += 1) {
      const root = current.getRootNode();
      if (root instanceof ShadowRoot) {
        path.unshift(selectorWithin(current, root));
        current = root.host;
        continue;
      }
      path.unshift(selectorWithin(current, document));
      break;
    }
    return path;
  }

  // ---- composed tree helpers ----------------------------------------------------------------
  function composedParent(node: Node): Node | null {
    if (node instanceof ShadowRoot) return node.host;
    return node.parentNode;
  }
  function composedContains(ancestor: Element, node: Node): boolean {
    let current: Node | null = node;
    for (let guard = 0; current !== null && guard < 1024; guard += 1) {
      if (current === ancestor) return true;
      current = composedParent(current);
    }
    return false;
  }
  function deepActive(): Element | null {
    let el: Element | null = document.activeElement;
    for (let guard = 0; guard < 32; guard += 1) {
      const inner: Element | null | undefined = el?.shadowRoot?.activeElement;
      if (inner === null || inner === undefined) break;
      el = inner;
    }
    if (el === null || el === document.body || el === document.documentElement) return null;
    return el;
  }
  function deepElementFromPoint(x: number, y: number): Element | null {
    let hit = document.elementFromPoint(x, y);
    for (let guard = 0; hit?.shadowRoot && guard < 32; guard += 1) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (inner === null || inner === hit) break;
      hit = inner;
    }
    return hit;
  }
  function allElements(cap: number): Element[] {
    const out: Element[] = [];
    const roots: (Document | ShadowRoot)[] = [document];
    for (let r = 0; r < roots.length && out.length < cap; r += 1) {
      const root = roots[r];
      if (root === undefined) break;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n !== null && out.length < cap; n = walker.nextNode()) {
        if (!(n instanceof Element)) continue;
        out.push(n);
        if (n.shadowRoot !== null) roots.push(n.shadowRoot);
      }
    }
    return out;
  }
  function viewport(): { width: number; height: number } {
    return {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    };
  }

  const FOCUSABLE =
    'a[href],area[href],button,input:not([type="hidden"]),select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable="true"],audio[controls],video[controls]';

  // ---- visibility ---------------------------------------------------------------------------
  function isVisible(el: Element): boolean {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }
  // A visually hidden radio or checkbox shows focus on its label (Dawn's variant pills).
  function visualProxy(el: Element): Element | null {
    if (!(el instanceof HTMLInputElement)) return null;
    const r = el.getBoundingClientRect();
    const tiny = r.width <= 2 || r.height <= 2;
    const transparent = !el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    if (!tiny && !transparent) return null;
    for (const label of Array.from(el.labels ?? [])) {
      if (isVisible(label)) return label;
    }
    return null;
  }
  function hiddenReason(el: Element): HiddenReason | null {
    const subject = visualProxy(el) ?? el;
    if (!subject.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      return 'invisible';
    }
    const r = subject.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return 'zero-size';
    const vp = viewport();
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vp.width || r.top >= vp.height) {
      return 'offscreen';
    }
    let ancestor = subject.parentElement;
    for (let depth = 0; ancestor !== null && depth < 64; depth += 1) {
      const cs = getComputedStyle(ancestor);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const a = ancestor.getBoundingClientRect();
        if (r.right <= a.left || r.left >= a.right || r.bottom <= a.top || r.top >= a.bottom) {
          return 'clipped';
        }
      }
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  // ---- focus indicator snapshots ------------------------------------------------------------
  const INDICATOR_PROPS = [
    'outline-style',
    'outline-width',
    'outline-color',
    'outline-offset',
    'box-shadow',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
    'background-color',
    'background-image',
    'color',
    'text-decoration-line',
    'text-decoration-color',
    'text-decoration-style',
    'text-decoration-thickness',
    'text-underline-offset',
    'opacity',
    'filter',
    'fill',
    'stroke',
    'stroke-width',
  ];
  const OWN_PROPS = ['transform', 'scale', 'translate'];
  const PSEUDO_PROPS = ['content', 'width', 'height', 'display', 'visibility', 'transform'];
  function styleKey(el: Element, pseudo: string | null, extra: readonly string[]): string {
    const cs = getComputedStyle(el, pseudo);
    const values = INDICATOR_PROPS.map((p) => cs.getPropertyValue(p));
    if (cs.outlineStyle === 'none' || Number.parseFloat(cs.outlineWidth) === 0) {
      values[0] = 'none';
      values[1] = '';
      values[2] = '';
      values[3] = '';
    }
    for (const p of extra) values.push(cs.getPropertyValue(p));
    return values.join('|');
  }
  function snapshot(el: Element): string[] {
    const keys: string[] = [];
    const withPseudo: Element[] = [el];
    const proxy = visualProxy(el);
    if (proxy !== null) withPseudo.push(proxy);
    // A radio or checkbox often shows focus on its label or on the element after it
    // (`input:focus-visible + label`). Other elements' siblings may be the next stop, whose
    // own focus ring would read as this element's indicator, so they are never carriers.
    if (el instanceof HTMLInputElement) {
      for (const label of Array.from(el.labels ?? []).slice(0, 2)) withPseudo.push(label);
      const next = el.nextElementSibling;
      if (next !== null && !next.matches(FOCUSABLE)) withPseudo.push(next);
    }
    for (const carrier of withPseudo) {
      keys.push(styleKey(carrier, null, carrier === el ? OWN_PROPS : []));
      keys.push(styleKey(carrier, '::before', PSEUDO_PROPS));
      keys.push(styleKey(carrier, '::after', PSEUDO_PROPS));
    }
    let ancestor = el.parentElement;
    for (let depth = 0; ancestor !== null && depth < 2; depth += 1) {
      keys.push(styleKey(ancestor, null, []));
      ancestor = ancestor.parentElement;
    }
    return keys;
  }

  // ---- traversal ----------------------------------------------------------------------------
  let traversalStyle: HTMLStyleElement | null = null;
  let sentinel: HTMLElement | null = null;
  let last: { id: number; el: Element; focused: string[] } | null = null;

  function ensureSentinel(): HTMLElement {
    if (sentinel?.isConnected === true) return sentinel;
    const s = document.createElement('span');
    s.tabIndex = -1;
    s.setAttribute('data-rampsmith-sentinel', '');
    s.setAttribute('aria-hidden', 'true');
    s.style.cssText =
      'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;outline:none';
    (document.querySelector('body') ?? document.documentElement).prepend(s);
    sentinel = s;
    return s;
  }

  function prepareTraversal(start: 'top' | 'current'): void {
    if (traversalStyle?.isConnected !== true) {
      traversalStyle = document.createElement('style');
      traversalStyle.setAttribute('data-rampsmith-probe', '');
      // Instant scrolling and no transitions, so every measurement sees settled styles.
      traversalStyle.textContent =
        '*,*::before,*::after{transition:none!important;scroll-behavior:auto!important}';
      document.head.append(traversalStyle);
    }
    last = null;
    if (start === 'top') {
      window.scrollTo(0, 0);
      const active = deepActive();
      if (active instanceof HTMLElement) active.blur();
      ensureSentinel().focus({ preventScroll: true });
    }
  }

  function endTraversal(): void {
    traversalStyle?.remove();
    traversalStyle = null;
    const active = deepActive();
    if (active instanceof HTMLElement && active === sentinel) active.blur();
    sentinel?.remove();
    sentinel = null;
    last = null;
  }

  // Elements whose own tab stops live inside them (frames, native media controls, date and
  // time fields): the page sees one focused element while the user tabs through several.
  function hasInternalStops(el: Element): boolean {
    if (el.localName === 'iframe' || el.localName === 'frame') return true;
    if (el instanceof HTMLMediaElement && el.controls) return true;
    return (
      el instanceof HTMLInputElement &&
      ['date', 'time', 'datetime-local', 'month', 'week'].includes(el.type)
    );
  }

  function step(): StepResult {
    const el = deepActive();
    let previous: IndicatorVerdict | null = null;
    if (last !== null && last.el !== el && last.el.isConnected) {
      const now = snapshot(last.el);
      const changed =
        now.length !== last.focused.length || now.some((k, i) => k !== last?.focused[i]);
      previous = { id: last.id, target: targetOf(last.el), changed };
    }
    if (el === null || el === sentinel) {
      last = null;
      return { kind: 'outside', previous };
    }
    const id = idOf(el);
    const isFrame = hasInternalStops(el);
    const hidden = isFrame ? null : hiddenReason(el);
    if (last?.el !== el) {
      last = hidden === null && !isFrame ? { id, el, focused: snapshot(el) } : null;
    }
    return { kind: 'stop', id, target: targetOf(el), frame: isFrame, hidden, previous };
  }

  function tabbableCount(): number {
    let n = 0;
    for (const el of allElements(50_000)) {
      if (!el.matches(FOCUSABLE)) continue;
      if (!(el instanceof HTMLElement) || el.tabIndex < 0) continue;
      if (el.matches(':disabled')) continue;
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      n += 1;
    }
    return n;
  }

  const DIALOG = 'dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"]';
  function cycleInModalWithButton(ids: readonly number[]): boolean {
    let dialog: Element | null = null;
    let button = false;
    for (const id of ids) {
      const el = byId(id);
      const d = el?.closest(DIALOG) ?? null;
      if (el === null || d === null) return false;
      if (dialog === null) dialog = d;
      else if (dialog !== d) return false;
      if (
        el.matches(
          'button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]',
        )
      ) {
        button = true;
      }
    }
    return dialog !== null && button;
  }

  function clipOf(el: Element): ClipRect | null {
    const subject = visualProxy(el) ?? el;
    const r = subject.getBoundingClientRect();
    const vp = viewport();
    const left = Math.max(0, Math.floor(r.left - 6));
    const top = Math.max(0, Math.floor(r.top - 6));
    const right = Math.min(vp.width, Math.ceil(r.right + 6));
    const bottom = Math.min(vp.height, Math.ceil(r.bottom + 6));
    if (right - left < 1 || bottom - top < 1) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function focusById(id: number): ClipRect | null {
    const el = byId(id);
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.focus({ preventScroll: true });
    return deepActive() === el ? clipOf(el) : null;
  }

  function focusSentinel(): void {
    ensureSentinel().focus({ preventScroll: true });
  }

  // ---- 2.4.11: focus not obscured ------------------------------------------------------------
  function obscured(): ObscuredResult {
    const el = deepActive();
    if (el === null || el === sentinel) return { kind: 'outside' };
    if (el.localName === 'iframe' || hiddenReason(el) !== null) {
      return { kind: 'skipped', id: idOf(el) };
    }
    const subject = visualProxy(el) ?? el;
    const r = subject.getBoundingClientRect();
    const vp = viewport();
    const left = Math.max(r.left, 0);
    const right = Math.min(r.right, vp.width);
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, vp.height);
    const result = { kind: 'stop' as const, id: idOf(el), target: targetOf(el) };
    if (right - left < 1 || bottom - top < 1) return { ...result, obscuredBy: null };
    const covers = new Map<Element, number>();
    const grid = 5;
    for (let i = 0; i < grid; i += 1) {
      for (let j = 0; j < grid; j += 1) {
        const x = left + ((right - left) * (i + 0.5)) / grid;
        const y = top + ((bottom - top) * (j + 0.5)) / grid;
        const hit = deepElementFromPoint(x, y);
        if (
          hit === null ||
          composedContains(subject, hit) ||
          composedContains(el, hit) ||
          composedContains(hit, el)
        ) {
          return { ...result, obscuredBy: null };
        }
        covers.set(hit, (covers.get(hit) ?? 0) + 1);
      }
    }
    let cover: Element | null = null;
    let best = 0;
    for (const [candidate, count] of covers) {
      if (count > best) {
        best = count;
        cover = candidate;
      }
    }
    if (cover === null) return { ...result, obscuredBy: null };
    let layer: Element = cover;
    for (let a: Element | null = cover, depth = 0; a !== null && depth < 64; depth += 1) {
      const position = getComputedStyle(a).position;
      if (position === 'fixed' || position === 'sticky') {
        layer = a;
        break;
      }
      a = a.parentElement;
    }
    return { ...result, obscuredBy: targetOf(layer) };
  }

  // ---- 1.4.10: reflow -----------------------------------------------------------------------
  const REFLOW_EXEMPT =
    'table,pre,video,canvas,iframe,img,svg,map,object,embed,math,[role="img"],[role="grid"],[role="application"]';
  function reflow(): ReflowResult {
    const vp = viewport();
    const body = document.querySelector('body');
    const scrollWidth = Math.max(document.documentElement.scrollWidth, body?.scrollWidth ?? 0);
    const culprits: ReflowCulprit[] = [];
    if (scrollWidth <= vp.width + 1) {
      return { viewportWidth: vp.width, scrollWidth, culprits };
    }
    let exempt = 0;
    const stack: Element[] = body === null ? [] : [body];
    let visited = 0;
    while (stack.length > 0 && visited < 30_000 && culprits.length < 10) {
      const el = stack.pop();
      if (el === undefined) break;
      visited += 1;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vp.width + 1) {
        if (el.matches(REFLOW_EXEMPT)) exempt += 1;
        else culprits.push({ target: targetOf(el), overflowPx: Math.round(r.right - vp.width) });
        continue;
      }
      if (el.matches(REFLOW_EXEMPT)) continue;
      // Content inside a box that scrolls or clips horizontally cannot widen the page.
      if (cs.overflowX !== 'visible') continue;
      for (let i = el.children.length - 1; i >= 0; i -= 1) {
        const child = el.children[i];
        if (child !== undefined) stack.push(child);
      }
    }
    if (culprits.length === 0 && exempt === 0) {
      culprits.push({
        target: targetOf(document.documentElement),
        overflowPx: Math.round(scrollWidth - vp.width),
      });
    }
    return { viewportWidth: vp.width, scrollWidth, culprits };
  }

  // ---- 1.4.12: text spacing -----------------------------------------------------------------
  let spacingStyle: HTMLStyleElement | null = null;
  let spacingBefore = new Map<Element, boolean>();
  function overflows(el: Element): boolean {
    return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
  }
  function hasOwnText(el: Element): boolean {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '') return true;
    }
    return false;
  }
  function textSpacingBefore(): number {
    spacingBefore = new Map();
    for (const el of allElements(30_000)) {
      if (el.closest('[data-rampsmith-probe],[data-rampsmith-sentinel]') !== null) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'inline' || cs.display === 'contents' || cs.display === 'none') continue;
      const clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      const visibleOverflow = cs.overflowX === 'visible' && cs.overflowY === 'visible';
      if (!clipsX && !clipsY && !visibleOverflow) continue;
      if (visibleOverflow && !hasOwnText(el)) continue;
      if (!visibleOverflow && el.textContent.trim() === '') continue;
      if (!isVisible(el)) continue;
      spacingBefore.set(el, overflows(el));
    }
    return spacingBefore.size;
  }
  function textSpacingApply(): void {
    spacingStyle?.remove();
    spacingStyle = document.createElement('style');
    spacingStyle.setAttribute('data-rampsmith-probe', '');
    // The four values of WCAG 2.2 SC 1.4.12, as multiples of the font size.
    spacingStyle.textContent =
      '*{line-height:1.5!important;letter-spacing:0.12em!important;word-spacing:0.16em!important}' +
      'p{margin-bottom:2em!important}';
    document.head.append(spacingStyle);
  }
  function textSpacingAfter(): TextSpacingIssue[] {
    const issues: TextSpacingIssue[] = [];
    for (const [el, before] of spacingBefore) {
      if (issues.length >= 40) break;
      if (before || !el.isConnected || !overflows(el)) continue;
      const cs = getComputedStyle(el);
      const clips =
        cs.overflowX === 'hidden' ||
        cs.overflowX === 'clip' ||
        cs.overflowY === 'hidden' ||
        cs.overflowY === 'clip';
      issues.push({ target: targetOf(el), kind: clips ? 'clipped' : 'overflow' });
    }
    return issues;
  }
  function textSpacingRemove(): void {
    spacingStyle?.remove();
    spacingStyle = null;
    spacingBefore = new Map();
  }

  // ---- 1.4.2: audio control -----------------------------------------------------------------
  interface MediaExtras {
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length: number };
  }
  function media(): MediaInfo[] {
    const out: MediaInfo[] = [];
    for (const el of allElements(50_000)) {
      if (out.length >= 50) break;
      if (!(el instanceof HTMLMediaElement)) continue;
      const tag = el instanceof HTMLAudioElement ? 'audio' : 'video';
      const extras = el as HTMLMediaElement & MediaExtras;
      let hasAudio: boolean | null = null;
      if (tag === 'audio') hasAudio = true;
      else if (typeof extras.mozHasAudio === 'boolean') hasAudio = extras.mozHasAudio;
      else if (extras.audioTracks !== undefined) hasAudio = extras.audioTracks.length > 0;
      else if ((extras.webkitAudioDecodedByteCount ?? 0) > 0) hasAudio = true;
      const d = el.duration;
      out.push({
        id: idOf(el),
        target: targetOf(el),
        tag,
        autoplay: el.autoplay,
        playing: !el.paused && !el.ended,
        muted: el.muted || el.volume === 0,
        controls: el.controls,
        loop: el.loop,
        readyState: el.readyState,
        duration: Number.isNaN(d) ? -1 : Number.isFinite(d) ? d : 1e9,
        hasAudio,
      });
    }
    return out;
  }
  function accessibleName(el: Element): string {
    const label = el.getAttribute('aria-label')?.trim() ?? '';
    if (label !== '') return label;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy !== null) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (text !== '') return text;
    }
    if (el instanceof HTMLInputElement) return (el.value !== '' ? el.value : el.title).trim();
    const text = el instanceof HTMLElement ? el.innerText.trim() : el.textContent.trim();
    return text !== '' ? text : (el.getAttribute('title') ?? '').trim();
  }
  const INSTRUMENT =
    'button,[role="button"],[role="switch"],input[type="button"],input[type="checkbox"],input[type="image"]';
  function mediaControl(id: number): MediaControl {
    const el = byId(id);
    if (el === null) return 'none';
    if (el.id !== '') {
      for (const c of Array.from(document.querySelectorAll(INSTRUMENT))) {
        const controls = (c.getAttribute('aria-controls') ?? '').split(/\s+/);
        if (controls.includes(el.id) && isVisible(c) && accessibleName(c) !== '') {
          return 'aria-controls';
        }
      }
    }
    // A named button within three levels counts, but never one found only at page level.
    let container = el.parentElement;
    for (let depth = 0; container !== null && depth < 3; depth += 1) {
      if (container === document.body || container.matches('main,html')) break;
      for (const c of Array.from(container.querySelectorAll(INSTRUMENT))) {
        if (isVisible(c) && accessibleName(c) !== '') return 'nearby';
      }
      container = container.parentElement;
    }
    return 'none';
  }

  // ---- interactive states -------------------------------------------------------------------
  function isEnabled(el: Element): boolean {
    if (el.matches(':disabled')) return false;
    return el.getAttribute('aria-disabled')?.trim() !== 'true';
  }
  function triggerOf(el: Element): Trigger {
    return { id: idOf(el), target: targetOf(el) };
  }
  const TOGGLE = 'button,summary,[role="button"]';
  function isMenuToggle(el: Element): boolean {
    if (!el.matches(TOGGLE) || !isVisible(el) || !isEnabled(el)) return false;
    if (el.getAttribute('aria-haspopup')?.toLowerCase() === 'dialog') return false;
    if (el.localName === 'summary') {
      const details = el.parentElement;
      return details?.localName === 'details' && !(details as HTMLDetailsElement).open;
    }
    return el.getAttribute('aria-expanded') === 'false';
  }
  function linkCount(region: Element | null): number {
    return region === null ? 0 : region.querySelectorAll('a[href]').length;
  }
  function controlled(el: Element): Element | null {
    const ids = (el.getAttribute('aria-controls') ?? '').trim().split(/\s+/);
    for (const id of ids) {
      if (id === '') continue;
      const target = document.getElementById(id);
      if (target !== null) return target;
    }
    return null;
  }
  function navTriggers(): Trigger[] {
    const inNav: Element[] = [];
    const inHeader: Element[] = [];
    for (const el of Array.from(document.querySelectorAll(TOGGLE))) {
      if (!isMenuToggle(el)) continue;
      const region = el.localName === 'summary' ? el.parentElement : controlled(el);
      if (el.closest('nav,[role="navigation"]') !== null) inNav.push(el);
      else if (
        el.closest('header,[role="banner"]') !== null &&
        (linkCount(region) >= 2 || /menu|navigation/i.test(accessibleName(el)))
      ) {
        inHeader.push(el);
      }
    }
    return [...inHeader, ...inNav].slice(0, 5).map(triggerOf);
  }
  function isExpanded(id: number): boolean {
    const el = byId(id);
    if (el === null) return false;
    if (el.localName === 'summary') {
      return (el.parentElement as HTMLDetailsElement | null)?.open === true;
    }
    if (el.getAttribute('aria-expanded') === 'true') return true;
    const region = controlled(el);
    return region !== null && isVisible(region);
  }
  function regionOf(id: number): Target | null {
    const el = byId(id);
    if (el === null) return null;
    if (el.localName === 'summary' && el.parentElement !== null) {
      for (const child of Array.from(el.parentElement.children)) {
        if (child !== el && isVisible(child)) return targetOf(child);
      }
      return targetOf(el.parentElement);
    }
    const region = controlled(el);
    if (region !== null) return targetOf(region);
    const nav = el.closest('nav,[role="navigation"],header');
    return nav === null ? null : targetOf(nav);
  }
  const OVERLAY_HINT = /cart|drawer|modal|popup|dialog|notification/i;
  function isOverlay(el: Element): boolean {
    if (!isVisible(el)) return false;
    if (el.matches(DIALOG)) return true;
    const hint = `${el.id} ${el.getAttribute('class') ?? ''} ${el.localName}`;
    if (!OVERLAY_HINT.test(hint)) return false;
    const position = getComputedStyle(el).position;
    const r = el.getBoundingClientRect();
    return (position === 'fixed' || position === 'absolute') && r.width * r.height >= 10_000;
  }
  function overlays(): number[] {
    const out: number[] = [];
    for (const el of allElements(50_000)) {
      if (isOverlay(el)) out.push(idOf(el));
    }
    return out;
  }
  function pickOverlay(
    ids: readonly number[],
    prefer: 'cart' | 'dialog' | 'dialog-only',
  ): Target | null {
    const elements = ids.map(byId).filter((el): el is Element => el !== null && isOverlay(el));
    // Outermost first: a drawer's inner dialog is part of the drawer.
    const outer = elements.filter((el) => !elements.some((o) => o !== el && o.contains(el)));
    const cartLike = (el: Element): boolean =>
      /cart/i.test(
        `${el.id} ${el.getAttribute('class') ?? ''} ${el.localName} ${accessibleName(el).slice(0, 80)}`,
      );
    const dialogs = outer.filter((el) => el.matches(DIALOG));
    const ordered =
      prefer === 'cart'
        ? [...outer.filter(cartLike), ...dialogs.filter((el) => !cartLike(el))]
        : prefer === 'dialog'
          ? [...dialogs, ...outer.filter((el) => !el.matches(DIALOG))]
          : dialogs;
    const first = ordered[0];
    return first === undefined ? null : targetOf(first);
  }
  function cartForm(): CartForm {
    const forms = Array.from(document.querySelectorAll('form')).filter((form) => {
      try {
        return /\/cart\/add(?:\.js)?$/.test(new URL(form.action, location.href).pathname);
      } catch {
        return false;
      }
    });
    if (forms.length === 0) return { found: false, reason: 'no_product_form' };
    const ordered = [
      ...forms.filter((f) => f.closest('main') !== null),
      ...forms.filter((f) => f.closest('main') === null),
    ];
    let sawButton = false;
    for (const form of ordered) {
      const buttons = Array.from(
        form.querySelectorAll('button[type="submit"],button:not([type]),input[type="submit"]'),
      );
      if (form.id !== '') {
        buttons.push(
          ...Array.from(
            document.querySelectorAll(`[form="${CSS.escape(form.id)}"][type="submit"]`),
          ),
        );
      }
      for (const button of buttons) {
        if (!isVisible(button)) continue;
        sawButton = true;
        if (isEnabled(button))
          return { found: true, button: idOf(button), target: targetOf(button) };
      }
    }
    return { found: false, reason: sawButton ? 'sold_out' : 'no_product_form' };
  }
  function describeField(el: Element): FieldDescription {
    const input = el as HTMLInputElement;
    return {
      tag: el.localName,
      type: (el.getAttribute('type') ?? '').toLowerCase(),
      name: el.getAttribute('name') ?? '',
      id: el.id,
      autocomplete: (el.getAttribute('autocomplete') ?? '').toLowerCase(),
      hasValue: typeof input.value === 'string' && input.value !== '',
    };
  }
  function describeControl(id: number): ControlDescription | null {
    const el = byId(id);
    if (el === null) return null;
    const anchor = el.closest('a[href]');
    const submitter = el as HTMLButtonElement;
    const form: HTMLFormElement | null =
      el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? submitter.form : null;
    const fields: FieldDescription[] = [];
    if (form !== null) {
      for (const field of Array.from(form.elements)) {
        if ((field as HTMLInputElement).disabled) continue;
        if (!field.matches('input,select,textarea')) continue;
        fields.push(describeField(field));
      }
    }
    const formActionAttr = el.getAttribute('formaction');
    return {
      tag: el.localName,
      type: (el.getAttribute('type') ?? '').toLowerCase(),
      name: el.getAttribute('name') ?? '',
      href: anchor === null ? null : (anchor as HTMLAnchorElement).href,
      formAction:
        formActionAttr !== null
          ? new URL(formActionAttr, location.href).href
          : form === null
            ? null
            : form.action,
      formMethod: form === null ? null : form.method,
      inPaymentWidget:
        el.closest(
          '.shopify-payment-button,shopify-accelerated-checkout,shopify-buy-it-now-button,[data-shopify="payment-button"]',
        ) !== null,
      fields,
      pageUrl: location.href,
    };
  }
  function variantPicker(): VariantPicker {
    const scope =
      document.querySelector('main') ?? document.querySelector('body') ?? document.documentElement;
    const containers = Array.from(
      scope.querySelectorAll('variant-selects,variant-radios,[data-variant-picker],fieldset,form'),
    );
    for (const container of containers) {
      const radios = Array.from(container.querySelectorAll('input[type="radio"]')).filter(
        (r): r is HTMLInputElement =>
          r instanceof HTMLInputElement && !r.disabled && (isVisible(r) || visualProxy(r) !== null),
      );
      const groups = new Map<string, HTMLInputElement[]>();
      for (const r of radios) groups.set(r.name, [...(groups.get(r.name) ?? []), r]);
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const focus = group.find((r) => r.checked) ?? group[0];
        if (focus === undefined) continue;
        const region =
          container.closest('product-info,[id^="MainProduct"],section,main') ?? container;
        return { kind: 'radio', focus: idOf(focus), region: targetOf(region) };
      }
      const selects = Array.from(container.querySelectorAll('select')).filter(
        (s) => isVisible(s) && !s.disabled && s.options.length >= 2,
      );
      const select = selects[0];
      if (select !== undefined) {
        const region =
          container.closest('product-info,[id^="MainProduct"],section,main') ?? container;
        return { kind: 'select', focus: idOf(select), region: targetOf(region) };
      }
    }
    return { kind: 'none' };
  }
  function variantSignature(): string {
    const parts: string[] = [];
    for (const r of Array.from(document.querySelectorAll('input[type="radio"]:checked'))) {
      parts.push(`${(r as HTMLInputElement).name}=${(r as HTMLInputElement).value}`);
    }
    for (const s of Array.from(document.querySelectorAll('select'))) {
      parts.push(`${s.name}=${String(s.selectedIndex)}`);
    }
    return parts.join('&');
  }
  function modalTriggers(exclude: readonly number[]): Trigger[] {
    const skip = new Set(exclude.map(byId).filter((el): el is Element => el !== null));
    const out: Element[] = [];
    const candidates = Array.from(
      document.querySelectorAll(
        '[aria-haspopup="dialog"],modal-opener button,modal-opener [role="button"],[data-modal],button[aria-controls],summary[aria-controls]',
      ),
    );
    for (const el of candidates) {
      if (skip.has(el) || !isVisible(el) || !isEnabled(el)) continue;
      if (
        !el.matches(TOGGLE) &&
        !(el.localName === 'a' && (el.getAttribute('href') ?? '#').startsWith('#'))
      ) {
        continue;
      }
      const target = controlled(el);
      const opensDialog =
        el.getAttribute('aria-haspopup')?.toLowerCase() === 'dialog' ||
        el.closest('modal-opener') !== null ||
        el.hasAttribute('data-modal') ||
        (target !== null && (target.matches(DIALOG) || target.localName === 'dialog'));
      if (!opensDialog) continue;
      const hint = `${el.id} ${el.getAttribute('class') ?? ''} ${target?.id ?? ''} ${target?.getAttribute('class') ?? ''}`;
      if (/cart/i.test(hint)) continue;
      out.push(el);
    }
    return out.slice(0, 5).map(triggerOf);
  }
  function focusElement(id: number): boolean {
    const el = byId(id);
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
    el.focus();
    return deepActive() === el;
  }
  function targetById(id: number): Target | null {
    const el = byId(id);
    return el === null ? null : targetOf(el);
  }
  function quiet(quietMs: number, capMs: number): Promise<void> {
    return new Promise((resolve) => {
      let timer = window.setTimeout(done, quietMs);
      const cap = window.setTimeout(done, capMs);
      const observer = new MutationObserver(() => {
        window.clearTimeout(timer);
        timer = window.setTimeout(done, quietMs);
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true });
      function done(): void {
        observer.disconnect();
        window.clearTimeout(timer);
        window.clearTimeout(cap);
        resolve();
      }
    });
  }

  const api: ProbeApi = {
    prepareTraversal,
    endTraversal,
    step,
    tabbableCount,
    cycleInModalWithButton,
    focusById,
    focusSentinel,
    obscured,
    reflow,
    textSpacingBefore,
    textSpacingApply,
    textSpacingAfter,
    textSpacingRemove,
    media,
    mediaControl,
    navTriggers,
    isExpanded,
    regionOf,
    overlays,
    pickOverlay,
    cartForm,
    describeControl,
    variantPicker,
    variantSignature,
    modalTriggers,
    focusElement,
    targetOf: targetById,
    quiet,
  };
  Object.defineProperty(globalThis, slot, {
    value: api,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}
