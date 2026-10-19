/**
 * The HTML version (ADR-192). One column, no images, no remote resources, no scripts: the
 * email reads the same with images off and needs nothing from the network. Colours meet 4.5:1
 * for text in light and dark mode (`prefers-color-scheme`), every link is underlined except the
 * button, which keeps a border for forced-colour modes. Every string from a document passes
 * through `escapeHtml`; the only markup is what this file writes.
 */
import type { Block, EmailDocument, Inline, Rich } from './document.ts';
import { escapeHtml } from './sanitize.ts';

/** Trusted markup built by this module. */
interface Markup {
  readonly html: string;
}

const LIGHT = {
  page: '#f3f4f6',
  card: '#ffffff',
  border: '#d1d5db',
  text: '#111827',
  muted: '#4b5563',
  link: '#1d4ed8',
  buttonBackground: '#1d4ed8',
  buttonText: '#ffffff',
  subtle: '#f3f4f6',
  rule: '#6b7280',
} as const;

const DARK = {
  page: '#0b0f14',
  card: '#151b23',
  border: '#374151',
  text: '#f3f4f6',
  muted: '#b6c0cc',
  link: '#93c5fd',
  buttonBackground: '#93c5fd',
  buttonText: '#0b0f14',
  subtle: '#0b0f14',
  rule: '#9ca3af',
} as const;

/** Exported for the contrast test, which checks every pair below in both schemes. */
export const PALETTES = { light: LIGHT, dark: DARK } as const;

// Family names are left unquoted (valid CSS) so the attribute needs no escaped quotes.
const FONT = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,Liberation Mono,monospace';

const STYLE_SHEET = [
  ':root{color-scheme:light dark;supported-color-schemes:light dark;}',
  'body{margin:0;padding:0;}',
  '@media (prefers-color-scheme: dark){',
  `.rs-page{background-color:${DARK.page} !important;color:${DARK.text} !important;}`,
  `.rs-card{background-color:${DARK.card} !important;border-color:${DARK.border} !important;}`,
  `.rs-text{color:${DARK.text} !important;}`,
  `.rs-muted{color:${DARK.muted} !important;}`,
  `.rs-link{color:${DARK.link} !important;}`,
  `.rs-button{background-color:${DARK.buttonBackground} !important;border-color:${DARK.buttonBackground} !important;color:${DARK.buttonText} !important;}`,
  `.rs-subtle{background-color:${DARK.subtle} !important;border-color:${DARK.rule} !important;}`,
  `.rs-row{border-color:${DARK.border} !important;}`,
  '}',
  '@media (max-width: 480px){.rs-card{padding:24px 16px !important;}}',
].join('');

function markup(html: string): Markup {
  return { html };
}

type Child = Markup | string;

function join(children: readonly Child[]): string {
  return children.map((c) => (typeof c === 'string' ? escapeHtml(c) : c.html)).join('');
}

/** Builds an element. Attribute values and string children are escaped. */
function el(
  tag: string,
  attributes: Readonly<Record<string, string>>,
  ...children: Child[]
): Markup {
  const attrs = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('');
  return markup(`<${tag}${attrs}>${join(children)}</${tag}>`);
}

function style(rules: Readonly<Record<string, string>>): string {
  return Object.entries(rules)
    .map(([property, value]) => `${property}:${value}`)
    .join(';');
}

interface Layout {
  readonly start: 'left' | 'right';
  readonly end: 'left' | 'right';
}

function linkStyle(standalone: boolean): string {
  return style({
    color: LIGHT.link,
    'text-decoration': 'underline',
    ...(standalone ? { display: 'inline-block', padding: '4px 0' } : {}),
  });
}

function inline(content: Rich): Markup {
  return markup(
    content
      .map((part: Inline) => {
        const text =
          part.isolate === true ? el('bdi', {}, part.text) : markup(escapeHtml(part.text));
        if (part.href === undefined) {
          return text.html;
        }
        return el('a', { class: 'rs-link', href: part.href, style: linkStyle(false) }, text).html;
      })
      .join(''),
  );
}

const PARAGRAPH: Readonly<Record<string, string>> = {
  margin: '0 0 16px',
  'font-size': '16px',
  'line-height': '24px',
  color: LIGHT.text,
};

function paragraph(content: Child, extra: Readonly<Record<string, string>> = {}): Markup {
  return el('p', { class: 'rs-text', style: style({ ...PARAGRAPH, ...extra }) }, content);
}

function prose(text: string): Markup[] {
  return text.split(/\n{2,}/u).map((block) => {
    const lines = block.split('\n');
    const children: Child[] = [];
    lines.forEach((line, index) => {
      if (index > 0) {
        children.push(markup('<br>'));
      }
      children.push(line);
    });
    return paragraph(markup(join(children)));
  });
}

function block(b: Block, layout: Layout): Markup[] {
  switch (b.type) {
    case 'paragraph':
      return [paragraph(inline(b.content))];
    case 'heading':
      return [
        el(
          'h2',
          {
            class: 'rs-text',
            style: style({
              margin: '24px 0 8px',
              'font-size': '18px',
              'line-height': '26px',
              'font-weight': '700',
              color: LIGHT.text,
            }),
          },
          inline(b.content),
        ),
      ];
    case 'list':
      return [
        el(
          'ul',
          {
            class: 'rs-text',
            style: style({
              margin: '0 0 16px',
              padding: layout.start === 'left' ? '0 0 0 24px' : '0 24px 0 0',
              color: LIGHT.text,
              'font-size': '16px',
              'line-height': '24px',
            }),
          },
          ...b.items.map((item) => el('li', { style: style({ margin: '0 0 8px' }) }, inline(item))),
        ),
      ];
    case 'facts': {
      const cell = {
        padding: '8px 0',
        'border-bottom': `1px solid ${LIGHT.border}`,
        'vertical-align': 'top',
        'font-size': '16px',
        'line-height': '24px',
      };
      return [
        el(
          'table',
          {
            class: 'rs-text',
            style: style({
              width: '100%',
              'border-collapse': 'collapse',
              margin: '0 0 16px',
              color: LIGHT.text,
            }),
          },
          el(
            'tbody',
            {},
            ...b.rows.map((row) =>
              el(
                'tr',
                {},
                el(
                  'th',
                  {
                    scope: 'row',
                    class: 'rs-row',
                    style: style({
                      ...cell,
                      'text-align': layout.start,
                      'font-weight': '600',
                      [`padding-${layout.end}`]: '16px',
                    }),
                  },
                  inline(row.label),
                ),
                el(
                  'td',
                  { class: 'rs-row', style: style({ ...cell, 'text-align': layout.end }) },
                  inline(row.value),
                ),
              ),
            ),
          ),
        ),
      ];
    }
    case 'action': {
      const out = [
        el(
          'p',
          { style: style({ margin: '24px 0' }) },
          el(
            'a',
            {
              class: 'rs-button',
              href: b.href,
              style: style({
                display: 'inline-block',
                'background-color': LIGHT.buttonBackground,
                border: `2px solid ${LIGHT.buttonBackground}`,
                'border-radius': '6px',
                color: LIGHT.buttonText,
                'font-size': '16px',
                'font-weight': '600',
                'line-height': '24px',
                padding: '10px 20px',
                'text-decoration': 'none',
              }),
            },
            b.label,
          ),
        ),
      ];
      if (b.fallback !== null) {
        out.push(
          el(
            'p',
            {
              class: 'rs-muted',
              style: style({
                margin: '0 0 8px',
                'font-size': '14px',
                'line-height': '22px',
                color: LIGHT.muted,
              }),
            },
            inline(b.fallback),
          ),
          el(
            'p',
            {
              style: style({
                margin: '0 0 16px',
                'font-size': '14px',
                'line-height': '22px',
                'word-break': 'break-all',
                'overflow-wrap': 'anywhere',
              }),
            },
            el('a', { class: 'rs-link', href: b.href, style: linkStyle(false) }, b.href),
          ),
        );
      }
      return out;
    }
    case 'code':
      return [
        paragraph(inline(b.label), { margin: '0 0 8px', 'font-weight': '600' }),
        el(
          'p',
          {
            class: 'rs-text rs-subtle',
            style: style({
              margin: '0 0 16px',
              padding: '12px 16px',
              'background-color': LIGHT.subtle,
              border: `1px solid ${LIGHT.rule}`,
              'border-radius': '6px',
              color: LIGHT.text,
              'font-family': MONO,
              'font-size': '24px',
              'line-height': '32px',
              'letter-spacing': '0.12em',
              'word-break': 'break-all',
            }),
          },
          el('code', { style: style({ 'font-family': MONO }) }, b.code),
        ),
      ];
    case 'note':
      return [
        el(
          'div',
          {
            class: 'rs-subtle',
            style: style({
              margin: '24px 0 0',
              padding: '12px 16px 0',
              'background-color': LIGHT.subtle,
              [`border-${layout.start}`]: `4px solid ${LIGHT.rule}`,
            }),
          },
          ...b.paragraphs.map((p) =>
            paragraph(inline(p), {
              'font-size': '14px',
              'line-height': '22px',
              margin: '0 0 12px',
            }),
          ),
        ),
      ];
    case 'prose':
      return prose(b.text);
  }
}

function footer(doc: EmailDocument): Markup {
  const small = style({
    margin: '0 0 12px',
    'font-size': '14px',
    'line-height': '22px',
    color: LIGHT.muted,
  });
  const parts: Markup[] = [el('p', { class: 'rs-muted', style: small }, inline(doc.footer.reason))];
  for (const link of doc.footer.links) {
    parts.push(
      el(
        'p',
        { class: 'rs-muted', style: small },
        el('a', { class: 'rs-link', href: link.href, style: linkStyle(true) }, link.label),
      ),
    );
  }
  parts.push(el('p', { class: 'rs-muted', style: small }, inline(doc.footer.support)));
  if (doc.footer.sender !== null) {
    const lines: Child[] = [];
    doc.footer.sender.forEach((line, index) => {
      if (index > 0) {
        lines.push(markup('<br>'));
      }
      lines.push(line);
    });
    parts.push(el('p', { class: 'rs-muted', style: small }, ...lines));
  }
  return el('div', { style: style({ padding: '24px 8px 0' }) }, ...parts);
}

/** Renders a document to a complete HTML email. */
export function renderHtml(doc: EmailDocument): string {
  const layout: Layout =
    doc.dir === 'rtl' ? { start: 'right', end: 'left' } : { start: 'left', end: 'right' };
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">',
    el('title', {}, doc.subject).html,
    `<style>${STYLE_SHEET}</style>`,
  ].join('');
  const preheader = el(
    'div',
    {
      style: style({
        display: 'none',
        'max-height': '0',
        overflow: 'hidden',
        'font-size': '1px',
        'line-height': '1px',
        opacity: '0',
        'mso-hide': 'all',
      }),
    },
    doc.preheader,
  );
  const card = el(
    'div',
    {
      class: 'rs-card',
      style: style({
        'background-color': LIGHT.card,
        border: `1px solid ${LIGHT.border}`,
        'border-radius': '8px',
        padding: '32px 24px',
      }),
    },
    paragraph(doc.brand, { margin: '0 0 24px', 'font-weight': '700', 'letter-spacing': '0.02em' }),
    el(
      'h1',
      {
        class: 'rs-text',
        style: style({
          margin: '0 0 16px',
          'font-size': '24px',
          'line-height': '32px',
          'font-weight': '700',
          color: LIGHT.text,
        }),
      },
      doc.title,
    ),
    ...doc.blocks.flatMap((b) => block(b, layout)),
  );
  const article = el(
    'div',
    {
      role: 'article',
      'aria-roledescription': 'email',
      'aria-label': doc.subject,
      lang: doc.lang,
      dir: doc.dir,
      class: 'rs-page',
      style: style({
        'background-color': LIGHT.page,
        color: LIGHT.text,
        'font-family': FONT,
        padding: '24px 12px',
      }),
    },
    markup(
      '<!--[if mso]><table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->',
    ),
    el('div', { style: style({ 'max-width': '600px', margin: '0 auto' }) }, card, footer(doc)),
    markup('<!--[if mso]></td></tr></table><![endif]-->'),
  );
  const body = el(
    'body',
    {
      class: 'rs-page',
      style: style({
        margin: '0',
        padding: '0',
        'background-color': LIGHT.page,
        color: LIGHT.text,
        'font-family': FONT,
        '-webkit-text-size-adjust': '100%',
      }),
    },
    preheader,
    article,
  );
  const html = `<!doctype html>\n<html lang="${escapeHtml(doc.lang)}" dir="${doc.dir}"><head>${head}</head>${body.html}</html>\n`;
  // One block element per line keeps snapshots reviewable. A long paragraph can still pass
  // SMTP's 998-character line limit, so the sender must use a transfer encoding (ADR-194).
  // Escaped text never holds a literal "</", so only real tags match.
  return html.replace(
    /(<\/(?:p|h1|h2|ul|li|tr|tbody|table|div|title|style|head)>|<!\[endif\]-->)/gu,
    '$1\n',
  );
}
