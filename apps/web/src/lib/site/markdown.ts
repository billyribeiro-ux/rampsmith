/**
 * A small Markdown reader for the drafts in `docs/` that the site shows: headings, paragraphs,
 * bullet and numbered lists, tables, rules, and inline code, bold, emphasis and links.
 *
 * It returns data, not HTML. Svelte renders the data as elements, so no `{@html}` is needed
 * (PLAN §8 bans it) and raw HTML in a source file is shown as text, never run. Links are kept
 * only for `https:`, `http:`, `mailto:` and in-page addresses.
 */

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly Inline[] }
  | { readonly kind: 'em'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly Inline[] };

export type Block =
  | {
      readonly kind: 'heading';
      readonly level: 1 | 2 | 3 | 4;
      readonly id: string;
      readonly children: readonly Inline[];
    }
  | { readonly kind: 'paragraph'; readonly children: readonly Inline[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: readonly (readonly Inline[])[];
    }
  | {
      readonly kind: 'table';
      readonly header: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    }
  | { readonly kind: 'rule' };

const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\/)/iu;

function pushText(out: Inline[], value: string): void {
  if (value === '') return;
  const last = out[out.length - 1];
  if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + value };
  else out.push({ kind: 'text', text: value });
}

/** Finds the index of `close` after `from`, or -1. */
function findClose(source: string, close: string, from: number): number {
  return source.indexOf(close, from);
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const ch = source.charAt(i);

    if (ch === '`') {
      const end = findClose(source, '`', i + 1);
      if (end > i + 1) {
        out.push({ kind: 'code', text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith('**')) {
      const end = findClose(source, '**', i + 2);
      if (end > i + 2) {
        out.push({ kind: 'strong', children: parseInline(source.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' && !/^\*\s/u.test(rest)) {
      const end = findClose(source, '*', i + 1);
      if (end > i + 1 && !/\s/u.test(source.charAt(end - 1))) {
        out.push({ kind: 'em', children: parseInline(source.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const link = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/u.exec(rest);
      if (link !== null) {
        const [whole = '', label = '', href = ''] = link;
        if (SAFE_HREF.test(href)) {
          out.push({ kind: 'link', href, children: parseInline(label) });
        } else {
          out.push(...parseInline(label));
        }
        i += whole.length;
        continue;
      }
    }
    pushText(out, ch);
    i += 1;
  }
  return out;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug === '' ? 'section' : slug;
}

export function plain(inlines: readonly Inline[]): string {
  return inlines
    .map((node) =>
      node.kind === 'text' || node.kind === 'code' ? node.text : plain(node.children),
    )
    .join('');
}

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/u;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const BULLET = /^[-*]\s+(.*)$/u;
const NUMBERED = /^\d+[.)]\s+(.*)$/u;
const TABLE_ROW = /^\|.*\|\s*$/u;
const TABLE_DIVIDER = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/u;

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  const parts: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner.charAt(i);
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && inner.charAt(i + 1) === '|') {
      current += '|';
      i += 1;
    } else if (ch === '|' && !inCode) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: Block[] = [];
  const used = new Map<string, number>();
  const idFor = (title: string): string => {
    const base = slugify(title);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}-${count.toString()}`;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const [, hashes = '#', title = ''] = heading;
      const children = parseInline(title);
      blocks.push({
        kind: 'heading',
        level: hashes.length as 1 | 2 | 3 | 4,
        id: idFor(plain(children)),
        children,
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_DIVIDER.test(lines[i + 1] ?? '')) {
      const header = cells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) {
        rows.push(cells(lines[i] ?? '').map(parseInline));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet !== null || numbered !== null) {
      const ordered = numbered !== null && bullet === null;
      const marker = ordered ? NUMBERED : BULLET;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const match = marker.exec(current);
        if (match === null) break;
        let item = match[1] ?? '';
        i += 1;
        // Indented lines continue the item.
        while (i < lines.length && /^\s+\S/u.test(lines[i] ?? '')) {
          item += ` ${(lines[i] ?? '').trim()}`;
          i += 1;
        }
        items.push(parseInline(item));
        // One blank line may sit between items of the same list.
        if ((lines[i] ?? '').trim() === '' && marker.test(lines[i + 1] ?? '')) i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (
        current.trim() === '' ||
        HEADING.test(current) ||
        RULE.test(current) ||
        BULLET.test(current) ||
        NUMBERED.test(current) ||
        (TABLE_ROW.test(current) && TABLE_DIVIDER.test(lines[i + 1] ?? ''))
      ) {
        break;
      }
      paragraph.push(current.trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) });
  }
  return blocks;
}
