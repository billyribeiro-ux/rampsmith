/**
 * A small hand-written theme for the mapper tests ("tarn"): a layout with a section group,
 * JSON templates, a snippet, rich text, and CSS that sets colour, focus, underline and size in
 * the ways ADR-244 and ADR-245 must follow. Offsets are found by marker, never counted.
 */
import { ThemeIndex } from '../src/map/theme.ts';
import type { RenderedElement, RenderedNode } from '../src/map/types.ts';

export const LAYOUT = `<!doctype html>
<html>
<head>
  <style>
    .btn:focus { outline: none; }
    .muted { color: {{ settings.color_muted }}; }
    .card a { text-decoration: none; }
    .tiny { width: 16px; height: 16px; }
    .hero__title { color: var(--title-color); }
    .hero { --title-color: {{ section.settings.title_color }}; }
    .plain { color: #9b9b9b; }
    .plain--later { color: #8a8a8a; }
    .fancy:has(img) { color: #aaaaaa; }
    .shout { color: #777777 !important; }
  </style>
  {{ content_for_header }}
</head>
<body class="theme">
  {% sections 'header-group' %}
  <main id="MainContent">{{ content_for_layout }}</main>
</body>
</html>
`;

export const HEADER = `<header class="site-header">
  <a href="/" class="logo">Tarn</a>
  <nav class="site-nav desktop-only"><a href="/cart" class="cart-link"><svg class="icon" aria-hidden="true"></svg></a></nav>
  <nav class="site-nav mobile-only"><a href="/cart" class="cart-link"><svg class="icon" aria-hidden="true"></svg></a></nav>
  {% render 'search-form' %}
</header>
`;

export const SEARCH_FORM = `<form action="/search" class="search">
  <input type="search" name="q" class="search__input">
</form>
`;

export const HERO = `<section class="hero">
  <h2 class="hero__title">Welcome</h2>
  <p class="hero__text muted">Our story</p>
  <p class="plain">Plain copy</p>
  <p class="plain plain--later">Later copy</p>
  <p class="shout">Loud copy</p>
  <p class="fancy"><img src="/a.png" alt=""></p>
  <p class="inline" style="color: #bbbbbb; margin: 0">Inline copy</p>
  <a href="{{ section.settings.link }}" class="btn">Shop</a>
  <button class="icon-button"><svg aria-hidden="true"></svg></button>
  <div class="card"><p>Read <a href="/about">about us</a> today.</p></div>
  <a href="/tiny" class="tiny"></a>
</section>
`;

export const TWIN = `<section class="twin">
  <a href="{{ one.url }}" class="dup">{{ one.title }}</a>
  <a href="{{ two.url }}" class="dup">{{ two.title }}</a>
  {% render snippet_name %}
  <span class="few">{{ few }}</span>
</section>
`;

export const ELSEWHERE = `<aside class="sidebar"><button class="not-on-this-page"></button></aside>
`;

export const MAIN_PAGE = `<article class="page">
  <h1>{{ page.title }}</h1>
  <div class="rte">{{ page.content }}</div>
</article>
`;

export const SETTINGS_DATA = `{
  "current": {
    "color_muted": "#9b9b9b",
    "color_text": "#111111"
  }
}
`;

export const INDEX_JSON = `{
  "sections": {
    "hero": {
      "type": "hero",
      "settings": { "title_color": "#a0a0a0", "link": "/collections/all" }
    },
    "twin": { "type": "twin", "settings": {} }
  },
  "order": ["hero", "twin"]
}
`;

export const PAGE_JSON = `{
  "sections": { "main": { "type": "main-page", "settings": {} } },
  "order": ["main"]
}
`;

export const HEADER_GROUP = `{
  "type": "header",
  "name": "Header group",
  "sections": { "header": { "type": "header", "settings": {} } },
  "order": ["header"]
}
`;

export function tarn(): Map<string, string> {
  return new Map([
    ['layout/theme.liquid', LAYOUT],
    ['sections/header-group.json', HEADER_GROUP],
    ['sections/header.liquid', HEADER],
    ['sections/hero.liquid', HERO],
    ['sections/twin.liquid', TWIN],
    ['sections/sidebar.liquid', ELSEWHERE],
    ['sections/main-page.liquid', MAIN_PAGE],
    ['snippets/search-form.liquid', SEARCH_FORM],
    ['templates/index.json', INDEX_JSON],
    ['templates/page.json', PAGE_JSON],
    ['config/settings_data.json', SETTINGS_DATA],
  ]);
}

export function tarnIndex(): ThemeIndex {
  return new ThemeIndex(tarn());
}

export function node(tag: string, attributes: Record<string, string> = {}): RenderedNode {
  return { tag, attributes };
}

/** The wrappers above a section's content, nearest first, up to `<html>`. */
export function pageAbove(sectionId?: string): RenderedNode[] {
  const wrapper =
    sectionId === undefined
      ? []
      : [node('div', { id: `shopify-section-${sectionId}`, class: 'shopify-section' })];
  return [
    ...wrapper,
    node('main', { id: 'MainContent' }),
    node('body', { class: 'theme' }),
    node('html'),
  ];
}

export function rendered(
  tag: string,
  attributes: Record<string, string>,
  text: string,
  ancestors: readonly RenderedNode[],
): RenderedElement {
  return { tag, attributes, text, ancestors };
}

/** The offset of `marker` in `source`, which must occur once. */
export function at(source: string, marker: string): number {
  const first = source.indexOf(marker);
  if (first === -1 || source.includes(marker, first + 1)) {
    throw new Error(`"${marker}" must occur exactly once`);
  }
  return first;
}
