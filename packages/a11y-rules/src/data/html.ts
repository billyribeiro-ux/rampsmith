// Parsing of untrusted rich text by the WHATWG HTML algorithm, bounded in size, depth,
// element count and time.
//
// parse5 implements the WHATWG tree-construction algorithm and never executes scripts. Its
// scope checks walk the stack of open elements, so deeply nested input costs time quadratic in
// the depth (200,000 nested <div>s took 287 s in a local measurement, ADR-111). A wrapping tree
// adapter refuses any insertion deeper than `maxDepth`, which bounds that stack, and checks a
// time budget as elements and text arrive. Failures are typed results, never exceptions.
import {
  defaultTreeAdapter,
  parseFragment,
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  type TreeAdapter,
} from 'parse5';

type ParsedFragment = DefaultTreeAdapterTypes.DocumentFragment;
export type HtmlElement = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Template = DefaultTreeAdapterTypes.Template;

export interface ParseLimits {
  /** Longest accepted input, in UTF-16 code units. */
  readonly maxLength: number;
  /** Deepest accepted element nesting. */
  readonly maxDepth: number;
  /** Most elements accepted in one input. */
  readonly maxElements: number;
  /** Wall-clock budget for parsing one input, a backstop for inputs the other limits miss. */
  readonly timeBudgetMs: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxLength: 1_000_000,
  maxDepth: 512,
  maxElements: 100_000,
  timeBudgetMs: 3_000,
};

/** Why an input was not audited. */
export type ParseFailure =
  'too_large' | 'too_deep' | 'too_many_elements' | 'time_limit' | 'parser_error';

export type ParseResult =
  | { readonly ok: true; readonly fragment: ParsedFragment }
  | { readonly ok: false; readonly reason: ParseFailure };

class LimitExceeded extends Error {
  readonly reason: ParseFailure;

  constructor(reason: ParseFailure) {
    super(reason);
    this.name = 'LimitExceeded';
    this.reason = reason;
  }
}

/** How often, in adapter calls, the clock is read. */
const CLOCK_EVERY = 256;

/**
 * Parses `html` as a fragment in the `<body>` context, with source offsets on every element.
 * `clock` returns milliseconds; tests inject one to prove the time budget.
 */
export function parseRichText(
  html: string,
  limits: ParseLimits = DEFAULT_PARSE_LIMITS,
  clock: () => number = () => performance.now(),
): ParseResult {
  if (html.length > limits.maxLength) return { ok: false, reason: 'too_large' };

  const deadline = clock() + limits.timeBudgetMs;
  const templateOwner = new WeakMap<ParentNode, Template>();
  let elements = 0;
  let calls = 0;

  const tick = (): void => {
    calls += 1;
    if (calls % CLOCK_EVERY === 0 && clock() > deadline) throw new LimitExceeded('time_limit');
  };

  // Depth of the node a child is being inserted into, counted by walking up at most
  // `maxDepth + 1` ancestors, so each insertion costs O(maxDepth) whatever the input.
  // Template contents are linked back to their template so nesting inside <template> counts.
  const depthOf = (parent: ParentNode): number => {
    let depth = 0;
    let node: ParentNode | null = parent;
    while (node !== null) {
      if (node.nodeName === '#document-fragment' || node.nodeName === '#document') {
        const owner = templateOwner.get(node);
        if (owner === undefined) break;
        node = owner;
        continue;
      }
      depth += 1;
      if (depth > limits.maxDepth) break;
      node = 'parentNode' in node ? node.parentNode : null;
    }
    return depth;
  };

  const guardInsert = (parent: ParentNode, child: ChildNode): void => {
    tick();
    if (child.nodeName.startsWith('#')) return;
    if (depthOf(parent) + 1 > limits.maxDepth) throw new LimitExceeded('too_deep');
  };

  const adapter: TreeAdapter<DefaultTreeAdapterMap> = {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      tick();
      elements += 1;
      if (elements > limits.maxElements) throw new LimitExceeded('too_many_elements');
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    appendChild(parent, child) {
      guardInsert(parent, child);
      defaultTreeAdapter.appendChild(parent, child);
    },
    insertBefore(parent, child, reference) {
      guardInsert(parent, child);
      defaultTreeAdapter.insertBefore(parent, child, reference);
    },
    insertText(parent, text) {
      tick();
      defaultTreeAdapter.insertText(parent, text);
    },
    insertTextBefore(parent, text, reference) {
      tick();
      defaultTreeAdapter.insertTextBefore(parent, text, reference);
    },
    setTemplateContent(template, content) {
      templateOwner.set(content, template);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
  };

  try {
    const fragment = parseFragment(html, { sourceCodeLocationInfo: true, treeAdapter: adapter });
    return { ok: true, fragment };
  } catch (error: unknown) {
    if (error instanceof LimitExceeded) return { ok: false, reason: error.reason };
    // parse5 recovers from every syntax error by design; anything else is a defect, reported
    // as a typed result so one bad field never stops an audit.
    return { ok: false, reason: 'parser_error' };
  }
}

/** The value of attribute `name` on `element`, or `undefined` when absent. */
export function attr(element: HtmlElement, name: string): string | undefined {
  for (const a of element.attrs) {
    if (a.name === name && a.prefix === undefined) return a.value;
  }
  return undefined;
}

/** Child nodes of an element, or none for a template (its content is not rendered). */
export function renderedChildren(node: ParentNode): readonly ChildNode[] {
  return node.nodeName === 'template' ? [] : node.childNodes;
}
