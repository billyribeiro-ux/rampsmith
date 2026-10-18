// Types of the golden files in corpus/golden/ (schema: corpus/schema/golden.schema.json,
// contract: corpus/CONTRACT.md). The JSON Schema is the source of truth for the file format;
// these types mirror it and test/schema.test.ts keeps the two in step.

/** Which checker reports the finding. Custom rules come from `@rampsmith/a11y-rules`. */
export type Engine = 'axe' | 'rampsmith-browser' | 'rampsmith-data';

/** axe-core's result type, and a11y-rules' `Outcome`: `incomplete` goes to the review queue. */
export type Outcome = 'violation' | 'incomplete';

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';

/** Rows of the PLAN §12 fix catalog, plus `other` for failures the catalog does not list. */
export const CATEGORIES = [
  'low-contrast',
  'alt-text-media',
  'alt-text-theme-image',
  'form-label',
  'empty-link',
  'empty-button',
  'document-language',
  'skip-link',
  'focus-visible',
  'target-size',
  'rich-text',
  'widget-roles',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * The six failure types behind R2's fix-rate criterion (PLAN §5, §12): low contrast, missing
 * alternative text, missing form labels, empty links, empty buttons, missing document language.
 */
export const TOP_SIX_CATEGORIES: readonly Category[] = [
  'low-contrast',
  'alt-text-media',
  'alt-text-theme-image',
  'form-label',
  'empty-link',
  'empty-button',
  'document-language',
];

/** How mapping should go (PLAN §12): one candidate, several, or no mapping needed. */
export type MappingExpectation = 'deterministic' | 'ambiguous' | 'none';

/**
 * Where the finding maps in source (PLAN §12, "Mapping a rendered element to its source").
 * Offsets are UTF-16 code units into the file as decoded from UTF-8, half-open, the unit of
 * `@shopify/liquid-html-parser` and `packages/liquid-patch` (ADR-101).
 */
export type Span =
  | {
      /** An element in a Liquid file; `start` is the offset of the `<` of its start tag (ADR-102). */
      readonly kind: 'element';
      readonly file: string;
      readonly start: number;
      readonly tag: string;
      /** The start tag's text from `start` to the first line end; reviewers read it, mappers ignore it. */
      readonly anchor: string;
    }
  | {
      /** A value in a theme JSON file, such as a colour in `config/settings_data.json`. */
      readonly kind: 'json-value';
      readonly file: string;
      /** RFC 6901 JSON Pointer to the value. */
      readonly pointer: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      /** A CSS declaration, in a CSS asset or in a Liquid file's `{% stylesheet %}` or `<style>`. */
      readonly kind: 'css-declaration';
      readonly file: string;
      readonly start: number;
      readonly end: number;
      readonly property: string;
      /** The declaration's text, `source.slice(start, end)`. */
      readonly anchor: string;
    }
  | {
      /** Store data read through the Admin API, as a11y-rules' `DataLocation`. */
      readonly kind: 'data';
      readonly resource: string;
      readonly field: string;
      readonly start?: number;
      readonly end?: number;
      /** The value's text between the offsets, when they are given. */
      readonly anchor?: string;
    };

export type SpanKind = Span['kind'];

/** Recipes of `packages/liquid-patch` (ADR-102) and the planned ones, by PLAN §12 row. */
export const RECIPES = [
  'document-language',
  'skip-link',
  'empty-link',
  'empty-button',
  'form-label',
  'image-alt',
  'contrast',
  'focus-visible',
  'target-size',
  'media-alt',
  'rich-text',
  'ai-proposal',
] as const;
export type RecipeName = (typeof RECIPES)[number];

/** The recipes `packages/liquid-patch` ships at `551b200` (ADR-102). */
export const BUILT_RECIPES: readonly RecipeName[] = [
  'document-language',
  'skip-link',
  'empty-link',
  'empty-button',
  'form-label',
  'image-alt',
];

/** liquid-patch's `RefusalCode` at `551b200` (src/recipes/types.ts). */
export const REFUSAL_CODES = [
  'wrong-file',
  'target-not-found',
  'wrong-element',
  'liquid-in-attribute',
  'conditional-attribute',
  'dynamic-content',
  'main-landmark-not-found',
  'head-not-found',
  'id-conflict',
  'needs-unique-id',
  'not-labelable',
  'no-image-object',
  'invalid-parameter',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type FixChannel = 'theme-patch' | 'admin-api' | 'none';

/** What the fix engine is expected to do with the finding. */
export interface ExpectedFix {
  readonly channel: FixChannel;
  readonly recipe: RecipeName;
  /** `fixed`: edits that make the finding disappear; `refused`: the recipe's typed refusal; `review`: a person decides. */
  readonly outcome: 'fixed' | 'refused' | 'review';
  readonly refusal?: RefusalCode;
  /** Counts in R2's fix-rate denominator: a deterministic theme patch in the six top categories. */
  readonly targeted: boolean;
  /** Parameters the engine is expected to pass the recipe, such as a translation key. */
  readonly params?: Readonly<Record<string, unknown>>;
  readonly note?: string;
}

/** One place the rendered finding appears: every element `selector` matches on `page`. */
export interface Occurrence {
  /** A page id of the theme, or `*` for every page of the theme. */
  readonly page: string;
  readonly selector: string;
  /** How many elements the selector matches on the page; 1 when omitted. */
  readonly count?: number;
}

export interface GoldenFinding {
  /** Unique within the file; the corpus-wide id is `<theme>/<id>`. */
  readonly id: string;
  readonly ruleId: string;
  readonly engine: Engine;
  readonly outcome: Outcome;
  readonly impact: Impact;
  /** WCAG 2.2 success criteria of the rule, as stored in `findings.criteria` (PLAN §9). */
  readonly criteria: readonly string[];
  readonly category: Category;
  readonly description: string;
  /** Absent for data-audit findings, which are not rendered. */
  readonly occurrences?: readonly Occurrence[];
  readonly mapping: MappingExpectation;
  readonly span: Span;
  /** The element whose markup renders the failing node, when the span points elsewhere. */
  readonly rendersFrom?: Extract<Span, { kind: 'element' }>;
  /** Why mapping is ambiguous, and what tells the candidates apart. */
  readonly ambiguity?: string;
  readonly expectedFix: ExpectedFix;
}

export interface GoldenFile {
  readonly $schema: string;
  /** The theme, or for a store's data-audit findings the store. */
  readonly subject: string;
  readonly kind: 'failing' | 'control' | 'store';
  /** The sibling streams' commits whose rule ids and span format these goldens follow. */
  readonly alignment: {
    readonly axeCore: string;
    readonly a11yRules: string;
    readonly liquidPatch: string;
  };
  readonly findings: readonly GoldenFinding[];
}
