/**
 * The source mapper's contract (PLAN §12, "Mapping a rendered element to its source";
 * ADR-244, ADR-245): it receives one finding on a rendered page, described by the scanner, and
 * the theme's files, and returns where the fix belongs: an element, a colour setting, a CSS
 * declaration or a field of store data, each with a confidence in [0, 1].
 *
 * The mapper is pure: it reads no network, browser or clock, so the same inputs always give the
 * same answer. Confidence 0.9 or more is the bar for acting on a mapping without a person.
 */
import type { CssDeclarationSpan, JsonValueSpan } from '../recipes/contrast.ts';

/** An element's tag and attributes as the browser holds them (names lower case, values decoded). */
export interface Sibling {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface RenderedNode extends Sibling {
  /** The element siblings before this one, nearest first; absent when not collected. */
  readonly previous?: readonly Sibling[];
  /** The number of element siblings after this one; absent when not collected. */
  readonly following?: number;
}

/** The element a scanner reported, with its ancestors, nearest first, up to `<html>`. */
export interface RenderedElement extends RenderedNode {
  /** Text content with runs of whitespace collapsed to one space and the ends trimmed. */
  readonly text: string;
  readonly ancestors: readonly RenderedNode[];
}

/** What the scanner measured, for the findings that need it. */
export interface MapEvidence {
  /** The text colour axe-core measured (`fgColor`), such as `#9b9b9b`. */
  readonly foreground?: string;
  /** The box of the target in CSS pixels, as axe-core's `target-size` measured it. */
  readonly width?: number;
  readonly height?: number;
}

/** The store resource a page shows, so rich text it prints can be traced to its field. */
export interface RenderedResource {
  readonly type: 'product' | 'collection' | 'page' | 'article' | 'blog';
  /** The Admin API global id, such as `gid://shopify/Article/3001`. */
  readonly gid: string;
  /** The HTML of its rich-text fields by Admin API field name (`body`, `descriptionHtml`). */
  readonly fields: Readonly<Record<string, string>>;
}

export interface FindingToMap {
  /** The rule id: an axe-core rule or a Rampsmith rule. */
  readonly rule: string;
  /** The JSON template of the page, such as `index` or `customers/login`. */
  readonly template: string;
  readonly element: RenderedElement;
  readonly evidence?: MapEvidence;
  readonly resource?: RenderedResource;
}

/** The start tag of an element in a Liquid file: the offset of its `<`. */
export interface ElementSpan {
  readonly kind: 'element';
  readonly file: string;
  readonly start: number;
  readonly tag: string;
}

/** A field of store data: the value is edited through the Admin API, never in theme source. */
export interface DataSpan {
  readonly kind: 'data';
  readonly resource: string;
  readonly field: string;
  readonly start: number;
  readonly end: number;
}

export type MappedJsonValue = JsonValueSpan & { readonly start: number; readonly end: number };

export type MappedSpan = ElementSpan | MappedJsonValue | CssDeclarationSpan | DataSpan;

export interface MapCandidate {
  readonly span: MappedSpan;
  readonly confidence: number;
  readonly why: string;
}

export type MapOutcome =
  | {
      readonly status: 'mapped';
      readonly span: MappedSpan;
      readonly confidence: number;
      /** What decided the mapping, one line each, in the order it was found. */
      readonly why: readonly string[];
      /** For a colour or CSS target: the element whose markup renders the failing node. */
      readonly rendersFrom?: ElementSpan;
      /**
       * Other elements that match the rendered one except for where they sit, such as the
       * hidden mobile copy of a header link (ADR-205 finding 7). The same fix applies to them.
       */
      readonly identical?: readonly ElementSpan[];
    }
  | {
      readonly status: 'needs_review';
      readonly reason: string;
      /** Best first; each below the 0.9 bar. */
      readonly candidates: readonly MapCandidate[];
    }
  | { readonly status: 'unmapped'; readonly reason: string };

/** At or above this a mapping is acted on without review (PLAN §12). */
export const CONFIDENCE_THRESHOLD = 0.9;
