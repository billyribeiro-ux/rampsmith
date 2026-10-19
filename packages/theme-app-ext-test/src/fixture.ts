// A small storefront page that stands in for an Online Store 2.0 theme: header, navigation,
// main content and footer, with the app embed rendered where Shopify puts a `body` target,
// just before </body>. The theme part passes axe on its own, so every finding on the page
// belongs to the embed.
import { renderEmbed, type EmbedInput } from './render.ts';

export const SHOP_ORIGIN = 'https://shop.fixture.test';

type ThemeTone = 'light' | 'dark';

const THEME_CSS: Record<ThemeTone, string> = {
  light: 'body{color:#121212;background:#fff}a{color:#121212}footer{border-top:1px solid #6b6b6b}',
  dark: 'body{color:#f3f3f3;background:#121212}a{color:#f3f3f3}footer{border-top:1px solid #9a9a9a}',
};

export interface PageInput extends EmbedInput {
  readonly tone?: ThemeTone;
  /** Tall content above the embed, so it starts below the fold as on a real store. */
  readonly tall?: boolean;
}

export async function renderPage(input: PageInput = {}): Promise<string> {
  const embed = await renderEmbed(input);
  const tall = input.tall === true ? '<div style="height:150vh"></div>' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blue shirt – Fixture Store</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;font-size:16px;line-height:1.5}
header,main,footer{padding:1rem}
nav ul{display:flex;gap:1rem;margin:0;padding:0;list-style:none}
nav a{display:inline-block;min-height:44px;padding:.5rem}
${THEME_CSS[input.tone ?? 'light']}
</style>
</head>
<body>
<header><nav aria-label="Main"><ul><li><a href="/">Home</a></li><li><a href="/collections/all">Catalog</a></li></ul></nav></header>
<main id="main">
<h1>Blue shirt</h1>
<p>A soft cotton shirt in a deep blue.</p>
${tall}
</main>
<footer><p>© Fixture Store</p></footer>
<div id="shopify-block-AdGh1Q3Bp" class="shopify-block shopify-app-block">${embed}</div>
</body>
</html>`;
}
