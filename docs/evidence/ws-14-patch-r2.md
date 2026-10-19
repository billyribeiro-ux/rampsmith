# WS-14 evidence: the patch engine to the R2 bar

- Stream: WS-14 / agent W4, branch `ws/patch-r2` (from `r0-foundations`, with `ws/corpus` and
  `ws/liquid-patch` merged in at `5831929`), draft pull request #12 into `r0-foundations`
  (stream CI only; never merged)
- Session: https://claude.ai/code/session_01BPVvuawk8zcgpSyW5kKQKh
- Owned paths: `packages/liquid-patch/`, `packages/corpus-tools/`; ADRs 241 to 249; this file
- Date: 19 Oct 2026 (UTC)
- Toolchain: Node.js 26.12.0, Chromium 1280×800, axe-core 4.14.0, TypeScript 6.x strict with the
  PLAN §8 flags, Theme Check `@shopify/theme-check-common` 3.30.1 in memory

## Result

R2's exit criterion (PLAN §5) holds on the corpus, enforced by tests that fail below the bar:

| Gate (ADR-203, ADR-247) | Bar | Before this work | After |
| --- | --- | --- | --- |
| Mapping: correct at confidence 0.9 or more, of the 48 findings that need mapping | 95% | 0 of 48 (no mapper) | **48 of 48 (100%)** |
| Mapping: wrong at confidence 0.9 or more | none | n/a | **0** |
| Fix rate: targeted findings fixed (engine edits, rescan no longer fires) | 90% | 30 of 35 (85.7%) | **35 of 35 (100%)** |
| Render regressions (page renders, axe-core counts per rule explained, no new Theme Check offense) | 0 | 0 | **0** |
| Scanner findings with no golden finding, golden findings that did not fire | 0 | 0 | **0** |

"Before" is the engine at `551b200` as WS-11 measured it (reproduced here by running the new
runner on golden spans without the contrast recipe: 30 of 35, every miss a low-contrast finding).
Nothing in `corpus/` was changed; no golden file or theme had an error.

### Per category

| Category | Findings | Mapped correctly (after) | Targeted | Fixed, before | Fixed, after |
| --- | --- | --- | --- | --- | --- |
| low-contrast | 5 | 5 | 5 | 0 | **5** |
| alt-text-theme-image | 5 | 5 | 4 | 4 | **4** |
| form-label | 7 | 7 | 7 | 7 | **7** |
| empty-link | 10 | 10 | 8 | 8 | **8** |
| empty-button | 8 | 8 | 8 | 8 | **8** |
| document-language | 3 | 3 | 3 | 3 | **3** |
| focus-visible | 1 | 1 | 0 | no recipe | no recipe |
| target-size | 1 | 1 | 0 | no recipe | no recipe |
| skip-link | 1 | 1 | 0 | refused as expected | refused as expected |
| widget-roles | 4 | 4 | 0 | review | review |
| rich-text (store data) | 1 | 1 | 0 | review | review |
| other | 2 | 2 | 0 | review | review |
| **All** | **48** | **48** | **35** | **30** | **35** |

Mapping accuracy per category is 100% in all twelve rows. The five `harbor` store-data findings
need no mapping and are reviewed through the Admin API. By theme: aurora 19 of 19 mapped, 17 of 17
targeted fixed; birch 16 of 16, 13 of 13; cedar 13 of 13, 5 of 5.

### Every finding (after, the default run)

Span is where the mapper put the fix; every span equals the golden span. `Conf.` is the mapper's
confidence.

| Finding | Rule | Category | Mapped to | Conf. | Mapping | Fix | Targeted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| aurora/html-lang | html-has-lang | document-language | layout/theme.liquid @16 `<html>` | 0.97 | correct | fixed | yes |
| aurora/announcement-contrast | color-contrast | low-contrast | config/settings_data.json /current/color_announcement_text | 0.96 | correct | fixed | yes |
| aurora/featured-description-contrast | color-contrast | low-contrast | templates/index.json /sections/featured/settings/description_color | 0.96 | correct | fixed | yes |
| aurora/banner-image-alt | image-alt | alt-text-theme-image | sections/image-banner.liquid @104 `<img>` | 0.98 | correct | fixed | yes |
| aurora/newsletter-email-label | label | form-label | sections/footer.liquid @775 `<input>` | 0.99 | correct | fixed | yes |
| aurora/account-link-name | link-name | empty-link | sections/header.liquid @876 `<a>` | 0.98 | correct | fixed | yes |
| aurora/cart-link-name | link-name | empty-link | sections/header.liquid @1303 `<a>` | 0.99 | correct | fixed | yes |
| aurora/menu-toggle-name | button-name | empty-button | sections/header.liquid @37 `<button>` | 0.99 | correct | fixed | yes |
| aurora/social-facebook-name | link-name | empty-link | sections/footer.liquid @1512 `<a>` | 0.98 | correct | fixed | yes |
| aurora/social-instagram-name | link-name | empty-link | sections/footer.liquid @1783 `<a>` | 0.98 | correct | fixed | yes |
| aurora/quantity-minus-name | button-name | empty-button | snippets/quantity-input.liquid @285 `<button>` | 0.98 | correct | fixed | yes |
| aurora/quantity-plus-name | button-name | empty-button | snippets/quantity-input.liquid @566 `<button>` | 0.98 | correct | fixed | yes |
| aurora/quantity-input-label | label | form-label | snippets/quantity-input.liquid @390 `<input>` | 0.98 | correct | fixed | yes |
| aurora/mug-card-link-name | link-name | empty-link | snippets/card-product.liquid @142 `<a>` | 0.94 | correct | refused as expected (`dynamic-content`) | no |
| aurora/cart-remove-link-name | link-name | empty-link | sections/main-cart.liquid @1235 `<a>` | 0.96 | correct | fixed | yes |
| aurora/search-input-label | label | form-label | sections/main-search.liquid @198 `<input>` | 0.99 | correct | fixed | yes |
| aurora/search-button-name | button-name | empty-button | sections/main-search.liquid @291 `<button>` | 0.98 | correct | fixed | yes |
| aurora/article-image-alt | image-alt | rich-text | gid://shopify/Article/3001 body @75 | 0.95 | correct | review (Admin API) | no |
| aurora/login-password-label | label | form-label | sections/main-login.liquid @477 `<input>` | 0.99 | correct | fixed | yes |
| birch/html-lang-empty | html-has-lang | document-language | layout/theme.liquid @16 `<html>` | 0.97 | correct | fixed | yes |
| birch/announcement-contrast | color-contrast | low-contrast | config/settings_data.json /current/color_announcement_text | 0.96 | correct | fixed | yes |
| birch/card-vendor-contrast | color-contrast | low-contrast | assets/theme.css.liquid color @2679 | 0.96 | correct | fixed | yes |
| birch/announcement-close-name | button-name | empty-button | sections/header.liquid @108 `<button>` | 0.98 | correct | fixed | yes |
| birch/header-search-label | label | form-label | sections/header.liquid @833 `<input>` | 0.99 | correct | fixed | yes |
| birch/account-link-name | link-name | empty-link | sections/header.liquid @1012 `<a>` | 0.98 | correct | fixed | yes |
| birch/desktop-cart-link-name | link-name | empty-link | sections/header.liquid @1123 `<a>` | 0.98 | correct | fixed (and its mobile twin) | no (ambiguous mapping) |
| birch/youtube-link-name | link-name | empty-link | snippets/social-icons.liquid @310 `<a>` | 0.96 | correct | fixed | yes |
| birch/payment-visa-alt | image-alt | alt-text-theme-image | sections/footer.liquid @622 `<img>` | 0.99 | correct | refused as expected (`no-image-object`) | no |
| birch/slideshow-prev-name | button-name | empty-button | sections/slideshow.liquid @398 `<button>` | 0.99 | correct | fixed | yes |
| birch/slideshow-next-name | button-name | empty-button | sections/slideshow.liquid @544 `<button>` | 0.99 | correct | fixed | yes |
| birch/card-image-alt | image-alt | alt-text-theme-image | snippets/product-card.liquid @88 `<img>` | 0.99 | correct | fixed | yes |
| birch/collection-hero-alt | image-alt | alt-text-theme-image | sections/collection-template.liquid @55 `<img>` | 0.98 | correct | fixed | yes |
| birch/sort-select-name | select-name | form-label | sections/collection-template.liquid @357 `<select>` | 0.99 | correct | fixed | yes |
| birch/contact-message-label | label | form-label | sections/contact-form.liquid @517 `<textarea>` | 0.99 | correct | fixed | yes |
| birch/btn-focus-outline | rs-focus-indicator-missing | focus-visible | assets/theme.css.liquid outline @755 | 0.95 | correct | not patched (no recipe) | no |
| cedar/password-html-lang | html-has-lang | document-language | layout/password.liquid @16 `<html>` | 0.97 | correct | fixed | yes |
| cedar/password-bypass | bypass | skip-link | layout/password.liquid @259 `<body>` | 0.97 | correct | refused as expected (`main-landmark-not-found`) | no |
| cedar/search-link-name | link-name | empty-link | blocks/search-link.liquid @0 `<a>` | 0.94 | correct | fixed | yes |
| cedar/newsletter-note-contrast | color-contrast | low-contrast | sections/newsletter.liquid color @155 | 0.96 | correct | fixed | yes |
| cedar/story-image-alt | image-alt | alt-text-theme-image | blocks/image.liquid @104 `<img>` | 0.98 | correct | fixed | yes |
| cedar/story-link-in-text | link-in-text-block | other | assets/cedar.css text-decoration @2599 | 0.95 | correct | review | no |
| cedar/carousel-dot-parent | aria-required-parent | widget-roles | sections/carousel.liquid @262 `<button>` | 0.99 | correct | review | no |
| cedar/video-frame-title | frame-title | other | sections/video.liquid @155 `<iframe>` | 0.99 | correct | review | no |
| cedar/variant-listbox-children | aria-required-children | widget-roles | blocks/variant-picker.liquid @225 `<ul>` | 0.96 | correct | review | no |
| cedar/variant-option-listitem | listitem | widget-roles | blocks/variant-picker.liquid @374 `<li>` | 0.94 | correct | review | no |
| cedar/accordion-expanded-value | aria-valid-attr-value | widget-roles | blocks/accordion.liquid @57 `<div>` | 0.99 | correct | review | no |
| cedar/wishlist-button-name | button-name | empty-button | blocks/buy-buttons.liquid @338 `<button>` | 0.96 | correct | fixed | yes |
| cedar/pagination-target-size | target-size | target-size | assets/cedar.css width @3730 | 0.95 | correct | not patched (no recipe) | no |

## Render regressions

The runner found none in any configuration (golden spans without contrast, golden spans with
all recipes, mapper spans with all recipes): after patching, every page of every failing theme
renders, every `<rule>:<outcome>` count equals the count before minus the golden nodes resolved,
and Theme Check reports no new offense in any patched theme (aurora 12 files patched, birch 11,
cedar 7, locales included).

Beyond the contract's measure, the runner compares each page's DOM before and after patching
(ADR-247 point 3): every element, attribute and text of the page before is still there, in the
same order, and the patches only added (attribute values change only where they were blank, or in
`style`). Result: 0 violations on all 17 pages of the three failing themes; the patches added 0 to
7 elements per page (labels, visually hidden names, skip link).

Defects found by tests during the work, and fixed (none reached a green run of the gates as a
regression):

1. **`!important` read as `undefined`.** postcss leaves `Declaration.important` undefined when a
   declaration has no `!important`, despite its typings. A lint cleanup (`d.important === true`
   to `d.important`) made the cascade compare `undefined` with `false`, so an inline style never
   outranked a rule. `test/css-cascade.test.ts` caught it; the fix is `isImportant`
   (`src/map/css/index.ts`), which compares with `true` through a typed cast.
2. **Ambiguous social links** (aurora, two candidates): setting lookups in attribute values
   (`href="{{ settings.social_facebook }}"`) are now compared with the value in
   `config/settings_data.json`, which separates them (ADR-244 point 3).
3. **The mobile copy of a header link** (birch): the mapper maps the desktop link and lists the
   same-file twin as `identical`; the runner applies the same fix to it (ADR-244 point 6).
4. **Layout key.** `layout` of a JSON template may carry `.liquid` and may be `false`
   (shopify.dev); both are handled (`layoutFor`, ADR-243 point 6).
5. **`pnpm add postcss@8.5.31` edited `pnpm-workspace.yaml`** (a minimumReleaseAge exclusion) and
   put a second postcss in the lockfile. Reverted; the lockfile was regenerated through pnpm from
   the merge base. postcss stays 8.5.30 (see integration notes).

## Tests

| Package | Files | Tests | Notes |
| --- | --- | --- | --- |
| `@rampsmith/liquid-patch` | 17 | 256 | line coverage 97.63% (bar 95%), branches 88.8%, functions 97.44% |
| `@rampsmith/corpus-tools` | 11 | 175 | WS-11's 153 pass unchanged; 14 new in `test/runner.test.ts`, 8 in `test/snapshot.test.ts` |

liquid-patch tests added in this stream: contrast colour maths (`color.test.ts` 18,
`candidates.test.ts` 11, `contrast-recipe.test.ts` 15), selector matching (`selector.test.ts` 13),
CSS index and cascade (`css-cascade.test.ts` 17), the theme index and element search
(`theme-index.test.ts` 23), the mapper on the hand-written `tarn` theme (`mapper.test.ts` 32)
and the planner (`plan.test.ts` 12). The 159 tests from before the mapper are unchanged.

The runner tests (`packages/corpus-tools/test/runner.test.ts`):

- no scanner finding without a golden finding, no golden finding that did not fire;
- mapping accuracy at least 0.95 (denominator at least 40), none wrong at 0.9 or more;
- fix rate at least 0.90 overall, and at least 0.90 mapping and fixing in each of the five
  theme-patched top-six categories on its own;
- every expected refusal refuses with its golden code (`unexpected` empty);
- zero regressions, every page rendered after patching;
- no new Theme Check offense, every theme patched;
- the pages after patching keep every element, attribute and text of the pages before (the
  additive DOM check; 0 violations, and the patches did add elements);
- both gates pass;
- the same run without the contrast recipe, on golden spans, lands below the fix-rate bar
  (the gate can fail);
- the records and the report validate against `corpus/schema/runner-records.schema.json` and
  `runner-report.schema.json`; the category table adds up.

## Commands and output

```text
$ pnpm exec prettier --check .
All matched files use Prettier code style!
$ pnpm exec eslint --max-warnings=0 packages/liquid-patch packages/corpus-tools
(no output)
$ pnpm --filter @rampsmith/liquid-patch --filter @rampsmith/corpus-tools run typecheck
$ tsc -p tsconfig.json   (twice, no output)
$ pnpm exec knip | grep packages/(liquid-patch|corpus-tools)
(no output; the remaining knip lines are apps/web's `$app/tsconfig`, which needs svelte-kit sync)
$ node packages/claims-lint/src/main.ts
claims-lint: 13 files scanned, no banned claims
$ node packages/node-pins/src/main.ts
node-pins: every Node.js pin agrees with .mise.toml (ADR-029)

$ pnpm --filter @rampsmith/liquid-patch test
 Test Files  17 passed (17)
      Tests  256 passed (256)
 Statements   : 94.43% ( 2071/2193 )
 Branches     : 88.8% ( 1705/1920 )
 Functions    : 97.44% ( 343/352 )
 Lines        : 97.63% ( 1815/1859 )

$ pnpm --filter @rampsmith/corpus-tools test
 Test Files  11 passed (11)
      Tests  175 passed (175)

$ node packages/corpus-tools/src/cli.ts run
mapping 48/48 correct, 0 wrong above 0.9
fixes 35/35 targeted fixed, 0 regression(s)
gates: mapping pass, fixes pass
report written to test-results/corpus-report.json and test-results/corpus-report.records.json
```

Registry checks (19 Oct 2026, `npm view`): `postcss-selector-parser` 7.1.6 is the latest
(published 3 Sep 2026; dependencies `cssesc`, `util-deprecate`; no peer dependencies); `postcss`
8.5.31 is the latest (published 18 Oct 2026 19:39 UTC) and is held back by pnpm's minimum release
age, so `postcss` stays at 8.5.30. Shopify facts read on shopify.dev are cited in ADR-243 and
ADR-246 (settings_data.json, input settings, stylesheet tag, `.css.liquid` deprecation, JSON
templates, `section` object, Admin API 2026-10 `Article.body`, `Article.summary`, `Page.body`,
`Product.descriptionHtml`, `Collection.descriptionHtml`).

## CI

Pull request #12 (draft) runs the repository's `ci` workflow on every push. Runs on this branch:

| Head | Run | Conclusion |
| --- | --- | --- |
| `e20b335` | https://github.com/billyribeiro-ux/rampsmith/actions/runs/39297475376 | failure: only the `node-pins` step (the two package manifests lacked `engines.node`); ESLint, Prettier, tsc, knip and claims-lint passed |
| `9681dfa` | https://github.com/billyribeiro-ux/rampsmith/actions/runs/39300221517 | pending when this was written; the final head's run is in the closing note |

## ADRs

| ADR | Title |
| --- | --- |
| 241 | No third-party theme fixtures (supersedes ADR-105) |
| 242 | The contrast recipe: smallest OKLCH lightness change, two candidates, colour value edits |
| 243 | Fix targets beyond elements: colour values, CSS declarations and store data |
| 244 | The element mapper and its confidence model (PLAN §12 correction) |
| 245 | Mapping style findings: the CSS cascade, colour values and the declarations behind them |
| 246 | Rich text the theme prints maps to store data |
| 247 | The integrated corpus runner and its gates |
| 248 | The fix planner: from a rule and a mapped span to a recipe |
| 249 | R2 measurement: the engine against the corpus, before and after |

## Integration notes

For the integrator and the owners of the files outside this stream's paths.

1. **`docs/adr/README.md`**: mark ADR-105 "Superseded by ADR-241" and add rows 241 to 249 with
   the titles above.
2. **PLAN corrections** (the exact text is in the ADRs): PLAN §12 "Mapping a rendered element to
   its source" steps 2 and 3 (ADR-244 "Plan correction"); step 5 and the skip-link row are
   ADR-205's. No other PLAN text changed.
3. **Calling the mapper and the recipes** (ADR-248, "Integration"): `new Mapper(files).map(f)`;
   if `mapped` and `confidence >= CONFIDENCE_THRESHOLD`, `planFix` for the span and each
   `identical` span; collect `edits` and `translations`; `localeEdits`; `buildPatch`;
   `validateNoNewOffenses`; rescan. `needs_review` carries candidates for the AI tie-break
   (PLAN §12 step 4); `unmapped` goes to a person. A `data` span is applied through the Admin API,
   never through `buildPatch`. The engine and API packages should import from
   `@rampsmith/liquid-patch`: `Mapper`, `CONFIDENCE_THRESHOLD`, `planFix`, `hasRecipe`, the
   `MapOutcome`/`MappedSpan` types.
4. **The scanner must send what the corpus runner sends**: per result node the tag, attributes,
   collapsed text, ancestors up to `<html>` (each with tag and attributes), the previous siblings
   (nearest first) and the number of following siblings, the axe-core check data (`fgColor`,
   `bgColor`, `fontSize`, `fontWeight`, target `width`/`height`), and, for a page that shows a
   product, collection, page or article, the resource's global id and the HTML of its rich-text
   fields. `packages/corpus-tools/src/browser/check.ts` (the `elements` collected by the page script of
   `runPage`) and `src/runner/nodes.ts` are the reference.
5. **`packages/corpus-tools/src/golden.ts`** still lists `BUILT_RECIPES`, `REFUSAL_CODES` and
   `RECIPES` by hand. Replace them with imports from `@rampsmith/liquid-patch` and update WS-11's
   `test/contract.test.ts`, whose "fails the fix gate with only the recipes liquid-patch ships
   today" test asserts that `contrast` is missing from `BUILT_RECIPES`; it passes now because the
   constant was left as WS-11 wrote it, and would say otherwise once it is imported.
6. **Custom-rule substitution.** `birch/btn-focus-outline` (`rs-focus-indicator-missing`, engine
   `rampsmith-browser`) is not produced by running the rule: `checkPage` takes the elements from
   the golden occurrence selectors, since `@rampsmith/a11y-rules` was not in the workspace for
   WS-11. At integration, replace that with the package's browser check on the rendered page and
   require the same element set (CONTRACT.md check 6), and have the runner's rescan evaluate it so
   `stillFiring` is measured for custom-engine findings (today it is `true` for them, and none is
   targeted).
7. **`pnpm-workspace.yaml`**: postcss 8.5.31 (published 18 Oct 2026) is newer than the minimum
   release age allows; `packages/liquid-patch` pins 8.5.30. Bump it once 8.5.31 is old enough, or
   add the exclusion if the founder wants it earlier (a root manifest, not this stream's).
8. **`.css.liquid`**: the mapper reads such assets (birch uses one) but Shopify stopped
   processing them on 28 Aug 2025 (ADR-243 point 5). The product should warn when a span's file
   ends in `.css.liquid`, because the edit may not change the live store.
9. **CI**: the gate test writes `packages/corpus-tools/test-results/corpus-report.json` (and
   `.records.json`); CI could upload them as a build artifact. The corpus tests need Chromium
   (`scripts/ensure-chromium.ts`), as WS-11's browser test already does.
10. **Manifests**: both package manifests gained `engines.node` (the node-pins check), and
    `@rampsmith/corpus-tools` depends on `@rampsmith/liquid-patch` (`workspace:*`). The lockfile
    changed only through pnpm.
11. **Known limits** (ADR-249): mapper accuracy was measured on the corpus it was written
    against; re-measure on themes written by someone else before trusting 100% elsewhere.
    Parameters (label texts, decorative reasons) come from the golden file in the runner; a
    finding with several contrast nodes uses the first node's background.
