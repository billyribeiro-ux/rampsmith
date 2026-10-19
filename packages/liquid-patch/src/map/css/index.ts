/**
 * The CSS a page loads, as declarations with the offsets of the theme file they came from
 * (ADR-245). Sources: CSS assets and `.css.liquid` assets the layout or a section links through
 * `asset_url`, and the `{% style %}`, `{% stylesheet %}` and `<style>` tags of the layout and of
 * every file the page renders.
 *
 * Liquid inside CSS is replaced with same-length filler before postcss reads it, so every
 * offset in a declaration is an offset in the original file. A declaration whose value holds
 * Liquid keeps its original text, which is how `{{ settings.color }}` is recognised later.
 */
import { NodeTypes, RawTags, walk } from '@shopify/liquid-html-parser';
import postcss, { type AtRule, type ChildNode, type Container, type Declaration } from 'postcss';
import type { ThemeIndex } from '../theme.ts';
import { parseSelectors, type ComplexSelector } from './selector.ts';

export interface CssDeclaration {
  readonly file: string;
  /** Lower case, except custom properties. */
  readonly property: string;
  /** The value as written, without `!important`, trimmed. */
  readonly value: string;
  /** From the property name to the end of the value (`!important` included), without `;`. */
  readonly start: number;
  readonly end: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly important: boolean;
}

export interface CssRule {
  readonly file: string;
  readonly selectorText: string;
  readonly selectors: readonly ComplexSelector[];
  readonly declarations: readonly CssDeclaration[];
  /** Position in the page's load order; later wins at equal specificity. */
  readonly order: number;
  /** True when an at-rule decides whether the rule applies and the viewport did not settle it. */
  readonly conditional: boolean;
}

export interface CssIndex {
  readonly rules: readonly CssRule[];
  /** CSS regions postcss could not read, by file. */
  readonly unparsed: readonly string[];
}

const VIEWPORT_WIDTH = 1280;

/** Replaces `{{ ... }}` and `{% ... %}` with underscores of the same length. */
export function sanitizeLiquid(text: string): string {
  return text.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/gu, (m) => '_'.repeat(m.length));
}

type Tri = 'yes' | 'no' | 'maybe';

function lengthPx(text: string): number | null {
  const m = /^(\d*\.?\d+)(px|em|rem)$/u.exec(text.trim());
  if (m === null) return null;
  return Number(m[1]) * (m[2] === 'px' ? 1 : 16);
}

function mediaApplies(params: string): Tri {
  let result: Tri = 'yes';
  for (const query of params.toLowerCase().split(',')) {
    let one: Tri = 'yes';
    for (const part of query.split(/\s+and\s+/u)) {
      const p = part.trim().replace(/^only\s+/u, '');
      let verdict: Tri = 'maybe';
      if (p === 'screen' || p === 'all') verdict = 'yes';
      else if (p === 'print' || p === 'speech') verdict = 'no';
      else {
        const m = /^\(\s*(min|max)-width\s*:\s*([^)]+)\)$/u.exec(p);
        const limit = m?.[2] === undefined ? null : lengthPx(m[2]);
        if (m !== null && limit !== null) {
          verdict = (m[1] === 'min' ? VIEWPORT_WIDTH >= limit : VIEWPORT_WIDTH <= limit)
            ? 'yes'
            : 'no';
        }
      }
      if (verdict === 'no') one = 'no';
      else if (verdict === 'maybe' && one === 'yes') one = 'maybe';
    }
    if (one === 'yes') return 'yes';
    if (one === 'maybe') result = 'maybe';
    else if (result === 'yes') result = 'no';
  }
  return result;
}

/** Whether the rule's at-rules apply at the scanner's viewport; `no` drops the rule. */
function atRuleContext(rule: Container): Tri | 'skip' {
  let result: Tri = 'yes';
  let parent: Container | undefined = rule.parent as Container | undefined;
  while (parent !== undefined && parent.type !== 'root') {
    if (parent.type === 'atrule') {
      const at = parent as AtRule;
      const name = at.name.toLowerCase();
      if (
        name === 'keyframes' ||
        name.endsWith('-keyframes') ||
        name === 'font-face' ||
        name === 'page'
      ) {
        return 'skip';
      }
      if (name === 'media') {
        const verdict = mediaApplies(at.params);
        if (verdict === 'no') return 'no';
        if (verdict === 'maybe') result = 'maybe';
      } else if (name !== 'layer' && name !== 'supports') {
        result = 'maybe';
      }
    }
    parent = parent.parent as Container | undefined;
  }
  return result;
}

/** postcss leaves `important` undefined (despite its typings) when there is no `!important`. */
export function isImportant(d: Declaration): boolean {
  return (d as { important?: boolean }).important === true;
}

function declarationOf(
  file: string,
  base: number,
  source: string,
  d: Declaration,
): CssDeclaration | null {
  const offset = d.source?.start?.offset;
  if (offset === undefined) return null;
  const raws = d.raws as { between?: string; value?: { raw?: string }; important?: string };
  const start = base + offset;
  const valueStart = start + d.prop.length + (raws.between ?? ':').length;
  const rawValue = raws.value?.raw ?? d.value;
  const valueEnd = valueStart + rawValue.trimEnd().length;
  const end = isImportant(d)
    ? valueEnd + (raws.important ?? ' !important').trimEnd().length
    : valueEnd;
  const text = source.slice(start, end);
  return {
    file,
    property: d.prop.startsWith('--') ? d.prop : d.prop.toLowerCase(),
    value: source.slice(valueStart, valueEnd).trim(),
    start,
    end: start + text.trimEnd().length,
    valueStart,
    valueEnd,
    important: isImportant(d),
  };
}

/** Rules of one CSS region; `offset` is where the region starts in the file. */
function parseRegion(
  file: string,
  fileSource: string,
  offset: number,
  length: number,
  firstOrder: number,
): { rules: CssRule[]; ok: boolean } {
  const original = fileSource.slice(offset, offset + length);
  let root: ReturnType<typeof postcss.parse>;
  try {
    root = postcss.parse(sanitizeLiquid(original));
  } catch {
    return { rules: [], ok: false };
  }
  const rules: CssRule[] = [];
  let order = firstOrder;
  root.walkRules((rule) => {
    const context = atRuleContext(rule);
    if (context === 'skip' || context === 'no') return;
    const declarations: CssDeclaration[] = [];
    rule.each((child: ChildNode) => {
      if (child.type !== 'decl') return;
      const found = declarationOf(file, offset, fileSource, child);
      if (found !== null) declarations.push(found);
    });
    const raw = (rule.raws as { selector?: { raw?: string } }).selector?.raw ?? rule.selector;
    const from = rule.source?.start?.offset ?? 0;
    const selectorText = original.slice(from, from + raw.length);
    rules.push({
      file,
      selectorText: selectorText.replace(/\s+/gu, ' ').trim(),
      selectors: parseSelectors(sanitizeLiquid(selectorText)),
      declarations,
      order,
      conditional: context === 'maybe',
    });
    order += 1;
  });
  return { rules, ok: true };
}

interface Region {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly position: number;
  readonly kind: 'tag' | 'stylesheet' | 'asset';
}

/** The CSS regions of a Liquid file, and the assets it links, with their positions. */
function liquidRegions(
  index: ThemeIndex,
  path: string,
): { regions: Region[]; assets: { name: string; position: number }[]; headerAt: number | null } {
  const regions: Region[] = [];
  const assets: { name: string; position: number }[] = [];
  let headerAt: number | null = null;
  const file = index.liquid(path);
  if (file === null) return { regions, assets, headerAt };
  walk(file.ast, (node) => {
    if (
      node.type === NodeTypes.LiquidRawTag &&
      (node.name === RawTags.style || node.name === RawTags.stylesheet)
    ) {
      regions.push({
        file: path,
        start: node.body.position.start,
        end: node.body.position.end,
        position: node.position.start,
        kind: node.name === RawTags.stylesheet ? 'stylesheet' : 'tag',
      });
    } else if (node.type === NodeTypes.HtmlRawNode && node.name === 'style') {
      regions.push({
        file: path,
        start: node.body.position.start,
        end: node.body.position.end,
        position: node.position.start,
        kind: 'tag',
      });
    } else if (node.type === NodeTypes.LiquidVariableOutput && typeof node.markup !== 'string') {
      const { expression, filters } = node.markup;
      if (
        expression.type === NodeTypes.VariableLookup &&
        expression.name === 'content_for_header'
      ) {
        headerAt = node.position.start;
      }
      if (expression.type === NodeTypes.String && filters.some((f) => f.name === 'asset_url')) {
        assets.push({ name: expression.value, position: node.position.start });
      }
    }
  });
  return { regions, assets, headerAt };
}

/**
 * Builds the CSS index for one page. `layout` is the layout file; `rendered` are the other files
 * the page renders (sections, snippets, blocks), in render order. Load order: the layout's
 * `<style>`/`{% style %}` tags and linked assets in the order they appear, with every
 * `{% stylesheet %}` of the page at `{{ content_for_header }}`, then what sections link or style.
 */
export function buildCssIndex(
  index: ThemeIndex,
  layout: string,
  rendered: readonly string[],
): CssIndex {
  const unparsed: string[] = [];
  const rules: CssRule[] = [];
  let order = 0;
  const add = (file: string, start: number, end: number): void => {
    const source = index.files.get(file) ?? '';
    const parsed = parseRegion(file, source, start, end - start, order);
    if (!parsed.ok) unparsed.push(`${file}[${String(start)}, ${String(end)})`);
    rules.push(...parsed.rules);
    order += parsed.rules.length;
  };
  const addAsset = (name: string): void => {
    for (const candidate of [`assets/${name}`, `assets/${name}.liquid`]) {
      const source = index.files.get(candidate);
      if (
        source !== undefined &&
        (candidate.endsWith('.css') || candidate.endsWith('.css.liquid'))
      ) {
        add(candidate, 0, source.length);
        return;
      }
    }
  };
  const stylesheets = [layout, ...rendered].flatMap((path) =>
    liquidRegions(index, path).regions.filter((r) => r.kind === 'stylesheet'),
  );
  const own = liquidRegions(index, layout);
  const items: { position: number; run: () => void }[] = [];
  for (const region of own.regions) {
    if (region.kind === 'stylesheet') continue;
    items.push({
      position: region.position,
      run: () => {
        add(region.file, region.start, region.end);
      },
    });
  }
  for (const asset of own.assets) {
    items.push({
      position: asset.position,
      run: () => {
        addAsset(asset.name);
      },
    });
  }
  items.push({
    position: own.headerAt ?? -1,
    run: () => {
      for (const region of stylesheets) add(region.file, region.start, region.end);
    },
  });
  items.sort((a, b) => a.position - b.position);
  for (const item of items) item.run();
  for (const path of rendered) {
    const found = liquidRegions(index, path);
    const later = [
      ...found.regions
        .filter((r) => r.kind === 'tag')
        .map((r) => ({
          position: r.position,
          run: () => {
            add(r.file, r.start, r.end);
          },
        })),
      ...found.assets.map((a) => ({
        position: a.position,
        run: () => {
          addAsset(a.name);
        },
      })),
    ].sort((a, b) => a.position - b.position);
    for (const item of later) item.run();
  }
  return { rules, unparsed };
}
