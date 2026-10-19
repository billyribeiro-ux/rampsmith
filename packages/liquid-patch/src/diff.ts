/**
 * Unified diffs through `diff` 9.0.0 (jsdiff, BSD-3-Clause), whose `createTwoFilesPatch` emits
 * the GNU unified format that `git apply` and `patch -p1` read
 * (https://github.com/kpdecker/jsdiff#readme). The output is a pure function of its inputs.
 */
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';

/** Lines of unchanged context around each change, as in `git diff`. */
const CONTEXT_LINES = 3;

/**
 * One file's unified diff with `a/` and `b/` path prefixes and no timestamps, so `git apply`
 * applies it from the theme root. Empty when nothing changed.
 */
export function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return '';
  return createTwoFilesPatch(`a/${file}`, `b/${file}`, before, after, undefined, undefined, {
    context: CONTEXT_LINES,
    headerOptions: FILE_HEADERS_ONLY,
  });
}
