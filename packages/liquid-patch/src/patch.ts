/**
 * Turns edits across several theme files into patched contents plus one unified diff per file
 * (PLAN §12 "Output").
 */
import { unifiedDiff } from './diff.ts';
import { applyEdits, type Edit, type EditError } from './edits.ts';

export interface FilePatch {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  /** Unified diff from `before` to `after`, with `a/` and `b/` prefixes. */
  readonly diff: string;
}

export interface PatchError {
  readonly file: string;
  readonly code: EditError['code'] | 'missing-file';
  readonly message: string;
}

export type PatchResult =
  | { readonly ok: true; readonly patches: readonly FilePatch[] }
  | { readonly ok: false; readonly error: PatchError };

/** Code-unit order: the same on every machine and locale. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Applies every edit to its file in `files` (theme-relative path to contents). Each file's
 * edits are checked together by {@link applyEdits}, so the whole patch fails on the first bad
 * file. Files whose contents end up unchanged are left out; the rest are sorted by path, so
 * the same input always produces the same output.
 */
export function buildPatch(
  files: ReadonlyMap<string, string>,
  edits: readonly Edit[],
): PatchResult {
  const byFile = new Map<string, Edit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.file);
    if (list === undefined) byFile.set(edit.file, [edit]);
    else list.push(edit);
  }
  const patches: FilePatch[] = [];
  for (const file of [...byFile.keys()].sort(compareStrings)) {
    const before = files.get(file);
    if (before === undefined) {
      return {
        ok: false,
        error: { file, code: 'missing-file', message: `${file} was not provided` },
      };
    }
    const result = applyEdits(before, byFile.get(file) ?? []);
    if (!result.ok) return { ok: false, error: { file, ...result.error } };
    if (result.contents !== before) {
      patches.push({
        file,
        before,
        after: result.contents,
        diff: unifiedDiff(file, before, result.contents),
      });
    }
  }
  return { ok: true, patches };
}
