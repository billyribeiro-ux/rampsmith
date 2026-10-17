// Data exchanged between the Node side of the browser checks and the probe that runs inside
// the page (src/browser/probe.ts). Everything here is plain JSON.

/** axe-core-style target: one selector per shadow-root boundary. */
export type Target = string[];

export interface ClipRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Why a focused element cannot be seen. */
export type HiddenReason = 'zero-size' | 'invisible' | 'offscreen' | 'clipped';

/** The focus-indicator verdict for the stop before the current one. */
export interface IndicatorVerdict {
  readonly id: number;
  readonly target: Target;
  /** Whether any visible style of the element or its indicator carriers changed on focus. */
  readonly changed: boolean;
}

export type StepResult =
  | { readonly kind: 'outside'; readonly previous: IndicatorVerdict | null }
  | {
      readonly kind: 'stop';
      readonly id: number;
      readonly target: Target;
      /** The element has tab stops of its own inside it (an iframe, native media controls). */
      readonly frame: boolean;
      readonly hidden: HiddenReason | null;
      readonly previous: IndicatorVerdict | null;
    };

export type ObscuredResult =
  | { readonly kind: 'outside' }
  | { readonly kind: 'skipped'; readonly id: number }
  | {
      readonly kind: 'stop';
      readonly id: number;
      readonly target: Target;
      /** The element covering the focused one, when it is entirely covered. */
      readonly obscuredBy: Target | null;
    };

export interface ReflowCulprit {
  readonly target: Target;
  readonly overflowPx: number;
}

export interface ReflowResult {
  readonly viewportWidth: number;
  readonly scrollWidth: number;
  readonly culprits: readonly ReflowCulprit[];
}

export interface TextSpacingIssue {
  readonly target: Target;
  readonly kind: 'clipped' | 'overflow';
}

export interface MediaInfo {
  readonly id: number;
  readonly target: Target;
  readonly tag: 'audio' | 'video';
  readonly autoplay: boolean;
  readonly playing: boolean;
  readonly muted: boolean;
  readonly controls: boolean;
  readonly loop: boolean;
  readonly readyState: number;
  /** Seconds; -1 when unknown, a large number for live streams. */
  readonly duration: number;
  /** `true` or `false` when the browser can tell whether the media has sound, else `null`. */
  readonly hasAudio: boolean | null;
}

export type MediaControl = 'aria-controls' | 'nearby' | 'none';

/** A control an interactive-state script may activate. */
export interface Trigger {
  readonly id: number;
  readonly target: Target;
}

/** A form field, described without its value so no personal data leaves the page. */
export interface FieldDescription {
  readonly tag: string;
  readonly type: string;
  readonly name: string;
  readonly id: string;
  readonly autocomplete: string;
  readonly hasValue: boolean;
}

/** What activating a control would do, for the guards in src/states/guards.ts. */
export interface ControlDescription {
  readonly tag: string;
  readonly type: string;
  readonly name: string;
  /** Resolved `href` of a link, or `null`. */
  readonly href: string | null;
  /** Resolved action of the form the control submits, or `null`. */
  readonly formAction: string | null;
  readonly formMethod: string | null;
  /** Inside an accelerated-checkout widget such as a "Buy it now" button. */
  readonly inPaymentWidget: boolean;
  /** Enabled fields of the form the control submits. */
  readonly fields: readonly FieldDescription[];
  readonly pageUrl: string;
}

export type CartForm =
  | { readonly found: true; readonly button: number; readonly target: Target }
  | { readonly found: false; readonly reason: 'no_product_form' | 'sold_out' };

export type VariantPicker =
  | { readonly kind: 'radio'; readonly focus: number; readonly region: Target }
  | { readonly kind: 'select'; readonly focus: number; readonly region: Target }
  | { readonly kind: 'none' };

/** Whether activating a control could enter checkout or submit personal data. */
export type GuardVerdict =
  | { readonly safe: true }
  | { readonly safe: false; readonly guard: 'checkout' | 'personal_data'; readonly detail: string };
