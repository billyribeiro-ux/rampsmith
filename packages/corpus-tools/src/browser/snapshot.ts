// A page's DOM before and after patching (ADR-247, "render outside the patched span"): every
// patch the engine makes only adds to the page. Recipes add an attribute, fill a blank one, or
// insert an element or text; a colour fix changes CSS, which lives in `style` attributes and
// `<style>` text. So the page after patching must contain every element of the page before, in
// the same order, with every attribute it had (a blank value may be filled), and the text it had.
// This is stricter than the contract's axe-core counts (CONTRACT.md, "Render regressions"):
// it catches markup swallowed, moved or rewritten that no rule happens to see.

/** One element of a page in document order; scripts are left out. */
export interface SnapshotNode {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** Text nodes directly inside the element, whitespace collapsed and trimmed. */
  readonly text: string;
}

export interface AdditiveCheck {
  /** Elements, attributes or text of the page before that the page after does not keep. */
  readonly violations: readonly string[];
  /** Elements the page after has and the page before did not. */
  readonly added: readonly SnapshotNode[];
}

/** Attributes whose value is CSS: a colour fix may rewrite them. */
const CSS_ATTRIBUTES: ReadonlySet<string> = new Set(['style']);
/** Elements whose text is CSS. */
const CSS_ELEMENTS: ReadonlySet<string> = new Set(['style']);

/**
 * What identifies an element when attributes are added or filled: its tag and classes. An `id`
 * is not part of it, since a recipe may give a form control one.
 */
function keyOf(node: SnapshotNode): string {
  const classes = (node.attributes['class'] ?? '').trim().replace(/\s+/gu, ' ');
  return `${node.tag}.${classes}`;
}

/** Index pairs of a longest common subsequence of two key lists. */
function align(before: readonly string[], after: readonly string[]): [number, number][] {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const down = table[(i + 1) * width + j] ?? 0;
      const right = table[i * width + j + 1] ?? 0;
      table[i * width + j] =
        before[i] === after[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(down, right);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function describe(node: SnapshotNode, index: number): string {
  const id = node.attributes['id'];
  const cls = node.attributes['class'];
  return `<${node.tag}${id === undefined ? '' : ` id="${id}"`}${cls === undefined ? '' : ` class="${cls}"`}> (element ${String(index)})`;
}

/** Whether the page after patching only adds to the page before. */
export function additiveChanges(
  before: readonly SnapshotNode[],
  after: readonly SnapshotNode[],
): AdditiveCheck {
  const pairs = align(before.map(keyOf), after.map(keyOf));
  const violations: string[] = [];
  const matchedBefore = new Set(pairs.map(([i]) => i));
  const matchedAfter = new Set(pairs.map(([, j]) => j));
  before.forEach((node, i) => {
    if (!matchedBefore.has(i)) violations.push(`${describe(node, i)} is gone`);
  });
  for (const [i, j] of pairs) {
    const was = before[i];
    const now = after[j];
    if (was === undefined || now === undefined) continue;
    for (const [name, value] of Object.entries(was.attributes)) {
      if (value.trim() === '' || CSS_ATTRIBUTES.has(name)) continue;
      const next = now.attributes[name];
      if (next !== value) {
        violations.push(
          `${describe(was, i)}: ${name} was "${value}", is ${next === undefined ? 'gone' : `"${next}"`}`,
        );
      }
    }
    if (!CSS_ELEMENTS.has(was.tag) && !now.text.includes(was.text)) {
      violations.push(`${describe(was, i)}: its text "${was.text}" is now "${now.text}"`);
    }
  }
  return { violations, added: after.filter((_, j) => !matchedAfter.has(j)) };
}
