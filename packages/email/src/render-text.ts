/**
 * The plain-text version (ADR-192): the same content as the HTML, wrapped at 76 columns on
 * spaces, with every link on a line of its own so no client breaks it.
 */
import { plain, type Block, type EmailDocument, type Rich } from './document.ts';
import { graphemeLength } from './sanitize.ts';

export const TEXT_WIDTH = 76;

/** Wraps on spaces; a word longer than the width (a link) stays whole on its own line. */
export function wrap(text: string, width: number, indent = '', firstIndent = indent): string {
  const lines: string[] = [];
  let line = firstIndent;
  let lineHasWord = false;
  for (const word of text.split(' ').filter((w) => w.length > 0)) {
    const candidate = lineHasWord ? `${line} ${word}` : `${line}${word}`;
    if (lineHasWord && graphemeLength(candidate) > width) {
      lines.push(line);
      line = `${indent}${word}`;
    } else {
      line = candidate;
    }
    lineHasWord = true;
  }
  lines.push(line);
  return lines.join('\n');
}

/** Rich text as plain text; a link whose text is not its address gets the address appended. */
function richText(content: Rich): string {
  return content
    .map((part) => {
      if (part.href === undefined) {
        return part.text;
      }
      const address = part.href.startsWith('mailto:')
        ? part.href.slice('mailto:'.length)
        : part.href;
      return part.text === address ? part.text : `${part.text} (${address})`;
    })
    .join('');
}

function underline(text: string, char: string): string {
  return `${text}\n${char.repeat(Math.max(3, Math.min(graphemeLength(text), TEXT_WIDTH)))}`;
}

function block(b: Block): string {
  switch (b.type) {
    case 'paragraph':
      return wrap(richText(b.content), TEXT_WIDTH);
    case 'heading':
      return underline(richText(b.content), '-');
    case 'list':
      return b.items.map((item) => wrap(richText(item), TEXT_WIDTH, '  ', '- ')).join('\n');
    case 'facts':
      return b.rows
        .map((row) => wrap(`${plain(row.label)}: ${richText(row.value)}`, TEXT_WIDTH, '  ', ''))
        .join('\n');
    case 'action':
      return `${b.label}:\n${b.href}`;
    case 'code':
      return `${wrap(richText(b.label), TEXT_WIDTH)}\n\n    ${b.code}`;
    case 'note':
      return b.paragraphs.map((p) => wrap(richText(p), TEXT_WIDTH, '| ', '| ')).join('\n|\n');
    case 'prose':
      return b.text
        .split(/\n{2,}/u)
        .map((paragraph) =>
          paragraph
            .split('\n')
            .map((line) => wrap(line, TEXT_WIDTH))
            .join('\n'),
        )
        .join('\n\n');
  }
}

/** Renders a document to the text/plain part. */
export function renderText(doc: EmailDocument): string {
  const footer = [
    wrap(richText(doc.footer.reason), TEXT_WIDTH),
    ...doc.footer.links.map((link) => `${link.label}:\n${link.href}`),
    wrap(richText(doc.footer.support), TEXT_WIDTH),
    ...(doc.footer.sender === null ? [] : [doc.footer.sender.join('\n')]),
  ];
  const sections = [
    doc.brand,
    underline(doc.title, '='),
    ...doc.blocks.map(block),
    '_'.repeat(TEXT_WIDTH),
    ...footer,
  ];
  return `${sections.join('\n\n')}\n`;
}
