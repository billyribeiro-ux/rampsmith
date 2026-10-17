import { expect } from 'vitest';
import { applyEdits, mapOffset, type Edit } from '../src/edits.ts';
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

/** Every code unit outside the edited spans is in the result, where mapOffset says. */
export function expectBytesKept(source: string, edits: readonly Edit[], after: string): void {
  let kept = 0;
  for (let i = 0; i < source.length; i += 1) {
    const at = mapOffset(i, edits);
    if (at === null) continue;
    if (after[at] !== source[i]) {
      throw new Error(
        `code unit ${String(i)} of the source is not at ${String(at)} after patching`,
      );
    }
    kept += 1;
  }
  const replaced = edits.reduce((sum, e) => sum + (e.end - e.start), 0);
  expect(kept).toBe(source.length - replaced);
}

/**
 * Runs a recipe, applies its edits (checking every other byte is kept), then runs it again on
 * its own output at the element's new offset: the second run must say `already-fixed`.
 * Returns the patched source.
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
  expectBytesKept(source, first.edits, after);
  const moved = mapOffset(start, first.edits);
  expect(moved).not.toBeNull();
  const second = run(recipe, path, after, moved ?? -1, params);
  expect(second.kind, JSON.stringify(second)).toBe('already-fixed');
  return after;
}
