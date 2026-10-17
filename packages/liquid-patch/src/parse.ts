/**
 * Parsing Liquid theme files with `@shopify/liquid-html-parser` 2.10.2 (MIT).
 *
 * Every node carries `position: { start, end }`: a half-open range of JavaScript string
 * indexes (UTF-16 code units) into the source, documented in the package's `dist/types.d.ts`
 * ("0-indexed offset in the string, included" / "excluded") and produced by its tokenizer,
 * which walks `source[i]` up to `source.length`
 * (https://github.com/Shopify/theme-tools/tree/main/packages/liquid-html-parser).
 * Edits in this package use the same unit (ADR-101).
 */
import {
  LiquidHTMLASTParsingError,
  NamedTags,
  NodeTypes,
  toLiquidHtmlAST,
  walk,
  type DocumentNode,
} from '@shopify/liquid-html-parser';

export interface LineColumn {
  /** 1-based line. */
  readonly line: number;
  /** 1-based column, counted in UTF-16 code units as the parser reports it. */
  readonly column: number;
}

export interface ParseFailure {
  readonly message: string;
  /** Where the parser stopped, when it says; `null` otherwise. */
  readonly start: LineColumn | null;
  readonly end: LineColumn | null;
}

export type ParseResult =
  | { readonly ok: true; readonly ast: DocumentNode }
  | { readonly ok: false; readonly error: ParseFailure };

/** A theme file that parsed: its theme-relative path, its contents and its AST. */
export interface ParsedFile {
  /** Theme-relative path with forward slashes, such as `layout/theme.liquid`. */
  readonly path: string;
  readonly source: string;
  readonly ast: DocumentNode;
}

export type ParsedFileResult =
  | { readonly ok: true; readonly file: ParsedFile }
  | { readonly ok: false; readonly error: ParseFailure };

/**
 * Parses Liquid and HTML into the parser's AST. The parser's default entry point is used, so
 * an unclosed element or tag is an error, while Liquid markup it cannot read is kept as a
 * string (see {@link countUnparsedLiquid}).
 */
export function parseLiquid(source: string): ParseResult {
  try {
    return { ok: true, ast: toLiquidHtmlAST(source) };
  } catch (error: unknown) {
    return { ok: false, error: toParseFailure(error) };
  }
}

export function parseThemeFile(path: string, source: string): ParsedFileResult {
  const result = parseLiquid(source);
  return result.ok ? { ok: true, file: { path, source, ast: result.ast } } : result;
}

function toParseFailure(error: unknown): ParseFailure {
  if (error instanceof LiquidHTMLASTParsingError) {
    return {
      message: firstLine(error.message),
      start: error.loc ? { ...error.loc.start } : null,
      end: error.loc ? { ...error.loc.end } : null,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message: firstLine(message), start: null, end: null };
}

function firstLine(message: string): string {
  const newline = message.indexOf('\n');
  return newline === -1 ? message : message.slice(0, newline);
}

const STRICT_TAGS: ReadonlySet<string> = new Set(Object.values(NamedTags));

/**
 * Counts Liquid the parser could not read strictly: output tags (`{{ }}`) whose markup stayed a
 * string, and built-in tags (`if`, `render`, `when`, ...) whose markup stayed a string. Unknown
 * and raw tags always keep string markup, so they are not counted. A patch must never raise
 * this number (ADR-101).
 */
export function countUnparsedLiquid(ast: DocumentNode): number {
  let count = 0;
  walk(ast, (node) => {
    if (node.type === NodeTypes.LiquidVariableOutput && typeof node.markup === 'string') {
      count += 1;
    } else if (
      (node.type === NodeTypes.LiquidTag || node.type === NodeTypes.LiquidBranch) &&
      node.name !== null &&
      STRICT_TAGS.has(node.name) &&
      typeof node.markup === 'string'
    ) {
      count += 1;
    }
  });
  return count;
}
