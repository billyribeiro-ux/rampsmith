/**
 * A test stand-in for Shopify's Polaris web components (ADR-094).
 *
 * Playwright cannot load `cdn.shopify.com/shopifycloud/polaris-1.1.js` (Shopify is not
 * reachable from tests, ADR-014), so the App Home specs serve this file in its place. It
 * implements the `<s-*>` elements the App Home uses, as Polaris does: each one has an open
 * shadow root, standard form controls inside it, and properties that mirror the attributes
 * and events of the real element. The light DOM Svelte renders is never touched, so
 * hydration is not disturbed. It proves the App Home's own markup, labels, focus and keyboard
 * behaviour; whether the real Polaris components pass axe is LAUNCH.md section E, on a dev store.
 */
const make = (text: string): CSSStyleSheet => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text);
  return sheet;
};

const BASE = make(`
  :host { font: 14px/1.5 system-ui, sans-serif; color: #1a1a1a; }
  :host([hidden]), [hidden] { display: none !important; }
  button, a, input, select, textarea { font: inherit; }
  :focus-visible { outline: 2px solid #005bd3; outline-offset: 2px; }
`);

const bool = (el: Element, name: string): boolean =>
  el.hasAttribute(name) && el.getAttribute(name) !== 'false';

interface ShimClass {
  props: string[];
  styles: string;
  prototype: HTMLElement;
}

class Shim extends HTMLElement {
  /** Properties Svelte may set, mirrored to attributes. */
  static props: string[] = [];
  static styles = '';
  static get observedAttributes(): string[] {
    return this.props.map((p) => p.toLowerCase());
  }
  readonly root: ShadowRoot;
  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open', delegatesFocus: true });
    this.root.adoptedStyleSheets = [BASE, make((this.constructor as typeof Shim).styles)];
    this.root.innerHTML = this.template();
    this.setup();
  }
  connectedCallback(): void {
    this.update();
  }
  attributeChangedCallback(): void {
    this.update();
  }
  /** The shadow element with this id; the templates below always contain it. */
  $(id: string): HTMLElement {
    const found = this.root.getElementById(id);
    if (found === null) throw new Error(`shim template has no #${id}`);
    return found;
  }
  input(id: string): HTMLInputElement {
    return this.$(id) as HTMLInputElement;
  }
  button(id: string): HTMLButtonElement {
    return this.$(id) as HTMLButtonElement;
  }
  template(): string {
    return '<slot></slot>';
  }
  setup(): void {
    // Most elements need none.
  }
  update(): void {
    // Most elements are styled slots.
  }
}

function define(tag: string, Class: CustomElementConstructor & ShimClass): void {
  for (const prop of Class.props) {
    if (prop in Class.prototype) continue;
    Object.defineProperty(Class.prototype, prop, {
      get(this: HTMLElement) {
        return this.getAttribute(prop.toLowerCase());
      },
      set(this: HTMLElement, value: string | number | boolean | null | undefined) {
        const attr = prop.toLowerCase();
        if (value === undefined || value === null || value === false) this.removeAttribute(attr);
        else this.setAttribute(attr, value === true ? '' : String(value));
      },
    });
  }
  customElements.define(tag, Class);
}

/** Sets or clears the text of a shadow element and hides it when empty. */
const text = (el: HTMLElement, value: string | null | undefined): void => {
  el.textContent = value ?? '';
  el.hidden = value === null || value === undefined || value === '';
};

define(
  's-page',
  class extends Shim {
    static override props = ['heading'];
    static override styles = `
      :host { display: block; padding: 1rem; }
      header { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; justify-content: space-between; }
      h1 { font-size: 1.5rem; margin: 0; }
    `;
    override template(): string {
      return `<header><h1 id="h"></h1><div><slot name="breadcrumb-actions"></slot><slot name="secondary-actions"></slot><slot name="primary-action"></slot></div></header><slot></slot>`;
    }
    override update(): void {
      text(this.$('h'), this.getAttribute('heading'));
    }
  },
);

define(
  's-section',
  class extends Shim {
    static override props = ['heading'];
    static override styles = `
      :host { display: block; margin-block: 1rem; }
      section { border: 1px solid #8a8a8a; border-radius: 8px; padding: 1rem; background: #fff; }
      h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
    `;
    override template(): string {
      return `<section id="s"><h2 id="h"></h2><slot></slot></section>`;
    }
    override update(): void {
      const heading = this.getAttribute('heading');
      text(this.$('h'), heading);
      if (heading) this.$('s').setAttribute('aria-labelledby', 'h');
      else this.$('s').removeAttribute('aria-labelledby');
    }
  },
);

define(
  's-empty-state',
  class extends Shim {
    static override props = ['heading'];
    static override styles = `:host { display: block; text-align: center; padding: 1rem; } h2 { margin: 0 0 .5rem; font-size: 1.1rem; }`;
    override template(): string {
      return `<div><h2 id="h"></h2><slot></slot><slot name="primary-action"></slot></div>`;
    }
    override update(): void {
      text(this.$('h'), this.getAttribute('heading'));
    }
  },
);

define(
  's-banner',
  class extends Shim {
    static override props = ['heading', 'tone'];
    static override styles = `
      div { border: 1px solid #5c5f62; border-radius: 8px; padding: .75rem; margin-block: .5rem; background: #f6f6f7; }
      :host([tone=critical]) div { border-color: #8e0b21; background: #fff4f4; }
      :host([tone=warning]) div { border-color: #8a6116; background: #fff5ea; }
      strong { display: block; }
    `;
    override template(): string {
      return `<div id="b"><strong id="h"></strong><slot></slot><slot name="secondary-actions"></slot></div>`;
    }
    override update(): void {
      text(this.$('h'), this.getAttribute('heading'));
      this.$('b').setAttribute(
        'role',
        this.getAttribute('tone') === 'critical' ? 'alert' : 'status',
      );
    }
  },
);

define(
  's-badge',
  class extends Shim {
    static override props = ['tone'];
    static override styles = `span { display: inline-block; padding: 0 .5rem; border: 1px solid #5c5f62; border-radius: 1rem; background: #f1f1f1; color: #1a1a1a; font-size: .85rem; }`;
    override template(): string {
      return `<span><slot></slot></span>`;
    }
  },
);

define(
  's-stack',
  class extends Shim {
    static override props = ['direction', 'gap', 'alignItems'];
    static override styles = `
      :host { display: flex; flex-direction: column; gap: .75rem; }
      :host([direction=inline]) { flex-direction: row; flex-wrap: wrap; }
      :host([gap=small]) { gap: .375rem; }
      :host([alignitems=center]) { align-items: center; }
    `;
  },
);

define(
  's-paragraph',
  class extends Shim {
    static override props = ['color'];
    static override styles = `:host { display: block; margin-block: .25rem; } :host([color=subdued]) { color: #5c5f62; }`;
  },
);

define(
  's-text',
  class extends Shim {
    static override props = ['color'];
    static override styles = `:host { display: inline; } :host([color=subdued]) { color: #5c5f62; }`;
  },
);

define(
  's-app-nav',
  class extends Shim {
    // App Bridge renders the navigation in Shopify's admin, not in the app's frame.
    static override styles = `:host { display: none; }`;
  },
);

define(
  's-link',
  class extends Shim {
    static override props = ['href', 'rel', 'target'];
    static override styles = `a { color: #005bd3; }`;
    override template(): string {
      return `<a id="a"><slot></slot></a>`;
    }
    override update(): void {
      const a = this.$('a');
      for (const name of ['href', 'rel', 'target']) {
        const value = this.getAttribute(name);
        if (value === null) a.removeAttribute(name);
        else a.setAttribute(name, value);
      }
    }
  },
);

define(
  's-button',
  class extends Shim {
    static override props = [
      'disabled',
      'loading',
      'variant',
      'tone',
      'accessibilityLabel',
      'type',
    ];
    static override styles = `
      button { min-block-size: 36px; min-inline-size: 36px; padding: 0 .75rem; border: 1px solid #5c5f62; border-radius: 8px; background: #fff; color: #1a1a1a; cursor: pointer; }
      :host([variant=primary]) button { background: #1a1a1a; border-color: #1a1a1a; color: #fff; }
      :host([tone=critical]) button { color: #8e0b21; border-color: #8e0b21; }
      button:disabled { opacity: .7; cursor: default; }
    `;
    static formAssociated = true;
    declare internals: ElementInternals;
    override template(): string {
      return `<button id="b" type="button"><slot></slot></button>`;
    }
    override setup(): void {
      // A shadow-root button cannot submit the page's form itself; Polaris's s-button is
      // form-associated, so a submit button asks its form to submit.
      this.internals = this.attachInternals();
      this.$('b').addEventListener('click', () => {
        if (this.getAttribute('type') === 'submit') this.internals.form?.requestSubmit();
      });
    }
    override update(): void {
      const b = this.button('b');
      b.disabled = bool(this, 'disabled') || bool(this, 'loading');
      b.toggleAttribute('aria-busy', bool(this, 'loading'));
      const label = this.getAttribute('accessibilitylabel');
      if (label) b.setAttribute('aria-label', label);
      else b.removeAttribute('aria-label');
    }
  },
);

define(
  's-progress',
  class extends Shim {
    static override props = ['value', 'max', 'accessibilityLabel'];
    static override styles = `div { block-size: .75rem; background: #e3e3e3; border-radius: 1rem; overflow: hidden; } i { display: block; block-size: 100%; background: #1a1a1a; }`;
    override template(): string {
      return `<div id="p" role="progressbar" aria-valuemin="0"><i id="i"></i></div>`;
    }
    override update(): void {
      const p = this.$('p');
      const max = Number(this.getAttribute('max') ?? 100);
      const value = Number(this.getAttribute('value') ?? 0);
      p.setAttribute('aria-valuemax', String(max));
      p.setAttribute('aria-valuenow', String(value));
      p.setAttribute('aria-label', this.getAttribute('accessibilitylabel') ?? '');
      this.$('i').style.inlineSize = `${String(max > 0 ? (value / max) * 100 : 0)}%`;
    }
  },
);

define(
  's-spinner',
  class extends Shim {
    static override props = ['accessibilityLabel'];
    static override styles = `div { inline-size: 1.25rem; block-size: 1.25rem; border: 2px solid #5c5f62; border-top-color: transparent; border-radius: 50%; }`;
    override template(): string {
      return `<div id="s" role="status"></div>`;
    }
    override update(): void {
      this.$('s').setAttribute('aria-label', this.getAttribute('accessibilitylabel') ?? '');
    }
  },
);

customElements.define('s-option', class extends HTMLElement {});

const FIELD_STYLES = `
  :host { display: block; margin-block: .5rem; }
  label { display: block; font-weight: 600; margin-block-end: .25rem; }
  input:not([type=checkbox]), textarea, select { box-sizing: border-box; inline-size: 100%; min-block-size: 36px; padding: .375rem .5rem; border: 1px solid #5c5f62; border-radius: 8px; background: #fff; color: #1a1a1a; }
  .details { color: #5c5f62; font-size: .85rem; }
  .error { color: #8e0b21; font-size: .85rem; }
  .row { display: flex; align-items: center; gap: .5rem; }
  .row label { margin: 0; font-weight: 400; }
`;

/** A labelled text-like control. `control` names the inner element's tag. */
class Field extends Shim {
  static override props = [
    'label',
    'details',
    'error',
    'disabled',
    'required',
    'value',
    'min',
    'max',
    'step',
    'prefix',
    'rows',
  ];
  static override styles = FIELD_STYLES;
  static control = 'input';
  static inputType = 'text';
  declare _value: string | undefined;
  declare _sync: (() => void) | undefined;
  override template(): string {
    const tag = (this.constructor as typeof Field).control;
    return `<label for="c"><span id="l"></span><span id="r" hidden> (required)</span></label><span id="x" aria-hidden="true"></span><${tag} id="c"></${tag}><div id="d" class="details"></div><div id="e" class="error"></div>`;
  }
  override setup(): void {
    const cls = this.constructor as typeof Field;
    const c = this.input('c');
    if (cls.control === 'input') c.type = cls.inputType;
    if (cls.control === 'select') {
      const sync = (): void => {
        const wanted = this._value ?? c.value;
        c.replaceChildren(
          ...[...this.querySelectorAll('s-option')].map((option) => {
            const o = document.createElement('option');
            o.value = option.getAttribute('value') ?? '';
            o.textContent = option.textContent;
            return o;
          }),
        );
        c.value = wanted;
      };
      this._sync = sync;
      new MutationObserver(sync).observe(this, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    // `change` does not leave a shadow root on its own; `input` does.
    c.addEventListener('change', () => {
      this.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  override connectedCallback(): void {
    this._sync?.();
    super.connectedCallback();
  }
  get value(): string {
    return this.input('c').value;
  }
  set value(v: unknown) {
    this._value = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    this.input('c').value = this._value;
  }
  override update(): void {
    const c = this.input('c');
    text(this.$('l'), this.getAttribute('label'));
    this.$('l').hidden = false;
    this.$('r').hidden = !bool(this, 'required');
    text(this.$('d'), this.getAttribute('details'));
    const error = this.getAttribute('error');
    text(this.$('e'), error);
    c.disabled = bool(this, 'disabled');
    c.required = bool(this, 'required');
    for (const name of ['min', 'max', 'step', 'rows']) {
      const value = this.getAttribute(name);
      if (
        value === null ||
        (name === 'max' && (this.constructor as typeof Field).control === 'textarea')
      )
        c.removeAttribute(name);
      else c.setAttribute(name, value);
    }
    const prefix = this.getAttribute('prefix');
    text(this.$('x'), prefix);
    const described: string[] = [];
    if (this.getAttribute('details')) described.push('d');
    if (error) described.push('e');
    if (described.length > 0) c.setAttribute('aria-describedby', described.join(' '));
    else c.removeAttribute('aria-describedby');
    c.toggleAttribute('aria-invalid', Boolean(error));
    if (error) c.setAttribute('aria-invalid', 'true');
  }
}

define('s-text-field', class extends Field {});
define(
  's-number-field',
  class extends Field {
    static override inputType = 'number';
  },
);
define(
  's-password-field',
  class extends Field {
    static override inputType = 'password';
  },
);
define(
  's-text-area',
  class extends Field {
    static override control = 'textarea';
  },
);
define(
  's-select',
  class extends Field {
    static override control = 'select';
  },
);

/** A checkbox or switch. */
class Toggle extends Shim {
  static override props = ['label', 'details', 'disabled', 'checked'];
  static override styles = FIELD_STYLES;
  static role: string | null = null;
  override template(): string {
    return `<div class="row"><input id="c" type="checkbox"><label for="c" id="l"></label></div><div id="d" class="details"></div>`;
  }
  override setup(): void {
    const role = (this.constructor as typeof Toggle).role;
    if (role) this.$('c').setAttribute('role', role);
    const c = this.$('c');
    c.addEventListener('change', () => {
      this.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  get checked(): boolean {
    return this.input('c').checked;
  }
  set checked(v: unknown) {
    this.input('c').checked = Boolean(v) && v !== 'false';
  }
  override update(): void {
    text(this.$('l'), this.getAttribute('label'));
    this.$('l').hidden = false;
    text(this.$('d'), this.getAttribute('details'));
    const c = this.input('c');
    c.disabled = bool(this, 'disabled');
    if (this.getAttribute('details')) c.setAttribute('aria-describedby', 'd');
    else c.removeAttribute('aria-describedby');
  }
}
define('s-checkbox', class extends Toggle {});
define(
  's-switch',
  class extends Toggle {
    static override role = 'switch';
  },
);
