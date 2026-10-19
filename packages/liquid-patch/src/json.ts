/**
 * Locating values in theme JSON (`config/settings_data.json`, `templates/*.json`, section
 * groups) by RFC 6901 JSON Pointer, with the offsets a span edit needs. Theme JSON may carry
 * comments (shopify.dev, theme architecture), so parsing is jsonc-parser's, which reports
 * offsets in UTF-16 code units like the Liquid parser (ADR-101).
 */
import { parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';

export interface JsonValue {
  /** Offset of the value's first code unit; for a string, its opening quote. */
  readonly start: number;
  /** Offset after the value's last code unit; for a string, after its closing quote. */
  readonly end: number;
  readonly type: JsonNode['type'];
  /** The parsed value for strings, numbers, booleans and null; `undefined` for containers. */
  readonly value: unknown;
}

/** A tree of the file, or `null` when it is not valid JSON (comments are allowed). */
export function parseJsonTree(source: string): JsonNode | null {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: false, disallowComments: false });
  return errors.length > 0 || tree === undefined ? null : tree;
}

/** The segments of a JSON Pointer; `null` when it is not one. `''` is the whole document. */
export function pointerSegments(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return null;
  const segments = pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  return segments;
}

/** A JSON Pointer for the segments, escaping `~` and `/`. */
export function toPointer(segments: readonly string[]): string {
  return segments.map((s) => `/${s.replace(/~/gu, '~0').replace(/\//gu, '~1')}`).join('');
}

function child(node: JsonNode, segment: string): JsonNode | undefined {
  if (node.type === 'array') {
    if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
    return node.children?.[Number(segment)];
  }
  if (node.type !== 'object') return undefined;
  const property = node.children?.find((p) => p.children?.[0]?.value === segment);
  return property?.children?.[1];
}

function nodeAt(root: JsonNode, segments: readonly string[]): JsonNode | undefined {
  let node: JsonNode | undefined = root;
  for (const segment of segments) {
    if (node === undefined) return undefined;
    node = child(node, segment);
  }
  return node;
}

/** The value a pointer names, with its span; `null` when the file or the pointer is bad. */
export function locateJsonValue(source: string, pointer: string): JsonValue | null {
  const segments = pointerSegments(pointer);
  const tree = parseJsonTree(source);
  if (segments === null || tree === null) return null;
  const node = nodeAt(tree, segments);
  if (node === undefined) return null;
  const container = node.type === 'object' || node.type === 'array';
  return {
    start: node.offset,
    end: node.offset + node.length,
    type: node.type,
    value: container ? undefined : (node.value as unknown),
  };
}
