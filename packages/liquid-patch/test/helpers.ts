import { expect } from 'vitest';
import { applyEdits, mapOffset } from '../src/edits.ts';
import { parseThemeFile, type ParsedFile } from '../src/parse.ts';
import type { Recipe, RecipeOutcome } from '../src/recipes/types.ts';

export function parsed(path: string, source: string): ParsedFile {
  const result = parseThemeFile(path, source);
  if (!result.ok) throw new Error(`${path}: ${result.error.message}`);
  return result.file;
}

/** Offset of the only occurrence of `marker` in `source`. */
export function startOf(source: string, marker: string): number {
  const at = source.indexOf(marker);
  if (at === -1 || source.includes(marker, at + 1)) {
    throw new Error(`"${marker}" must occur exactly once`);
  }
  return at;
}

export function run<P>(
  recipe: Recipe<P>,
  path: string,
  source: string,
  start: number,
  params: P,
): RecipeOutcome {
  return recipe.run(parsed(path, source), { file: path, start }, params);
}

/** Applies an `edits` outcome through the re-parse gate and returns the patched source. */
export function patched(source: string, outcome: RecipeOutcome): string {
  if (outcome.kind !== 'edits') throw new Error(`expected edits, got ${JSON.stringify(outcome)}`);
  const result = applyEdits(source, outcome.edits);
  if (!result.ok) throw new Error(result.error.message);
  return result.contents;
}

/**
 * Runs a recipe, applies its edits, then runs it again on its own output at the element's new
 * offset: the second run must say `already-fixed`. Returns the patched source.
 */
export function fixTwice<P>(
  recipe: Recipe<P>,
  path: string,
  source: string,
  start: number,
  params: P,
): string {
  const first = run(recipe, path, source, start, params);
  const after = patched(source, first);
  if (first.kind !== 'edits') throw new Error('unreachable');
  const moved = mapOffset(start, first.edits);
  expect(moved).not.toBeNull();
  const second = run(recipe, path, after, moved ?? -1, params);
  expect(second.kind, JSON.stringify(second)).toBe('already-fixed');
  return after;
}
