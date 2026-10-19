/**
 * The recipe contract (ADR-102). A recipe receives a parsed theme file and a target, the
 * file path and the offset of the target element's start tag that the source mapper
 * supplies, and returns span edits, `already-fixed`, or a typed refusal. Recipes are pure.
 */
import type { Edit } from '../edits.ts';
import { elementAt, elementName, type LocatedElement } from '../html.ts';
import type { ParsedFile } from '../parse.ts';
import {
  translationKeyProblem,
  translationTextProblem,
  type TranslationRequirement,
} from '../translations.ts';

export type RecipeId =
  'document-language' | 'skip-link' | 'empty-link' | 'empty-button' | 'form-label' | 'image-alt';

export interface RecipeTarget {
  /** Theme-relative path, such as `layout/theme.liquid`. */
  readonly file: string;
  /** Offset (UTF-16 code units) of the `<` that opens the target element's start tag. */
  readonly start: number;
}

export type RefusalCode =
  /** The target names another file than the one given, or a file the recipe does not fix. */
  | 'wrong-file'
  /** No element's start tag begins at the target offset. */
  | 'target-not-found'
  /** The element there is not one this recipe fixes, or its tag name is Liquid. */
  | 'wrong-element'
  /** The attribute the recipe would add already holds Liquid output it cannot judge. */
  | 'liquid-in-attribute'
  /** The attribute sits inside a Liquid tag in the start tag, such as `{% if %}`. */
  | 'conditional-attribute'
  /** The content holds Liquid that may print text, so a static fix could duplicate a name. */
  | 'dynamic-content'
  | 'main-landmark-not-found'
  | 'head-not-found'
  /** The id the recipe would add is already used in the file. */
  | 'id-conflict'
  /** An id is needed, and a fixed one could repeat on the page; pass one with Liquid in it. */
  | 'needs-unique-id'
  /** The input type takes no label (hidden, submit, reset, button, image). */
  | 'not-labelable'
  /** The image has no image object to take alt text from, and was not declared decorative. */
  | 'no-image-object'
  | 'invalid-parameter';

export type RecipeOutcome =
  | {
      readonly kind: 'edits';
      readonly edits: readonly Edit[];
      /** Keys the edits print, to add to every storefront locale file (`localeEdits`). */
      readonly translations: readonly TranslationRequirement[];
      /** Facts for the fix record, such as why an image was marked decorative. */
      readonly notes: readonly string[];
    }
  | { readonly kind: 'already-fixed'; readonly reason: string }
  | { readonly kind: 'refusal'; readonly code: RefusalCode; readonly detail: string };

export interface Recipe<Params> {
  readonly id: RecipeId;
  /** WCAG 2.2 success criteria the fix addresses. */
  readonly wcag: readonly string[];
  run(file: ParsedFile, target: RecipeTarget, params: Params): RecipeOutcome;
}

export function refuse(code: RefusalCode, detail: string): RecipeOutcome {
  return { kind: 'refusal', code, detail };
}

export function alreadyFixed(reason: string): RecipeOutcome {
  return { kind: 'already-fixed', reason };
}

export function fixed(
  edits: readonly Edit[],
  translations: readonly TranslationRequirement[] = [],
  notes: readonly string[] = [],
): RecipeOutcome {
  return { kind: 'edits', edits, translations, notes };
}

export type Located =
  | { readonly ok: true; readonly element: LocatedElement }
  | { readonly ok: false; readonly outcome: RecipeOutcome };

/** Checks that the target is in this file and is one of the given elements. */
export function locate(file: ParsedFile, target: RecipeTarget, names: readonly string[]): Located {
  if (target.file !== file.path) {
    return {
      ok: false,
      outcome: refuse('wrong-file', `the target is in ${target.file}, not ${file.path}`),
    };
  }
  const element = elementAt(file.ast, target.start);
  if (element === null) {
    return {
      ok: false,
      outcome: refuse(
        'target-not-found',
        `no start tag begins at offset ${String(target.start)} of ${file.path}`,
      ),
    };
  }
  const name = elementName(element.node);
  if (name === null || !names.includes(name)) {
    return {
      ok: false,
      outcome: refuse(
        'wrong-element',
        `expected ${names.map((n) => `<${n}>`).join(' or ')}, found <${name ?? 'Liquid name'}>`,
      ),
    };
  }
  return { ok: true, element };
}

/** The conventional name of the class that hides text visually but keeps it for screen readers. */
export const DEFAULT_VISUALLY_HIDDEN_CLASS = 'visually-hidden';

const CLASS_NAME = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/u;

/** Why the label or class cannot be used, or `null`. */
export function labelProblem(label: TranslationRequirement, className?: string): string | null {
  const keyProblem = translationKeyProblem(label.key);
  if (keyProblem !== null) return keyProblem;
  const textProblem = translationTextProblem(label.text);
  if (textProblem !== null) return `${label.key}: ${textProblem}`;
  if (className !== undefined && !CLASS_NAME.test(className)) {
    return `"${className}" is not a CSS class name`;
  }
  return null;
}
