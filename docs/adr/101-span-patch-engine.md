# ADR-101: Span patch engine: offsets, overlap rule, re-parse gate and diffs

- Status: Accepted
- Date: 2026-10-17
- Stream: WS-1 (`packages/liquid-patch`), refining ADR-007

## Context

ADR-007 says code fixes are `{file, start, end, replacement}` edits computed from
`@shopify/liquid-html-parser` positions, applied from the end backwards, and that files are
never reformatted. PLAN §12 adds: overlapping edits are rejected, the result must re-parse,
and the output is patched files plus one unified diff per file. Four details were left open:
the offset unit, the overlap rule, what "re-parses" means, and where diffs come from.

Evidence, read on 2026-10-17:

- `npm view @shopify/liquid-html-parser@2.10.2`: MIT, one dependency (`line-column`), no peers.
  Its `dist/types.d.ts` defines `Position { start: number /* 0-indexed offset in the string,
  included */; end: number /* excluded */ }`, and `dist/document/tokenizer.js` walks
  `source[i]` up to `source.length`. Offsets are therefore JavaScript string indexes, that is
  UTF-16 code units, not bytes. Verified by test: after an emoji (two code units) the next
  element starts at index 5, not byte 7 (`test/parse.test.ts`).
- The default entry point `toLiquidHtmlAST` throws `LiquidHTMLASTParsingError` (with a 1-based
  `loc`) on unclosed or mismatched elements and tags, but keeps Liquid markup it cannot read as
  a string (`{{ x | | }}`, `{% render %}`) instead of failing. Probed in a scratch project.
- `npm view diff@9.0.0`: BSD-3-Clause (on the project allowlist in `deny.toml`), no runtime
  dependencies, released 2026-04-13, ships TypeScript types. `createTwoFilesPatch` with
  `headerOptions: FILE_HEADERS_ONLY` emits `--- a/x` / `+++ b/x` headers and standard hunks.
- `npm view jsonc-parser@3.3.1`: MIT, no dependencies; already in the tree through
  `@shopify/theme-check-common`. Used to validate JSON theme files, which may carry comments.

## Decision

1. **Offsets** are UTF-16 code-unit indexes into the file's contents decoded from UTF-8, the
   parser's own unit; spans are half-open `[start, end)`; `start === end` is an insertion.
   An offset may not split a surrogate pair, and a replacement may not contain a lone
   surrogate, so a patched file always encodes back to valid UTF-8.
2. **Overlap rule.** Edits are sorted by `(start, end)`. An edit may start where the previous
   one ends, never before it. An insertion at the start of a replaced span lands before the
   replacement; one at its end lands after it. **Two insertions at the same offset are
   rejected** as overlapping, because their order would be a guess: the producer combines them
   into one edit. Identical duplicate edits are rejected by the same rule.
3. **Application** (`spliceEdits`) validates, then applies from the highest start downwards;
   for an insertion and a replacement at one start, the replacement goes first so the
   insertion ends up before it. Every code unit outside the edited spans is kept; a fast-check
   property test proves it for arbitrary sources and edit sets (`test/edits.test.ts`).
4. **Re-parse gate** (`applyEdits`, for theme files): edits for one call share one `file`; a
   `.liquid` file must parse before and after with the parser's default entry point, and the
   count of strictly-unparsed Liquid (output whose markup stayed a string, and built-in tags
   such as `if` or `render` whose markup stayed a string) must not rise. A `.json` file must
   parse before and after as JSON with comments and no trailing commas. Other file types are
   refused (`unsupported-file`) until a recipe for them brings its own validator.
5. **Diffs** come from `diff` 9.0.0: one unified diff per changed file, `a/` and `b/` prefixes,
   3 lines of context, no timestamps; empty when nothing changed. `buildPatch` groups edits by
   file, applies each group through `applyEdits`, drops files left unchanged and sorts the rest
   by path in code-unit order, so the same input always gives the same output. Tests prove the
   exact format, stability, a round trip through jsdiff's `applyPatch`, and that CRLF line
   endings stay inside the hunk lines as `git diff` writes them (`test/patch.test.ts`).
6. `mapOffset(offset, edits)` reports where an original offset lands after the edits, or
   `null` when an edit replaced it, so callers can find an element again or chain recipes.

## Consequences

- Edits are portable between the parser, the edit model and JavaScript string APIs without
  conversion. Anything that reports byte offsets (for example a Rust consumer) must convert.
- A recipe that wants two insertions at one point writes one edit; the rule keeps output
  deterministic.
- The "no new unparsed Liquid" check makes the gate stricter than "it still parses": a patch
  cannot slip in Liquid that Shopify's parser would treat as an error, even though the
  tolerant parser accepts it.

## Rejected alternatives

- Byte offsets: the parser does not produce them, and converting twice invites off-by-one bugs.
- Keeping two insertions at one offset in input order: correct only if every producer agrees
  on order, which nothing enforces.
- Writing a diff algorithm here: jsdiff is small, dependency-free and widely used; the edits
  already say which lines change, but a hand-rolled hunk builder would need the same tests.
- Re-printing the AST: it is what ADR-007 forbids.
