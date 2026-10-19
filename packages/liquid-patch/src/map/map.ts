/**
 * The source mapper (PLAN §12, "Mapping a rendered element to its source"; ADR-244):
 *
 * 1. a page-wide failure maps to its element in the layout (`<html>` for a missing language,
 *    `<body>` for a missing skip link);
 * 2. otherwise the section wrapper above the element names the section instance (page JSON
 *    template, section group, or static section), hence `sections/<type>.liquid`, the snippets
 *    and theme blocks it renders, and the section's settings;
 * 3. rich text the theme prints maps to the resource and field of store data;
 * 4. else the Liquid AST of those files is searched for the element by tag, static attributes,
 *    class tokens, text and ancestors, with Liquid output as a wildcard;
 * 5. a style failure (contrast, focus outline, target size, link underline) maps to the CSS
 *    declaration or the setting value that produces the style (`styles.ts`).
 *
 * One candidate that agrees on static evidence maps at 0.9 or more; several candidates, or one
 * found only outside the rendered files, never do, and are returned for review.
 */
import { buildCssIndex, type CssIndex } from './css/index.ts';
import {
  searchElements,
  sourceElements,
  type ElementCandidate,
  type Resolver,
} from './elements.ts';
import { mapRichText } from './data.ts';
import { mapDeclaration, mapTextColor, type StyleContext, type StyleTarget } from './styles.ts';
import {
  SECTION_WRAPPER_PREFIX,
  ThemeIndex,
  layoutFor,
  renderClosure,
  sectionInstances,
  sectionsGroupName,
  settingText,
  type Closure,
  type SectionInstance,
  type ThemeFiles,
} from './theme.ts';
import {
  CONFIDENCE_THRESHOLD,
  type ElementSpan,
  type FindingToMap,
  type MapCandidate,
  type MapOutcome,
  type MappedSpan,
} from './types.ts';
import { NodeTypes, walk } from '@shopify/liquid-html-parser';

/** Page-wide rules whose fix is an element of the layout: the tag to find there. */
const LAYOUT_TARGETS: Readonly<Record<string, string>> = {
  'html-has-lang': 'html',
  'html-lang-valid': 'html',
  'html-xml-lang-mismatch': 'html',
  bypass: 'body',
};

const STYLE_RULES: ReadonlySet<string> = new Set([
  'color-contrast',
  'link-in-text-block',
  'target-size',
  'rs-focus-indicator-missing',
]);

function elementConfidence(candidate: ElementCandidate, dynamic: boolean): number {
  const base =
    candidate.points >= 1 ? Math.min(0.99, 0.9 + 0.02 * Math.min(candidate.points, 5)) : 0.75;
  return dynamic && candidate.points < 3 ? Math.min(base, 0.85) : base;
}

function asCandidates(
  list: readonly ElementCandidate[],
  confidence: number,
  why: string,
): MapCandidate[] {
  return list.map((c) => ({
    span: c.span,
    confidence,
    why: `${why}: ${c.reasons.join(', ') || 'tag only'}`,
  }));
}

/** Maps findings on rendered pages of one theme to their source. */
export class Mapper {
  readonly index: ThemeIndex;
  private readonly cssCache = new Map<string, CssIndex>();
  private readonly pageCache = new Map<string, Closure>();

  constructor(files: ThemeFiles) {
    this.index = new ThemeIndex(files);
  }

  map(finding: FindingToMap): MapOutcome {
    const layoutTag = LAYOUT_TARGETS[finding.rule];
    if (layoutTag !== undefined) return this.mapLayout(finding, layoutTag);
    const wrapper = [finding.element, ...finding.element.ancestors].find((n) =>
      n.attributes['id']?.startsWith(SECTION_WRAPPER_PREFIX),
    );
    const wrapperId = wrapper?.attributes['id'];
    const instances =
      wrapperId === undefined ? [] : sectionInstances(this.index, wrapperId, finding.template);
    const scope = this.scopeFiles(finding.template, instances, wrapperId !== undefined);
    const rich = mapRichText(this.index, scope.files, finding);
    if (rich !== null) return rich;
    const instance = instances.length === 1 ? (instances[0] ?? null) : null;
    const element = this.mapElement(finding, scope, instance);
    if (!STYLE_RULES.has(finding.rule)) return element;
    return this.mapStyle(finding, element, instance);
  }

  /** The layout element a page-wide rule is fixed on. */
  private mapLayout(finding: FindingToMap, tag: string): MapOutcome {
    const layout = layoutFor(this.index, finding.template);
    if (layout === null) {
      return { status: 'unmapped', reason: `the ${finding.template} template has no layout` };
    }
    if (this.index.liquid(layout) === null) {
      return { status: 'unmapped', reason: `${layout} is missing or does not parse` };
    }
    const all = sourceElements(this.index, layout).filter((e) => e.info.tag === tag);
    const span = (start: number): ElementSpan => ({ kind: 'element', file: layout, start, tag });
    const [only] = all;
    if (all.length === 1 && only !== undefined) {
      return {
        status: 'mapped',
        span: span(only.start),
        confidence: 0.97,
        why: [`${layout} has one <${tag}> and the rule ${finding.rule} is fixed there`],
      };
    }
    return {
      status: 'needs_review',
      reason: `${layout} has ${String(all.length)} <${tag}> elements`,
      candidates: all.map((e) => ({
        span: span(e.start),
        confidence: 0.5,
        why: `a <${tag}> of ${layout}`,
      })),
    };
  }

  /** The files the element can come from, and whether any render call was too dynamic to follow. */
  private scopeFiles(
    template: string,
    instances: readonly SectionInstance[],
    inSection: boolean,
  ): Closure {
    if (!inSection) {
      const layout = layoutFor(this.index, template);
      return layout === null ? { files: [], dynamic: false } : renderClosure(this.index, [layout]);
    }
    const roots = instances.map((i) => i.file);
    const blockTypes = instances.flatMap((i) => i.blocks.map((b) => b.type));
    if (roots.length === 0) return { files: [], dynamic: false };
    return renderClosure(this.index, roots, { blockTypes });
  }

  private mapElement(
    finding: FindingToMap,
    scope: Closure,
    instance: SectionInstance | null,
  ): MapOutcome {
    const { element } = finding;
    const resolve: Resolver = (lookup) => settingText(this.index, lookup, instance);
    let found = searchElements(this.index, scope.files, element, resolve);
    // The theme's JSON may disagree with what was rendered (a market override, an edit since):
    // look again with every setting lookup as a wildcard, and trust the answer less.
    let lenient = false;
    if (found.matched.length === 0) {
      found = searchElements(this.index, scope.files, element);
      lenient = found.matched.length > 0;
    }
    const [one] = found.matched;
    if (found.matched.length === 1 && one !== undefined) {
      const confidence = lenient
        ? Math.min(0.85, elementConfidence(one, scope.dynamic))
        : elementConfidence(one, scope.dynamic);
      const same = JSON.stringify(
        sourceElements(this.index, one.span.file).find((e) => e.start === one.span.start)?.info,
      );
      const identical = found.elsewhere
        .filter(
          (c) =>
            c.span.file === one.span.file &&
            JSON.stringify(
              sourceElements(this.index, c.span.file).find((e) => e.start === c.span.start)?.info,
            ) === same,
        )
        .map((c) => c.span);
      return {
        status: 'mapped',
        span: one.span,
        confidence,
        why: [
          `the only <${element.tag}> in ${String(scope.files.length)} rendered file(s) that fits: ${one.reasons.join(', ') || 'tag only'}`,
        ],
        ...(identical.length > 0 ? { identical } : {}),
      };
    }
    if (found.matched.length > 1) {
      return {
        status: 'needs_review',
        reason: `${String(found.matched.length)} elements fit the rendered <${element.tag}>`,
        candidates: asCandidates(found.matched, 0.5, 'fits'),
      };
    }
    const everything = [
      ...this.index.paths('layout', '.liquid'),
      ...this.index.paths('sections', '.liquid'),
      ...this.index.paths('blocks', '.liquid'),
      ...this.index.paths('snippets', '.liquid'),
    ];
    const wider = searchElements(this.index, everything, element);
    if (wider.matched.length > 0) {
      return {
        status: 'needs_review',
        reason: `${String(wider.matched.length)} element(s) fit, but outside the files this page renders`,
        candidates: asCandidates(wider.matched, 0.6, 'outside the rendered files'),
      };
    }
    return { status: 'unmapped', reason: `no source element fits the rendered <${element.tag}>` };
  }

  private mapStyle(
    finding: FindingToMap,
    element: MapOutcome,
    instance: SectionInstance | null,
  ): MapOutcome {
    const source: ElementSpan | null =
      element.status === 'mapped' &&
      element.confidence >= CONFIDENCE_THRESHOLD &&
      element.span.kind === 'element'
        ? element.span
        : null;
    const context: StyleContext = {
      index: this.index,
      css: this.cssFor(finding.template),
      finding,
      chain: [finding.element, ...finding.element.ancestors],
      instance,
      source,
    };
    const target: StyleTarget | null =
      finding.rule === 'color-contrast' ? mapTextColor(context) : mapDeclaration(context);
    if (target === null)
      return { status: 'unmapped', reason: `no style mapper for ${finding.rule}` };
    if (!target.ok) {
      return { status: 'needs_review', reason: target.reason, candidates: [] };
    }
    const span: MappedSpan = target.span;
    if (target.confidence < CONFIDENCE_THRESHOLD) {
      return {
        status: 'needs_review',
        reason: target.why.join('; '),
        candidates: [{ span, confidence: target.confidence, why: target.why.join('; ') }],
      };
    }
    return {
      status: 'mapped',
      span,
      confidence: target.confidence,
      why: target.why,
      ...(source === null ? {} : { rendersFrom: source }),
    };
  }

  /** Every file the page renders: the layout, its section groups, the template's sections. */
  private pageFiles(template: string): Closure {
    const cached = this.pageCache.get(template);
    if (cached !== undefined) return cached;
    const layout = layoutFor(this.index, template);
    const roots = layout === null ? [] : [layout];
    const blockTypes: string[] = [];
    const addInstances = (jsonFile: string): void => {
      const json = this.index.json(jsonFile);
      const sections =
        typeof json === 'object' && json !== null
          ? (json as Record<string, unknown>)['sections']
          : undefined;
      if (typeof sections !== 'object' || sections === null) return;
      for (const key of Object.keys(sections)) {
        for (const i of sectionInstances(this.index, `x__${key}`, template)) {
          if (i.jsonFile === jsonFile) {
            roots.push(i.file);
            blockTypes.push(...i.blocks.map((b) => b.type));
          }
        }
      }
    };
    addInstances(`templates/${template}.json`);
    const file = layout === null ? null : this.index.liquid(layout);
    if (file !== null) {
      walk(file.ast, (node) => {
        if (node.type === NodeTypes.LiquidTag && node.name === 'sections') {
          const group = sectionsGroupName(node.markup);
          if (group !== null) addInstances(`sections/${group}.json`);
        }
      });
    }
    const closure = renderClosure(this.index, roots, { blockTypes, followSections: true });
    this.pageCache.set(template, closure);
    return closure;
  }

  private cssFor(template: string): CssIndex {
    const cached = this.cssCache.get(template);
    if (cached !== undefined) return cached;
    const page = this.pageFiles(template);
    const layout = layoutFor(this.index, template);
    const css = buildCssIndex(
      this.index,
      layout ?? '',
      page.files.filter((f) => f !== layout),
    );
    this.cssCache.set(template, css);
    return css;
  }
}
