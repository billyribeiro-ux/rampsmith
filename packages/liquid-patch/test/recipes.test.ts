import { describe, expect, it } from 'vitest';
import { documentLanguage } from '../src/recipes/document-language.ts';
import { emptyButton } from '../src/recipes/empty-button.ts';
import { emptyLink } from '../src/recipes/empty-link.ts';
import { formLabel } from '../src/recipes/form-label.ts';
import { imageAlt } from '../src/recipes/image-alt.ts';
import { skipLink } from '../src/recipes/skip-link.ts';
import { fixTwice, parsed, patched, run, startOf } from './helpers.ts';

const LAYOUT = 'layout/theme.liquid';
const CART = { key: 'accessibility.cart', text: 'Cart' };
const CLOSE = { key: 'accessibility.close', text: 'Close' };
const EMAIL = { key: 'newsletter.email_label', text: 'Email' };

describe('document-language', () => {
  const lang = (source: string, path = LAYOUT) =>
    run(documentLanguage, path, source, startOf(source, '<html'), {});

  it('adds lang after the last attribute', () => {
    const source = '<!doctype html>\n<html class="no-js">\n<body></body>\n</html>\n';
    expect(fixTwice(documentLanguage, LAYOUT, source, startOf(source, '<html'), {})).toBe(
      '<!doctype html>\n<html class="no-js" lang="{{ request.locale.iso_code }}">\n<body></body>\n</html>\n',
    );
  });

  it('adds lang to a bare <html> and keeps one attribute per line', () => {
    const bare = '<html><body></body></html>';
    expect(patched(bare, lang(bare))).toBe(
      '<html lang="{{ request.locale.iso_code }}"><body></body></html>',
    );
    const lines = '<html\n  class="js"\n  dir="ltr"\n>\n<body></body>\n</html>\n';
    expect(patched(lines, lang(lines))).toBe(
      '<html\n  class="js"\n  dir="ltr"\n  lang="{{ request.locale.iso_code }}"\n>\n<body></body>\n</html>\n',
    );
  });

  it('replaces an empty lang', () => {
    const empty = '<html lang="" class="js"></html>';
    expect(patched(empty, lang(empty))).toBe(
      '<html lang="{{ request.locale.iso_code }}" class="js"></html>',
    );
    const bare = '<html lang></html>';
    expect(patched(bare, lang(bare))).toBe('<html lang="{{ request.locale.iso_code }}"></html>');
  });

  it('is already fixed by a static lang or the locale output', () => {
    expect(lang('<html lang="fr"></html>')).toMatchObject({ kind: 'already-fixed' });
    expect(lang('<html lang="{{ request.locale.iso_code }}"></html>')).toMatchObject({
      kind: 'already-fixed',
    });
    expect(lang('<html lang="{{-request.locale.iso_code -}}"></html>')).toMatchObject({
      kind: 'already-fixed',
    });
  });

  it('refuses other Liquid in lang, a conditional lang, and the wrong file or element', () => {
    expect(lang('<html lang="{{ shop.locale }}"></html>')).toMatchObject({
      kind: 'refusal',
      code: 'liquid-in-attribute',
    });
    expect(lang('<html {% if a %}lang="en"{% endif %}></html>')).toMatchObject({
      kind: 'refusal',
      code: 'conditional-attribute',
    });
    expect(lang('<html></html>', 'sections/x.liquid')).toMatchObject({ code: 'wrong-file' });
    const source = '<html><head></head></html>';
    expect(
      documentLanguage.run(
        parsed(LAYOUT, source),
        { file: 'layout/password.liquid', start: 0 },
        {},
      ),
    ).toMatchObject({ code: 'wrong-file' });
    expect(run(documentLanguage, LAYOUT, source, 1, {})).toMatchObject({
      code: 'target-not-found',
    });
    expect(run(documentLanguage, LAYOUT, source, startOf(source, '<head'), {})).toMatchObject({
      code: 'wrong-element',
    });
  });
});

const THEME = [
  '<!doctype html>',
  '<html lang="{{ request.locale.iso_code }}">',
  '  <head>',
  '    <title>{{ page_title }}</title>',
  '  </head>',
  '  <body class="page">',
  "    {% sections 'header-group' %}",
  '    <main id="MainContent" role="main">',
  '      {{ content_for_layout }}',
  '    </main>',
  '  </body>',
  '</html>',
  '',
].join('\n');

describe('skip-link', () => {
  const skip = (source: string, params = {}) =>
    run(skipLink, LAYOUT, source, startOf(source, '<body'), params);

  it('adds the link as the first child of <body> and its CSS at the end of <head>', () => {
    const outcome = skip(THEME);
    expect(outcome).toMatchObject({
      kind: 'edits',
      translations: [{ key: 'accessibility.skip_to_text', text: 'Skip to content' }],
    });
    expect(fixTwice(skipLink, LAYOUT, THEME, startOf(THEME, '<body'), {})).toBe(
      [
        '<!doctype html>',
        '<html lang="{{ request.locale.iso_code }}">',
        '  <head>',
        '    <title>{{ page_title }}</title>',
        '    <style>',
        '      .rampsmith-skip-link { position: absolute; z-index: 9999; top: 0; left: 0; padding: 0.75rem 1rem; background: #fff; color: #000; text-decoration: underline; }',
        '      .rampsmith-skip-link:not(:focus) { width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }',
        '    </style>',
        '  </head>',
        '  <body class="page">',
        '    <a class="rampsmith-skip-link" href="#MainContent">{{ \'accessibility.skip_to_text\' | t }}</a>',
        "    {% sections 'header-group' %}",
        '    <main id="MainContent" role="main">',
        '      {{ content_for_layout }}',
        '    </main>',
        '  </body>',
        '</html>',
        '',
      ].join('\n'),
    );
  });

  it('gives the main landmark an id when it has none, including a role="main" element', () => {
    const noId = THEME.replace('<main id="MainContent" role="main">', '<main>');
    const after = fixTwice(skipLink, LAYOUT, noId, startOf(noId, '<body'), { mainId: 'Main' });
    expect(after).toContain('<main id="Main">');
    expect(after).toContain('href="#Main"');
    const div = THEME.replace(
      '<main id="MainContent" role="main">',
      '<div role="main" class="x">',
    ).replace('</main>', '</div>');
    expect(fixTwice(skipLink, LAYOUT, div, startOf(div, '<body'), {})).toContain(
      '<div role="main" class="x" id="MainContent">',
    );
  });

  it('is already fixed when a link to the main landmark comes before it', () => {
    const fixedTheme = THEME.replace(
      '  <body class="page">\n',
      '  <body class="page">\n    <a class="skip" href="#MainContent">Skip</a>\n',
    );
    expect(skip(fixedTheme)).toMatchObject({ kind: 'already-fixed' });
  });

  it('does not count a link that comes after the main landmark', () => {
    const late = THEME.replace('  </body>', '    <a href="#MainContent">Top</a>\n  </body>');
    expect(skip(late)).toMatchObject({ kind: 'edits' });
  });

  it('only adds the missing id when the link already exists', () => {
    const linkOnly = THEME.replace('<main id="MainContent" role="main">', '<main>').replace(
      '  <body class="page">\n',
      '  <body class="page">\n    <a href="#MainContent">Skip</a>\n',
    );
    const outcome = skip(linkOnly);
    expect(outcome).toMatchObject({ kind: 'edits', translations: [] });
    expect(patched(linkOnly, outcome)).toContain('<main id="MainContent">');
  });

  it('inserts inline when <body> is written on one line, and keeps CRLF', () => {
    const inline = '<html><head><title>x</title></head><body><main id="m">x</main></body></html>';
    expect(patched(inline, skip(inline))).toBe(
      '<html><head><title>x</title><style>  .rampsmith-skip-link { position: absolute; z-index: 9999; top: 0; left: 0; padding: 0.75rem 1rem; background: #fff; color: #000; text-decoration: underline; }  .rampsmith-skip-link:not(:focus) { width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }</style></head><body><a class="rampsmith-skip-link" href="#m">{{ \'accessibility.skip_to_text\' | t }}</a><main id="m">x</main></body></html>',
    );
    const crlf = THEME.replaceAll('\n', '\r\n');
    const after = patched(crlf, skip(crlf));
    expect(after.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('refuses without a main landmark or a head, and on an unusable main id', () => {
    const noMain = THEME.replace('<main id="MainContent" role="main">', '<div>').replace(
      '</main>',
      '</div>',
    );
    expect(skip(noMain)).toMatchObject({ code: 'main-landmark-not-found' });
    const noHead = THEME.replace(/ {2}<head>[\s\S]*<\/head>\n/u, '');
    expect(skip(noHead)).toMatchObject({ code: 'head-not-found' });
    const liquidId = THEME.replace('id="MainContent"', 'id="{{ main_id }}"');
    expect(skip(liquidId)).toMatchObject({ code: 'liquid-in-attribute' });
    const taken = THEME.replace('<main id="MainContent" role="main">', '<main>').replace(
      '<title>',
      '<title id="MainContent">',
    );
    expect(skip(taken)).toMatchObject({ code: 'id-conflict' });
    const conditional = THEME.replace('id="MainContent"', '{% if a %}id="MainContent"{% endif %}');
    expect(skip(conditional)).toMatchObject({ code: 'conditional-attribute' });
  });

  it('refuses bad parameters and files that are not layouts', () => {
    expect(skip(THEME, { className: 'two words' })).toMatchObject({ code: 'invalid-parameter' });
    expect(skip(THEME, { mainId: '1main' })).toMatchObject({ code: 'invalid-parameter' });
    expect(skip(THEME, { label: { key: 'skip', text: 'Skip' } })).toMatchObject({
      code: 'invalid-parameter',
    });
    expect(run(skipLink, 'templates/page.liquid', THEME, 0, {})).toMatchObject({
      code: 'wrong-file',
    });
  });
});

describe('empty-link', () => {
  const link = (source: string, params: Parameters<typeof emptyLink.run>[2] = { label: CART }) =>
    run(emptyLink, 'sections/header.liquid', source, startOf(source, '<a'), params);

  it('adds visually hidden text as the last child, on its own line', () => {
    const source = [
      '<div class="header__icons">',
      '  <a href="{{ routes.cart_url }}" class="header__icon">',
      "    {{ 'icon-cart.svg' | inline_asset_content }}",
      '  </a>',
      '</div>',
      '',
    ].join('\n');
    expect(link(source)).toMatchObject({ kind: 'edits', translations: [CART] });
    expect(
      fixTwice(emptyLink, 'sections/header.liquid', source, startOf(source, '<a'), { label: CART }),
    ).toBe(
      [
        '<div class="header__icons">',
        '  <a href="{{ routes.cart_url }}" class="header__icon">',
        "    {{ 'icon-cart.svg' | inline_asset_content }}",
        '    <span class="visually-hidden">{{ \'accessibility.cart\' | t }}</span>',
        '  </a>',
        '</div>',
        '',
      ].join('\n'),
    );
  });

  it('inserts inline into a one-line link and takes a custom class', () => {
    const source = '<a href="/cart"><svg viewBox="0 0 1 1"><path d="M0"/></svg></a>';
    expect(patched(source, link(source, { label: CART, visuallyHiddenClass: 'sr-only' }))).toBe(
      '<a href="/cart"><svg viewBox="0 0 1 1"><path d="M0"/></svg><span class="sr-only">{{ \'accessibility.cart\' | t }}</span></a>',
    );
  });

  it('treats icon snippets and hidden elements as having no text', () => {
    expect(link('<a href="/">{% render \'icon-cart\' %}</a>')).toMatchObject({ kind: 'edits' });
    expect(link('<a href="/"><span aria-hidden="true">x</span></a>')).toMatchObject({
      kind: 'edits',
    });
    expect(link('<a href="/"><img src="a.png" alt=""></a>')).toMatchObject({ kind: 'edits' });
    expect(link('<a href="/">{% comment %}x{% endcomment %}{% assign a = 1 %}</a>')).toMatchObject({
      kind: 'edits',
    });
    expect(link('<a href="/"><!-- icon --><script>var a;</script></a>')).toMatchObject({
      kind: 'edits',
    });
  });

  it('is already fixed by text, a translation, aria-label, title, an image alt or an svg title', () => {
    for (const source of [
      '<a href="/">Cart</a>',
      '<a href="/"><span class="visually-hidden">{{ \'a.b\' | t }}</span></a>',
      '<a href="/" aria-label="Cart"></a>',
      '<a href="/" aria-label="{{ \'a.b\' | t }}"></a>',
      '<a href="/" aria-labelledby="x"></a>',
      '<a href="/" aria-labelledby="{{ heading_id }}"></a>',
      '<a href="/" title="Cart"></a>',
      '<a href="/"><img src="a.png" alt="Cart"></a>',
      '<a href="/"><svg><title>Cart</title></svg></a>',
      '<a href="/"><svg aria-label="Cart"></svg></a>',
    ]) {
      expect(link(source), source).toMatchObject({ kind: 'already-fixed' });
    }
  });

  it('refuses content that may print text, and Liquid or conditions in aria-label', () => {
    for (const source of [
      '<a href="/">{{ link.title }}</a>',
      '<a href="/">{% if a %}Cart{% endif %}</a>',
      '<a href="/">{% render \'price\' %}</a>',
      '<a href="/"><img src="a.png" alt="{{ image.alt }}"></a>',
      '<a href="/">{% raw %}x{% endraw %}</a>',
      '<a href="/">{{ x | | }}</a>',
      '<a href="/">{% echo product.title %}</a>',
    ]) {
      expect(link(source), source).toMatchObject({ kind: 'refusal', code: 'dynamic-content' });
    }
    expect(link('<a href="/" aria-label="{{ x }}"></a>')).toMatchObject({
      code: 'liquid-in-attribute',
    });
    expect(link('<a href="/" {% if a %}aria-label="x"{% endif %}></a>')).toMatchObject({
      code: 'conditional-attribute',
    });
  });

  it('refuses other elements and bad parameters', () => {
    expect(link('<a href="/"/>')).toMatchObject({ code: 'wrong-element' });
    expect(
      run(emptyLink, 'sections/header.liquid', '<button></button>', 0, { label: CART }),
    ).toMatchObject({ code: 'wrong-element' });
    expect(link('<a href="/"></a>', { label: { key: 'cart', text: 'Cart' } })).toMatchObject({
      code: 'invalid-parameter',
    });
    expect(link('<a href="/"></a>', { label: CART, visuallyHiddenClass: '"x' })).toMatchObject({
      code: 'invalid-parameter',
    });
  });
});

describe('empty-button', () => {
  const button = (source: string) =>
    run(emptyButton, 'snippets/drawer.liquid', source, startOf(source, '<button'), {
      label: CLOSE,
    });

  it('adds aria-label from the translation key', () => {
    const source = [
      '<button',
      '  type="button"',
      '  class="drawer__close"',
      '>',
      "  {% render 'icon-close' %}",
      '</button>',
      '',
    ].join('\n');
    expect(
      fixTwice(emptyButton, 'snippets/drawer.liquid', source, startOf(source, '<button'), {
        label: CLOSE,
      }),
    ).toBe(
      [
        '<button',
        '  type="button"',
        '  class="drawer__close"',
        '  aria-label="{{ \'accessibility.close\' | t }}"',
        '>',
        "  {% render 'icon-close' %}",
        '</button>',
        '',
      ].join('\n'),
    );
  });

  it('replaces an empty aria-label', () => {
    const source = '<button aria-label="" type="button"><svg></svg></button>';
    expect(patched(source, button(source))).toBe(
      '<button aria-label="{{ \'accessibility.close\' | t }}" type="button"><svg></svg></button>',
    );
  });

  it('is already fixed by a translation, hidden text or visible text', () => {
    expect(button('<button aria-label="{{ \'a.b\' | t }}"></button>')).toMatchObject({
      kind: 'already-fixed',
    });
    expect(
      button('<button><span class="visually-hidden">{{ \'a.b\' | t: n: 1 }}</span></button>'),
    ).toMatchObject({ kind: 'already-fixed' });
    expect(button('<button>Close</button>')).toMatchObject({ kind: 'already-fixed' });
  });

  it('refuses Liquid in aria-label and content that may print text', () => {
    expect(button('<button aria-label="{{ label }}"></button>')).toMatchObject({
      code: 'liquid-in-attribute',
    });
    expect(button('<button>{{ label }}</button>')).toMatchObject({ code: 'dynamic-content' });
    expect(
      run(emptyButton, 'snippets/drawer.liquid', '<button/>', 0, { label: CLOSE }),
    ).toMatchObject({ code: 'wrong-element' });
    expect(
      run(emptyButton, 'snippets/drawer.liquid', '<button></button>', 0, {
        label: { key: 'x', text: 'y' },
      }),
    ).toMatchObject({ code: 'invalid-parameter' });
  });
});

describe('form-label', () => {
  const SECTION = 'sections/newsletter.liquid';
  const label = (
    source: string,
    path = SECTION,
    params: Parameters<typeof formLabel.run>[2] = { label: EMAIL },
    marker = '<input',
  ) => run(formLabel, path, source, startOf(source, marker), params);

  it('adds a section-unique id and a visually hidden label before the input', () => {
    const source = [
      '<form>',
      '  <input type="email" name="contact[email]" placeholder="Email">',
      '</form>',
      '',
    ].join('\n');
    expect(label(source)).toMatchObject({ kind: 'edits', translations: [EMAIL] });
    expect(fixTwice(formLabel, SECTION, source, startOf(source, '<input'), { label: EMAIL })).toBe(
      [
        '<form>',
        '  <label for="Field-contact-email-{{ section.id }}" class="visually-hidden">{{ \'newsletter.email_label\' | t }}</label>',
        '  <input type="email" name="contact[email]" placeholder="Email" id="Field-contact-email-{{ section.id }}">',
        '</form>',
        '',
      ].join('\n'),
    );
  });

  it('uses an existing id, static or printed by Liquid', () => {
    const fixedId = '<div><input id="Search" type="search"></div>';
    expect(patched(fixedId, label(fixedId))).toBe(
      '<div><label for="Search" class="visually-hidden">{{ \'newsletter.email_label\' | t }}</label><input id="Search" type="search"></div>',
    );
    const liquidId = '<input id="{{ input_id }}" type="search">';
    const after = fixTwice(formLabel, 'snippets/search.liquid', liquidId, 0, { label: EMAIL });
    expect(after).toContain('<label for="{{ input_id }}"');
  });

  it('needs a caller id in snippets and loops, and uses it', () => {
    const source = '<input type="text" name="q">';
    expect(label(source, 'snippets/search.liquid')).toMatchObject({ code: 'needs-unique-id' });
    expect(
      patched(source, label(source, 'snippets/search.liquid', { label: EMAIL, id: 'Search-q' })),
    ).toContain('<input type="text" name="q" id="Search-q">');
    const loop = '{% for item in items %}<input type="number" name="q">{% endfor %}';
    expect(label(loop)).toMatchObject({ code: 'needs-unique-id' });
    expect(label(loop, SECTION, { label: EMAIL, id: 'Qty' })).toMatchObject({
      code: 'needs-unique-id',
    });
    const withLiquid = label(loop, SECTION, { label: EMAIL, id: 'Qty-{{ forloop.index }}' });
    expect(patched(loop, withLiquid)).toContain('id="Qty-{{ forloop.index }}"');
    expect(label(source, 'layout/theme.liquid')).toMatchObject({ kind: 'edits' });
  });

  it('is already fixed by a label for the id (before or after), a wrapping label or ARIA', () => {
    for (const [source, path] of [
      ['<input id="q"><label for="q">Search</label>', SECTION],
      ['<label for="{{ id }}">x</label><input id="{{ id }}">', 'snippets/a.liquid'],
      ['<label>Email <input type="email"></label>', SECTION],
      ['<input aria-label="{{ \'a.b\' | t: product: p | escape }}">', SECTION],
      ['<input aria-labelledby="x">', SECTION],
      ['<input title="Search">', SECTION],
    ] as const) {
      expect(label(source, path), source).toMatchObject({ kind: 'already-fixed' });
    }
  });

  it('labels select and textarea, and replaces an empty id', () => {
    const select = '<select name="sort"><option>a</option></select>';
    expect(patched(select, label(select, SECTION, { label: EMAIL }, '<select'))).toContain(
      '<select name="sort" id="Field-sort-{{ section.id }}">',
    );
    const textarea = '<textarea id="" name="body"></textarea>';
    expect(patched(textarea, label(textarea, SECTION, { label: EMAIL }, '<textarea'))).toContain(
      '<textarea id="Field-body-{{ section.id }}" name="body">',
    );
  });

  it('refuses unlabelable inputs, conflicts and bad parameters', () => {
    expect(label('<input type="hidden" name="a">')).toMatchObject({ code: 'not-labelable' });
    expect(label('<input type="Submit">')).toMatchObject({ code: 'not-labelable' });
    expect(label('<input type="{{ t }}" name="a">')).toMatchObject({ kind: 'edits' });
    expect(
      label('<p id="Search-q"></p><input name="q">', 'snippets/a.liquid', {
        label: EMAIL,
        id: 'Search-q',
      }),
    ).toMatchObject({ code: 'id-conflict' });
    expect(label('<input aria-label="{{ x }}">')).toMatchObject({ code: 'liquid-in-attribute' });
    expect(label('<input {% if a %}id="x"{% endif %}>')).toMatchObject({
      code: 'conditional-attribute',
    });
    expect(label('<input id=\'{{ "q" }}\'>')).toMatchObject({ code: 'liquid-in-attribute' });
    expect(label('<input>', SECTION, { label: EMAIL, id: 'a b' })).toMatchObject({
      code: 'invalid-parameter',
    });
    expect(label('<button></button>', SECTION, { label: EMAIL }, '<button')).toMatchObject({
      code: 'wrong-element',
    });
  });
});

describe('image-alt', () => {
  const SECTION = 'sections/banner.liquid';
  const img = (source: string, params = {}) =>
    run(imageAlt, SECTION, source, startOf(source, '<img'), params);

  it("adds the image object's alt, escaped", () => {
    const source = [
      '<img',
      '  src="{{ section.settings.image | image_url: width: 800 }}"',
      '  width="800"',
      '>',
      '',
    ].join('\n');
    expect(fixTwice(imageAlt, SECTION, source, 0, {})).toBe(
      [
        '<img',
        '  src="{{ section.settings.image | image_url: width: 800 }}"',
        '  width="800"',
        '  alt="{{ section.settings.image.alt | escape }}"',
        '>',
        '',
      ].join('\n'),
    );
  });

  it('finds the object through .src, subscripts, srcset and a self-closing tag', () => {
    const src = '<img src="{{ image.src | image_url }}" />';
    expect(patched(src, img(src))).toBe(
      '<img src="{{ image.src | image_url }}" alt="{{ image.alt | escape }}" />',
    );
    const indexed = '<img src="{{ product.images[0] | img_url: \'large\' }}">';
    expect(patched(indexed, img(indexed))).toContain('alt="{{ product.images[0].alt | escape }}"');
    const srcset = '<img srcset="{{ block.settings.photo | image_url: width: 300 }} 300w">';
    expect(patched(srcset, img(srcset))).toContain('alt="{{ block.settings.photo.alt | escape }}"');
  });

  it('writes alt="" and records the reason when the image is declared decorative', () => {
    const source = '<img src="{{ \'divider.svg\' | asset_url }}">';
    const outcome = img(source, { decorative: { reason: 'divider line' } });
    expect(outcome).toMatchObject({ kind: 'edits', notes: ['decorative: divider line'] });
    expect(patched(source, outcome)).toBe('<img src="{{ \'divider.svg\' | asset_url }}" alt="">');
  });

  it('is already fixed by any static alt, an alt property, or a presentational role', () => {
    for (const source of [
      '<img src="a.png" alt="A">',
      '<img src="a.png" alt="">',
      '<img src="a.png" alt>',
      '<img src="{{ x | image_url }}" alt="{{ x.alt | escape }}">',
      '<img src="a.png" role="presentation">',
      '<img src="a.png" aria-hidden="true">',
    ]) {
      expect(img(source), source).toMatchObject({ kind: 'already-fixed' });
    }
  });

  it('refuses images without an image object, other Liquid in alt and conditional alt', () => {
    for (const source of [
      '<img src="{{ product | image_url }}">',
      '<img src="{{ \'logo.png\' | asset_url }}">',
      '<img src="/logo.png">',
      '<img src="{{ image[\'src\'] | image_url }}">',
    ]) {
      expect(img(source), source).toMatchObject({ code: 'no-image-object' });
    }
    expect(img('<img src="a.png" alt="{{ product.title }}">')).toMatchObject({
      code: 'liquid-in-attribute',
    });
    expect(
      img('<img src="{{ i | image_url }}" {% if i.alt %}alt="{{ i.alt }}"{% endif %}>'),
    ).toMatchObject({ code: 'conditional-attribute' });
    expect(img('<img src="a.png">', { decorative: { reason: ' ' } })).toMatchObject({
      code: 'invalid-parameter',
    });
  });
});
