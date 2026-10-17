import { describe, expect, it } from 'vitest';
import {
  elementAt,
  elementName,
  findAttribute,
  firstElement,
  insertAttribute,
  rawValue,
  staticValue,
} from '../src/html.ts';
import { parsed } from './helpers.ts';

describe('element helpers', () => {
  const file = parsed(
    'layout/theme.liquid',
    '<html><head></head><BODY class="a"><x-{{ n }}></x-{{ n }}><main id="{{ id }}"></main></BODY></html>',
  );

  it('find the first element by name, case-insensitively', () => {
    expect(firstElement(file.ast, 'body')?.node.blockStartPosition.start).toBe(19);
    expect(firstElement(file.ast, 'aside')).toBeNull();
  });

  it('give no name for a tag name built with Liquid', () => {
    const custom = elementAt(file.ast, file.source.indexOf('<x-'));
    expect(custom).not.toBeNull();
    expect(custom === null ? 'x' : elementName(custom.node)).toBeNull();
  });

  it('read static and Liquid attribute values', () => {
    const body = firstElement(file.ast, 'body');
    const main = firstElement(file.ast, 'main');
    if (body === null || main === null) throw new Error('missing elements');
    const cls = findAttribute(body.node, 'class');
    const id = findAttribute(main.node, 'id');
    if (cls === null || id === null) throw new Error('missing attributes');
    expect(staticValue(cls.attr)).toBe('a');
    expect(staticValue(id.attr)).toBeNull();
    expect(rawValue(file, id.attr)).toBe('{{ id }}');
  });

  it('find an attribute nested in Liquid tags and mark it conditional', () => {
    const source = '<a {% if a %}{% unless b %}title="t"{% endunless %}{% endif %}></a>';
    const link = elementAt(parsed('snippets/a.liquid', source).ast, 0);
    if (link === null) throw new Error('missing link');
    expect(findAttribute(link.node, 'title')).toMatchObject({ conditional: true });
    expect(findAttribute(link.node, 'href')).toBeNull();
  });

  it('insert an attribute after the tag name when there are none, keeping CRLF separators', () => {
    const bare = parsed('snippets/a.liquid', '<img>');
    const img = elementAt(bare.ast, 0);
    if (img === null) throw new Error('missing img');
    expect(insertAttribute(bare, img.node, 'alt=""')).toEqual({
      file: 'snippets/a.liquid',
      start: 4,
      end: 4,
      replacement: ' alt=""',
    });
    const crlf = parsed('snippets/a.liquid', '<img\r\n  src="a.png"\r\n>');
    const second = elementAt(crlf.ast, 0);
    if (second === null) throw new Error('missing img');
    expect(insertAttribute(crlf, second.node, 'alt=""').replacement).toBe('\r\n  alt=""');
  });
});
