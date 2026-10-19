/**
 * Mapping findings whose cause is a style rather than markup (ADR-245): low text contrast
 * (a colour setting or a CSS colour), a removed focus outline, a small target, a link that
 * lost its underline. Each finds the one declaration or setting value that produces the
 * failing style, by running the cascade on the source CSS and following the value to where it
 * is set: through `var(--x)` to the custom property, through `{{ settings.x }}` or
 * `{{ section.settings.x }}` to the value in the theme JSON.
 */
import { NodeTypes } from '@shopify/liquid-html-parser';
import postcss from 'postcss';
import { parseColor, type Rgb } from '../color/color.ts';
import { findAttribute, elementAt } from '../html.ts';
import { locateJsonValue } from '../json.ts';
import type { CssDeclarationSpan } from '../recipes/contrast.ts';
import { cascade, type Cascade } from './css/cascade.ts';
import { sanitizeLiquid, type CssDeclaration, type CssIndex } from './css/index.ts';
import type { MatchOptions } from './css/selector.ts';
import type { SectionInstance, ThemeIndex } from './theme.ts';
import type { ElementSpan, FindingToMap, MappedJsonValue, RenderedNode } from './types.ts';

export interface StyleContext {
  readonly index: ThemeIndex;
  readonly css: CssIndex;
  readonly finding: FindingToMap;
  /** `[element, parent, ...]`. */
  readonly chain: readonly RenderedNode[];
  /** The section instance that rendered the element, when it is unique. */
  readonly instance: SectionInstance | null;
  /** The element's own source, when it was mapped: its `style` attribute is read from there. */
  readonly source: ElementSpan | null;
}

export type StyleTarget =
  | {
      readonly ok: true;
      readonly span: CssDeclarationSpan | MappedJsonValue;
      /** Lower when the cascade left doubt or the colour did not match what was measured. */
      readonly confidence: number;
      readonly why: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly confidence: number };

const SETTINGS_FILE = 'config/settings_data.json';
const SETTING_OUTPUT =
  /^\{\{-?\s*(settings|section\.settings)\.([A-Za-z_][A-Za-z0-9_]*)\s*-?\}\}$/u;
const CUSTOM_PROPERTY = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]+?))?\s*\)$/u;

/** The declarations of the source element's `style` attribute, with file offsets. */
function inlineDeclarations(index: ThemeIndex, source: ElementSpan | null): CssDeclaration[] {
  if (source === null) return [];
  const file = index.liquid(source.file);
  const located = file === null ? null : elementAt(file.ast, source.start);
  if (file === null || located === null) return [];
  const found = findAttribute(located.node, 'style');
  if (found === null || found.conditional || found.attr.type === NodeTypes.AttrEmpty) return [];
  const { start, end } = found.attr.attributePosition;
  const text = file.source.slice(start, end);
  let root: ReturnType<typeof postcss.parse>;
  try {
    root = postcss.parse(`x{${sanitizeLiquid(text)}}`);
  } catch {
    return [];
  }
  const out: CssDeclaration[] = [];
  root.walkDecls((d) => {
    const at = d.source?.start?.offset;
    if (at === undefined) return;
    const raws = d.raws as { between?: string };
    const from = start + at - 2;
    const valueStart = from + d.prop.length + (raws.between ?? ':').length;
    const valueEnd = valueStart + d.value.trimEnd().length;
    out.push({
      file: source.file,
      property: d.prop.toLowerCase(),
      value: file.source.slice(valueStart, valueEnd).trim(),
      start: from,
      end: valueEnd,
      valueStart,
      valueEnd,
      important: d.important,
    });
  });
  return out;
}

function spanOf(decl: CssDeclaration): CssDeclarationSpan {
  return {
    kind: 'css-declaration',
    file: decl.file,
    property: decl.property,
    start: decl.start,
    end: decl.end,
  };
}

type Setting =
  | { readonly ok: true; readonly span: MappedJsonValue; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/** Where a `settings.x` or `section.settings.x` value is stored, and what it holds. */
function settingValue(
  ctx: StyleContext,
  scope: 'settings' | 'section.settings',
  name: string,
): Setting {
  let file = SETTINGS_FILE;
  let base: string;
  if (scope === 'settings') {
    const root = ctx.index.json(SETTINGS_FILE);
    const current =
      typeof root === 'object' && root !== null
        ? (root as Record<string, unknown>)['current']
        : undefined;
    base =
      typeof current === 'string'
        ? `/presets/${current.replace(/~/gu, '~0').replace(/\//gu, '~1')}`
        : '/current';
  } else {
    if (ctx.instance === null) return { ok: false, reason: 'the section instance is not known' };
    file = ctx.instance.jsonFile;
    base = `${ctx.instance.pointer}/settings`;
  }
  const source = ctx.index.files.get(file);
  if (source === undefined) return { ok: false, reason: `${file} is not in the theme` };
  const pointer = `${base}/${name}`;
  const found = locateJsonValue(source, pointer);
  if (found?.type !== 'string' || typeof found.value !== 'string') {
    return { ok: false, reason: `${pointer} is not set to a colour in ${file}` };
  }
  return {
    ok: true,
    span: { kind: 'json-value', file, pointer, start: found.start, end: found.end },
    value: found.value,
  };
}

interface Resolved {
  readonly span: CssDeclarationSpan | MappedJsonValue;
  readonly colour: string;
  readonly uncertain: boolean;
  readonly why: readonly string[];
}

function resolveColor(
  ctx: StyleContext,
  chain: readonly RenderedNode[],
  inline: readonly CssDeclaration[] | undefined,
  property: string,
  depth: number,
): Resolved | string {
  if (depth > 6) return 'var() chain is too deep';
  const found = cascade(ctx.css, chain, [property], {
    inherited: true,
    ...(inline === undefined ? {} : { inline }),
  });
  const win = found.winner;
  if (win === null) return `no author rule sets ${property} for this element`;
  const decl = win.declaration;
  const where = win.rule?.selectorText ?? 'the style attribute';
  const why = [`${property}: ${decl.value} from ${where} in ${decl.file}`];
  const uncertain = found.uncertain || win.match === 'maybe';
  const value = decl.value;
  const literal = parseColor(value);
  if (literal !== null) {
    if (literal.alpha !== 1) return `${value} is not opaque`;
    return { span: spanOf(decl), colour: value, uncertain, why };
  }
  const variable = CUSTOM_PROPERTY.exec(value);
  if (variable?.[1] !== undefined) {
    const inner = resolveColor(ctx, chain.slice(found.level), undefined, variable[1], depth + 1);
    if (typeof inner !== 'string')
      return { ...inner, uncertain: inner.uncertain || uncertain, why: [...why, ...inner.why] };
    const fallback = variable[2];
    if (fallback !== undefined && parseColor(fallback) !== null) {
      return `${variable[1]} is not set and the fallback ${fallback} is in the var() itself`;
    }
    return inner;
  }
  const output = SETTING_OUTPUT.exec(value);
  if (output?.[1] !== undefined && output[2] !== undefined) {
    const setting = settingValue(ctx, output[1] as 'settings' | 'section.settings', output[2]);
    if (!setting.ok) return setting.reason;
    const parsed = parseColor(setting.value);
    if (parsed?.alpha !== 1) return `${setting.value} is not one opaque colour`;
    return {
      span: setting.span,
      colour: setting.value,
      uncertain,
      why: [
        ...why,
        `${output[1]}.${output[2]} is ${setting.value} at ${setting.span.pointer} in ${setting.span.file}`,
      ],
    };
  }
  return `"${value}" is neither a colour, a var() nor one setting`;
}

function sameColour(a: Rgb, b: Rgb): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/**
 * Where the text colour of the element is set (WCAG 1.4.3): the setting or the CSS declaration
 * whose value is the colour the scanner measured. A declaration whose colour differs from the
 * measured one (opacity, a blended colour) is not the cause alone, so confidence drops.
 */
export function mapTextColor(ctx: StyleContext): StyleTarget {
  const inline = ctx.source === null ? undefined : inlineDeclarations(ctx.index, ctx.source);
  const resolved = resolveColor(ctx, ctx.chain, inline, 'color', 0);
  if (typeof resolved === 'string') return { ok: false, reason: resolved, confidence: 0.3 };
  const why = [...resolved.why];
  let confidence = 0.96;
  const measured = ctx.finding.evidence?.foreground;
  const parsedMeasured = measured === undefined ? null : parseColor(measured);
  const parsedColour = parseColor(resolved.colour);
  if (parsedMeasured !== null && parsedColour !== null) {
    if (sameColour(parsedMeasured.rgb, parsedColour.rgb)) {
      why.push(`${resolved.colour} is the colour the scanner measured`);
    } else {
      why.push(`${resolved.colour} differs from the measured ${measured ?? ''}`);
      confidence = 0.55;
    }
  } else {
    confidence = Math.min(confidence, 0.85);
    why.push('the measured colour was not given');
  }
  if (resolved.uncertain) {
    confidence = Math.min(confidence, 0.8);
    why.push('another rule might apply');
  }
  return { ok: true, span: resolved.span, confidence, why };
}

interface DeclarationFinder {
  readonly properties: readonly string[];
  readonly inherited: boolean;
  readonly match?: MatchOptions;
  /** Whether the winning declaration is the cause of the finding. */
  readonly causes: (decl: CssDeclaration, ctx: StyleContext) => boolean;
  readonly describe: string;
}

const SMALL_PX = (value: string): boolean => {
  const m = /^(\d*\.?\d+)px$/u.exec(value.trim());
  return m !== null && Number(m[1]) < 24;
};

const OUTLINE_REMOVED = (value: string): boolean => /^(?:0|0px|none)(?:\s|$)/iu.test(value.trim());

/** What the evidence says about which dimension of a target is too small. */
function smallDimension(ctx: StyleContext): 'width' | 'height' {
  const { width, height } = ctx.finding.evidence ?? {};
  if (width !== undefined && width >= 24 && height !== undefined && height < 24) return 'height';
  return 'width';
}

function finderFor(ctx: StyleContext): DeclarationFinder | null {
  switch (ctx.finding.rule) {
    case 'rs-focus-indicator-missing':
      return {
        properties: ['outline', 'outline-style', 'outline-width'],
        inherited: false,
        match: { focus: true },
        causes: (d) => OUTLINE_REMOVED(d.value),
        describe: 'the focus outline is removed',
      };
    case 'link-in-text-block':
      return {
        properties: ['text-decoration', 'text-decoration-line'],
        inherited: false,
        causes: (d) => /\bnone\b/iu.test(d.value),
        describe: 'the link has no underline',
      };
    case 'target-size': {
      const dimension = smallDimension(ctx);
      return {
        properties: [dimension],
        inherited: false,
        causes: (d) => SMALL_PX(d.value),
        describe: `the target's ${dimension} is under 24px`,
      };
    }
    default:
      return null;
  }
}

/** The declaration behind a style finding other than text colour; `null` when the rule has none. */
export function mapDeclaration(ctx: StyleContext): StyleTarget | null {
  const finder = finderFor(ctx);
  if (finder === null) return null;
  const inline = ctx.source === null ? undefined : inlineDeclarations(ctx.index, ctx.source);
  const found: Cascade = cascade(ctx.css, ctx.chain, finder.properties, {
    inherited: finder.inherited,
    ...(finder.match === undefined ? {} : { match: finder.match }),
    ...(inline === undefined ? {} : { inline }),
  });
  const win = found.winner;
  if (win === null) {
    return {
      ok: false,
      reason: `no author rule sets ${finder.properties.join(' or ')}`,
      confidence: 0.3,
    };
  }
  if (!finder.causes(win.declaration, ctx)) {
    return {
      ok: false,
      reason: `${win.declaration.property}: ${win.declaration.value} does not explain the finding`,
      confidence: 0.3,
    };
  }
  const why = [
    `${finder.describe}: ${win.declaration.property}: ${win.declaration.value} in ${win.rule?.selectorText ?? 'the style attribute'} (${win.declaration.file})`,
  ];
  let confidence = 0.95;
  if (found.uncertain || win.match === 'maybe') {
    confidence = 0.8;
    why.push('another rule might apply');
  }
  return { ok: true, span: spanOf(win.declaration), confidence, why };
}
