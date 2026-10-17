/**
 * Every recipe on real Dawn 16.0.0 markup: Dawn already carries each fix, so a recipe must
 * report `already-fixed` on the vendored files; then each fix is removed with a span edit and
 * the recipe must put one back that re-parses, passes Theme Check with no new offenses, and
 * reports `already-fixed` when run again.
 */
import { describe, expect, it } from 'vitest';
import { buildPatch } from '../src/patch.ts';
import { documentLanguage } from '../src/recipes/document-language.ts';
import { emptyButton } from '../src/recipes/empty-button.ts';
import { emptyLink } from '../src/recipes/empty-link.ts';
import { formLabel } from '../src/recipes/form-label.ts';
import { imageAlt } from '../src/recipes/image-alt.ts';
import { skipLink } from '../src/recipes/skip-link.ts';
import type { Recipe, RecipeOutcome } from '../src/recipes/types.ts';
import { validateNoNewOffenses } from '../src/theme-check.ts';
import { localeEdits } from '../src/translations.ts';
import { dawnTheme, readDawn } from './dawn.ts';
import { expectBytesKept, fixTwice, run } from './helpers.ts';

const LAYOUT = 'layout/theme.liquid';
const SOCIAL = 'snippets/social-icons.liquid';
const SEARCH = 'snippets/header-search.liquid';
const QUANTITY = 'snippets/quantity-input.liquid';
const BANNER = 'sections/main-collection-banner.liquid';
const ICONS = 'snippets/icon-with-text.liquid';
const LOCALES = ['locales/en.default.json', 'locales/de.json', 'locales/ja.json'];

/** Offsets of every occurrence of `marker`. */
function allStarts(source: string, marker: string): number[] {
  const starts: number[] = [];
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    starts.push(at);
  }
  return starts;
}

/** Removes exactly one occurrence of `text`, simulating a theme without the fix. */
function without(source: string, text: string): string {
  expect(allStarts(source, text)).toHaveLength(1);
  return source.replace(text, '');
}

/**
 * Builds the whole patch for an outcome (the file plus every locale file) through buildPatch,
 * and checks it with Theme Check against the theme it was made for.
 */
async function patchTheme(
  theme: Map<string, string>,
  outcome: RecipeOutcome,
): Promise<Map<string, string>> {
  if (outcome.kind !== 'edits') throw new Error(JSON.stringify(outcome));
  const locales = LOCALES.map((path) => ({ path, source: theme.get(path) ?? '' }));
  const translations = localeEdits(locales, outcome.translations);
  if (!translations.ok) throw new Error(translations.error.message);
  const result = buildPatch(theme, [...outcome.edits, ...translations.edits]);
  if (!result.ok) throw new Error(result.error.message);
  const after = new Map(theme);
  const edits = [...outcome.edits, ...translations.edits];
  for (const p of result.patches) {
    expectBytesKept(
      p.before,
      edits.filter((e) => e.file === p.file),
      p.after,
    );
    after.set(p.file, p.after);
  }
  const gate = await validateNoNewOffenses(theme, after);
  expect(gate.newOffenses).toEqual([]);
  return after;
}

function brokenTheme(path: string, source: string): Map<string, string> {
  return new Map([...dawnTheme(), [path, source]]);
}

describe('recipes on pristine Dawn', () => {
  function expectAlreadyFixed<P>(recipe: Recipe<P>, path: string, marker: string, params: P) {
    const source = readDawn(path);
    const starts = allStarts(source, marker);
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      expect(run(recipe, path, source, start, params), `${path} @${String(start)}`).toMatchObject({
        kind: 'already-fixed',
      });
    }
  }

  it('find lang, the skip link, link text, button names, labels and image alts already present', () => {
    expectAlreadyFixed(documentLanguage, LAYOUT, '<html', {});
    expectAlreadyFixed(skipLink, LAYOUT, '<body', {});
    expectAlreadyFixed(emptyLink, SOCIAL, '<a ', { label: { key: 'a.b', text: 'x' } });
    expectAlreadyFixed(emptyButton, QUANTITY, '<button', { label: { key: 'a.b', text: 'x' } });
    expectAlreadyFixed(emptyButton, SEARCH, '<button', { label: { key: 'a.b', text: 'x' } });
    expectAlreadyFixed(formLabel, QUANTITY, '<input', { label: { key: 'a.b', text: 'x' } });
    expectAlreadyFixed(imageAlt, BANNER, '<img', {});
  });

  it('label the search input whose label follows it, and skip its hidden input', () => {
    const source = readDawn(SEARCH);
    const [search, hidden] = allStarts(source, '<input');
    expect(
      run(formLabel, SEARCH, source, search ?? -1, { label: { key: 'a.b', text: 'x' } }),
    ).toMatchObject({
      kind: 'already-fixed',
    });
    expect(
      run(formLabel, SEARCH, source, hidden ?? -1, { label: { key: 'a.b', text: 'x' } }),
    ).toMatchObject({
      kind: 'refusal',
      code: 'not-labelable',
    });
  });

  it('refuse the icon images whose alt Dawn sets inside {% if %}', () => {
    const source = readDawn(ICONS);
    for (const start of allStarts(source, '<img')) {
      expect(run(imageAlt, ICONS, source, start, {})).toMatchObject({
        kind: 'refusal',
        code: 'conditional-attribute',
      });
    }
  });
});

describe('recipes restore fixes removed from Dawn', () => {
  it('document-language puts back exactly what Dawn had', async () => {
    const original = readDawn(LAYOUT);
    const broken = without(original, ' lang="{{ request.locale.iso_code }}"');
    const start = broken.indexOf('<html');
    expect(fixTwice(documentLanguage, LAYOUT, broken, start, {})).toBe(original);
    await patchTheme(brokenTheme(LAYOUT, broken), run(documentLanguage, LAYOUT, broken, start, {}));
  });

  it('empty-link puts back exactly what Dawn had for the Facebook link', async () => {
    const original = readDawn(SOCIAL);
    const broken = without(
      original,
      '        <span class="visually-hidden">{{ \'general.social.links.facebook\' | t }}</span>\n',
    );
    const start = broken.indexOf('<a href="{{ settings.social_facebook_link }}"');
    const params = { label: { key: 'general.social.links.facebook', text: 'Facebook' } };
    expect(fixTwice(emptyLink, SOCIAL, broken, start, params)).toBe(original);
    const outcome = run(emptyLink, SOCIAL, broken, start, params);
    await patchTheme(brokenTheme(SOCIAL, broken), outcome);
  });

  it('empty-button puts back exactly what Dawn had for the search reset button', async () => {
    const original = readDawn(SEARCH);
    const broken = without(
      original,
      '\n              aria-label="{{ \'general.search.reset\' | t }}"',
    );
    const start = broken.indexOf('<button\n              type="reset"');
    const params = { label: { key: 'general.search.reset', text: 'Clear search term' } };
    expect(fixTwice(emptyButton, SEARCH, broken, start, params)).toBe(original);
    await patchTheme(brokenTheme(SEARCH, broken), run(emptyButton, SEARCH, broken, start, params));
  });

  it('empty-button names the quantity button with a new key added to every locale', async () => {
    const original = readDawn(QUANTITY);
    const broken = without(
      original,
      '    <span class="visually-hidden">\n      {{- \'products.product.quantity.decrease\' | t: product: variant.title | escape -}}\n    </span>\n',
    );
    const start = broken.indexOf('<button class="quantity__button" name="minus"');
    const params = {
      label: { key: 'accessibility.rampsmith_decrease', text: 'Decrease quantity' },
    };
    const after = fixTwice(emptyButton, QUANTITY, broken, start, params);
    expect(after).toContain(
      'data-target="decrement-{{ variant.id }}" aria-label="{{ \'accessibility.rampsmith_decrease\' | t }}">',
    );
    const theme = await patchTheme(
      brokenTheme(QUANTITY, broken),
      run(emptyButton, QUANTITY, broken, start, params),
    );
    for (const path of LOCALES) {
      const parsed = JSON.parse(theme.get(path) ?? '') as { accessibility: Record<string, string> };
      expect(parsed.accessibility['rampsmith_decrease']).toBe('Decrease quantity');
    }
  });

  it('form-label labels the search input by its Liquid id', async () => {
    const original = readDawn(SEARCH);
    const broken = without(
      original,
      '\n            <label class="field__label" for="{{ input_id }}">{{ \'general.search.search\' | t }}</label>',
    );
    const start = broken.indexOf('<input\n              class="search__input field__input"');
    const params = { label: { key: 'general.search.search', text: 'Search' } };
    const after = fixTwice(formLabel, SEARCH, broken, start, params);
    expect(after).toContain(
      '            <label for="{{ input_id }}" class="visually-hidden">{{ \'general.search.search\' | t }}</label>\n            <input\n              class="search__input field__input"',
    );
    await patchTheme(brokenTheme(SEARCH, broken), run(formLabel, SEARCH, broken, start, params));
  });

  it('image-alt adds the collection image alt the way Dawn writes it', async () => {
    const original = readDawn(BANNER);
    const broken = without(original, '          alt="{{ collection.image.alt | escape }}"\n');
    const start = broken.indexOf('<img');
    const after = fixTwice(imageAlt, BANNER, broken, start, {});
    expect(after).toBe(
      broken.replace(
        '          height="{{ collection.image.height }}"\n',
        '          height="{{ collection.image.height }}"\n          alt="{{ collection.image.alt | escape }}"\n',
      ),
    );
    await patchTheme(brokenTheme(BANNER, broken), run(imageAlt, BANNER, broken, start, {}));
  });

  it('skip-link adds a link and its CSS when Dawn’s link is removed', async () => {
    const original = readDawn(LAYOUT);
    const broken = without(
      original,
      '    <a class="skip-to-content-link button visually-hidden" href="#MainContent">\n      {{ \'accessibility.skip_to_text\' | t }}\n    </a>\n\n',
    );
    const start = broken.indexOf('<body');
    const after = fixTwice(skipLink, LAYOUT, broken, start, {});
    expect(after).toContain(
      '<body class="gradient{% if settings.animations_hover_elements != \'none\' %} animate--hover-{{ settings.animations_hover_elements }}{% endif %}">\n    <a class="rampsmith-skip-link" href="#MainContent">{{ \'accessibility.skip_to_text\' | t }}</a>\n',
    );
    expect(after).toContain('    <style>\n      .rampsmith-skip-link {');
    expect(after).toContain('    </style>\n  </head>');
    // Dawn has the key, so no locale file changes.
    const theme = await patchTheme(
      brokenTheme(LAYOUT, broken),
      run(skipLink, LAYOUT, broken, start, {}),
    );
    for (const path of LOCALES) expect(theme.get(path)).toBe(readDawn(path));
  });
});
