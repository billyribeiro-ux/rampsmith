import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, type Block, type Inline } from './markdown.ts';

const text = (value: string): Inline => ({ kind: 'text', text: value });

describe('parseInline', () => {
  it('reads code, bold, emphasis and links', () => {
    expect(parseInline('a `b` **c** *d* [e](https://x.test/)')).toEqual([
      text('a '),
      { kind: 'code', text: 'b' },
      text(' '),
      { kind: 'strong', children: [text('c')] },
      text(' '),
      { kind: 'em', children: [text('d')] },
      text(' '),
      { kind: 'link', href: 'https://x.test/', children: [text('e')] },
    ]);
  });

  it('keeps markup characters inside code as plain text', () => {
    expect(parseInline('`**x**`')).toEqual([{ kind: 'code', text: '**x**' }]);
  });

  it('never turns a script or data address into a link', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([text('x')]);
    expect(parseInline('[x](data:text/html,hi)')).toEqual([text('x')]);
  });

  it('leaves unmatched markers as text', () => {
    expect(parseInline('2 * 3 and **open')).toEqual([text('2 * 3 and **open')]);
  });

  it('does not interpret HTML', () => {
    expect(parseInline('<b>x</b>')).toEqual([text('<b>x</b>')]);
  });
});

describe('parseMarkdown', () => {
  it('reads headings with unique ids', () => {
    expect(parseMarkdown('# Title\n\n## Part\n\n## Part\n')).toEqual([
      { kind: 'heading', level: 1, id: 'title', children: [text('Title')] },
      { kind: 'heading', level: 2, id: 'part', children: [text('Part')] },
      { kind: 'heading', level: 2, id: 'part-2', children: [text('Part')] },
    ]);
  });

  it('joins the lines of a paragraph', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { kind: 'paragraph', children: [text('one two')] },
      { kind: 'paragraph', children: [text('three')] },
    ]);
  });

  it('reads bullet and numbered lists with wrapped lines', () => {
    expect(parseMarkdown('- a\n  more\n- b\n\n1. x\n2. y')).toEqual([
      { kind: 'list', ordered: false, items: [[text('a more')], [text('b')]] },
      { kind: 'list', ordered: true, items: [[text('x')], [text('y')]] },
    ]);
  });

  it('reads a table with a header row', () => {
    expect(parseMarkdown('| A | B |\n| --- | --- |\n| 1 | `2` |\n')).toEqual([
      {
        kind: 'table',
        header: [[text('A')], [text('B')]],
        rows: [[[text('1')], [{ kind: 'code', text: '2' }]]],
      },
    ] satisfies Block[]);
  });

  it('reads a rule', () => {
    expect(parseMarkdown('a\n\n---\n\nb')[1]).toEqual({ kind: 'rule' });
  });

  it.each([
    'legal/privacy-policy.md',
    'legal/terms-of-service.md',
    'legal/data-processing-addendum.md',
    'accessibility-statement.md',
  ])('parses the real document docs/%s without leaving Markdown behind', (file) => {
    const source = readFileSync(new URL(`../../../../../docs/${file}`, import.meta.url), 'utf8');
    const blocks = parseMarkdown(source);
    expect(blocks.filter((b) => b.kind === 'heading' && b.level === 1)).toHaveLength(1);
    const flat = JSON.stringify(blocks);
    // No unparsed table rows, list markers or heading hashes in text.
    expect(flat).not.toMatch(/"text":"\| /u);
    expect(flat).not.toMatch(/"text":"#+ /u);
    expect(flat).not.toMatch(/"text":"- /u);
  });
});
