/**
 * A theme's files as the mapper reads them: parsed on first use and cached, plus the two
 * questions about structure that every mapping starts with (ADR-244):
 *
 * - which section instance rendered a section wrapper (`shopify-section-<id>`), from the page's
 *   JSON template, a section group, or a static `{% section %}`;
 * - which files that instance renders: the section, the snippets it renders, and theme blocks.
 */
import { NodeTypes, walk, type LiquidTag } from '@shopify/liquid-html-parser';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { pointerSegments } from '../json.ts';
import { parseThemeFile, type ParsedFile } from '../parse.ts';

export type ThemeFiles = ReadonlyMap<string, string>;

export const SECTION_WRAPPER_PREFIX = 'shopify-section-';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ThemeIndex {
  readonly files: ThemeFiles;
  private readonly liquidCache = new Map<string, ParsedFile | null>();
  private readonly jsonCache = new Map<string, unknown>();

  constructor(files: ThemeFiles) {
    this.files = files;
  }

  /** Theme-relative paths under a directory, sorted. */
  paths(directory: string, extension: string): string[] {
    return [...this.files.keys()]
      .filter((p) => p.startsWith(`${directory}/`) && p.endsWith(extension))
      .sort();
  }

  /** The parsed Liquid file, or `null` when it is missing or does not parse. */
  liquid(path: string): ParsedFile | null {
    const cached = this.liquidCache.get(path);
    if (cached !== undefined) return cached;
    const source = this.files.get(path);
    const parsed = source === undefined ? null : parseThemeFile(path, source);
    const file = parsed?.ok === true ? parsed.file : null;
    this.liquidCache.set(path, file);
    return file;
  }

  /** The value of a theme JSON file (comments allowed), or `undefined` when it is bad. */
  json(path: string): unknown {
    if (this.jsonCache.has(path)) return this.jsonCache.get(path);
    const source = this.files.get(path);
    let value: unknown;
    if (source !== undefined) {
      const errors: ParseError[] = [];
      const parsed: unknown = parseJsonc(source, errors, {
        allowTrailingComma: false,
        disallowComments: false,
      });
      value = errors.length === 0 ? parsed : undefined;
    }
    this.jsonCache.set(path, value);
    return value;
  }
}

interface BlockRef {
  readonly type: string;
  /** RFC 6901 pointer of the block in `SectionInstance.jsonFile`. */
  readonly pointer: string;
}

export interface SectionInstance {
  /** The section type, the file name under `sections/` without `.liquid`. */
  readonly type: string;
  readonly file: string;
  /** The JSON file that holds this instance's settings. */
  readonly jsonFile: string;
  /** Pointer of the instance in `jsonFile`; its settings are at `<pointer>/settings`. */
  readonly pointer: string;
  readonly blocks: readonly BlockRef[];
  /** Where the instance is declared: a template, a section group or a static section. */
  readonly origin: 'template' | 'group' | 'static';
}

function toPointerSegment(segment: string): string {
  return segment.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function collectBlocks(value: unknown, pointer: string, out: BlockRef[]): void {
  if (!isRecord(value)) return;
  const blocks = value['blocks'];
  if (!isRecord(blocks)) return;
  for (const [id, block] of Object.entries(blocks)) {
    if (!isRecord(block)) continue;
    const at = `${pointer}/blocks/${toPointerSegment(id)}`;
    if (typeof block['type'] === 'string') out.push({ type: block['type'], pointer: at });
    collectBlocks(block, at, out);
  }
}

function instancesIn(
  index: ThemeIndex,
  jsonFile: string,
  key: string,
  origin: 'template' | 'group',
): SectionInstance[] {
  const root = index.json(jsonFile);
  if (!isRecord(root)) return [];
  const sections = root['sections'];
  if (!isRecord(sections)) return [];
  const section = sections[key];
  if (!isRecord(section) || typeof section['type'] !== 'string') return [];
  const pointer = `/sections/${toPointerSegment(key)}`;
  const blocks: BlockRef[] = [];
  collectBlocks(section, pointer, blocks);
  return [
    {
      type: section['type'],
      file: `sections/${section['type']}.liquid`,
      jsonFile,
      pointer,
      blocks,
      origin,
    },
  ];
}

/**
 * The section instances a wrapper id can name. A template or group section's wrapper is
 * `shopify-section-<prefix>__<key>`; the prefix is not documented for groups (ADR-205 finding 6),
 * so every `__` is tried as the split and only the key is relied on. A static section's wrapper
 * is `shopify-section-<name>`.
 */
export function sectionInstances(
  index: ThemeIndex,
  wrapperId: string,
  template: string,
): SectionInstance[] {
  const id = wrapperId.startsWith(SECTION_WRAPPER_PREFIX)
    ? wrapperId.slice(SECTION_WRAPPER_PREFIX.length)
    : wrapperId;
  const found: SectionInstance[] = [];
  const groups = index.paths('sections', '.json');
  let split = id.indexOf('__');
  while (split !== -1) {
    const key = id.slice(split + 2);
    found.push(...instancesIn(index, `templates/${template}.json`, key, 'template'));
    for (const group of groups) found.push(...instancesIn(index, group, key, 'group'));
    split = id.indexOf('__', split + 1);
  }
  if (!id.includes('__') && index.files.has(`sections/${id}.liquid`)) {
    found.push({
      type: id,
      file: `sections/${id}.liquid`,
      jsonFile: 'config/settings_data.json',
      pointer: `/current/sections/${toPointerSegment(id)}`,
      blocks: [],
      origin: 'static',
    });
  }
  const seen = new Set<string>();
  return found.filter((i) => {
    const k = `${i.jsonFile}\u0000${i.pointer}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function walkPointer(root: unknown, pointer: string): unknown {
  const segments = pointerSegments(pointer);
  if (segments === null) return undefined;
  let node: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(node)) node = node[Number(segment)];
    else if (isRecord(node)) node = node[segment];
    else return undefined;
  }
  return node;
}

/**
 * The text a plain `settings.x` or `section.settings.x` lookup prints, from the theme's JSON:
 * `current` of `config/settings_data.json` (or the preset it names), or the section instance's
 * settings. `undefined` when the value is not stored there (the schema default applies) or is
 * not text or a number.
 */
export function settingText(
  index: ThemeIndex,
  lookup: string,
  instance: SectionInstance | null,
): string | undefined {
  let settings: unknown;
  let name: string;
  if (lookup.startsWith('settings.')) {
    name = lookup.slice('settings.'.length);
    const data = index.json('config/settings_data.json');
    const current = isRecord(data) ? data['current'] : undefined;
    settings =
      typeof current === 'string' && isRecord(data) && isRecord(data['presets'])
        ? data['presets'][current]
        : current;
  } else if (lookup.startsWith('section.settings.') && instance !== null) {
    name = lookup.slice('section.settings.'.length);
    settings = walkPointer(index.json(instance.jsonFile), `${instance.pointer}/settings`);
  } else {
    return undefined;
  }
  const value = isRecord(settings) ? settings[name] : undefined;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** The layout file a template renders in: its `layout` key, else `theme`. */
export function layoutFor(index: ThemeIndex, template: string): string {
  const root = index.json(`templates/${template}.json`);
  const layout = isRecord(root) ? root['layout'] : undefined;
  return `layout/${typeof layout === 'string' ? layout : 'theme'}.liquid`;
}

export interface Closure {
  /** Files in the order they were reached, the roots first. */
  readonly files: readonly string[];
  /** True when a render, section or block call names its target with a variable. */
  readonly dynamic: boolean;
}

type Markup = LiquidTag['markup'];

interface Literal {
  readonly type?: string;
  readonly value?: string;
}

function asRecord(markup: Markup): Record<string, unknown> | null {
  return typeof markup === 'object' && markup !== null && !Array.isArray(markup)
    ? (markup as unknown as Record<string, unknown>)
    : null;
}

function literalValue(value: unknown): string | null {
  const literal = value as Literal | null | undefined;
  return literal?.type === NodeTypes.String && typeof literal.value === 'string'
    ? literal.value
    : null;
}

/**
 * The string literal a tag's markup holds under `key` (`snippet` of `{% render %}`, `name` of
 * `{% section %}`, `contentForType` of `{% content_for %}`): `null` when it is a variable,
 * `undefined` when the markup has no such part.
 */
function literalAt(
  markup: Markup,
  key: 'snippet' | 'name' | 'contentForType',
): string | null | undefined {
  const record = asRecord(markup);
  if (record === null || !(key in record)) return undefined;
  return literalValue(record[key]);
}

/** A named argument of `{% content_for %}` as a string literal; see {@link literalAt}. */
function contentForArgument(markup: Markup, name: string): string | null | undefined {
  const args = asRecord(markup)?.['args'];
  if (!Array.isArray(args)) return undefined;
  const arg = (args as { name?: string; value?: unknown }[]).find((a) => a.name === name);
  return arg === undefined ? undefined : literalValue(arg.value);
}

/** The group named by `{% sections 'name' %}`, whose markup is the string itself. */
export function sectionsGroupName(markup: Markup): string | null {
  return literalValue(markup);
}

/**
 * The files rendered from `roots`: snippets by `{% render %}` and `{% include %}`, theme blocks
 * by `{% content_for 'block', type: ... %}`, and, with `followSections`, sections by
 * `{% section %}` and section groups by `{% sections %}`. `blockTypes` stand for
 * `{% content_for 'blocks' %}`, whose blocks come from the section's JSON.
 */
export function renderClosure(
  index: ThemeIndex,
  roots: readonly string[],
  options: { readonly blockTypes?: readonly string[]; readonly followSections?: boolean } = {},
): Closure {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  let dynamic = false;
  const add = (path: string): void => {
    if (!seen.has(path) && index.files.has(path)) queue.push(path);
  };
  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    order.push(path);
    const file = index.liquid(path);
    if (file === null) continue;
    walk(file.ast, (node) => {
      if (node.type !== NodeTypes.LiquidTag) return;
      if (node.name === 'render' || node.name === 'include') {
        const snippet = literalAt(node.markup, 'snippet');
        if (typeof snippet === 'string') add(`snippets/${snippet}.liquid`);
        else dynamic = true;
      } else if (node.name === 'content_for') {
        const kind = literalAt(node.markup, 'contentForType');
        if (kind === 'block') {
          const type = contentForArgument(node.markup, 'type');
          if (typeof type === 'string') add(`blocks/${type}.liquid`);
          else dynamic = true;
        } else if (kind === 'blocks') {
          for (const type of options.blockTypes ?? []) add(`blocks/${type}.liquid`);
        } else if (kind === null) {
          dynamic = true;
        }
      } else if (options.followSections === true && node.name === 'section') {
        const name = literalAt(node.markup, 'name');
        if (typeof name === 'string') add(`sections/${name}.liquid`);
        else dynamic = true;
      }
    });
  }
  return { files: order, dynamic };
}
