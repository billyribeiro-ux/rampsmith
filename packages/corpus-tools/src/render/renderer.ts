// Static rendering of a theme page with liquidjs 10.30.0 and a Shopify shim (ADR-202): JSON
// templates and section groups, section wrappers, static sections, theme blocks, the tags
// `schema`, `stylesheet`, `javascript`, `style`, `form`, `paginate`, `section`, `sections` and
// `content_for`, and the storefront filters the corpus themes use. It renders what a
// storefront would serve for the page's HTML; it is not Shopify's renderer.
import {
  Drop,
  Hash,
  Liquid,
  Tag,
  filters as builtinFilters,
  type Context,
  type Emitter,
  type FS,
  type Parser,
  type TagToken,
  type Template,
  type TopLevelToken,
} from 'liquidjs';
import { sectionSchema, themeFile, themeJson, type Theme } from './theme.ts';
import type { LiquidObject, StoreObjects } from './store.ts';

/** One page of a theme: which JSON template, at which path, showing which resource. */
export interface PageSpec {
  readonly id: string;
  readonly template: string;
  readonly path: string;
  readonly resource?: {
    readonly type: 'product' | 'collection' | 'page' | 'article' | 'blog';
    readonly handle: string;
  };
}

/** The date `'now'` stands for, so renders never change with the clock. */
export const FIXED_NOW = new Date('2026-10-17T12:00:00Z');
export const ASSET_PREFIX = '/cdn/shop/t/1/assets/';
export const FILES_PREFIX = '/cdn/shop/files/';
const HEADER_PLACEHOLDER = '<!--corpus:content_for_header-->';

/** FNV-1a, 32 bits: deterministic numeric ids for template and group sections. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** `1234567` cents → `12,345.67`. */
export function formatAmount(cents: number): string {
  const [whole = '0', fraction = '00'] = (cents / 100).toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** A Shopify handle: lower case, runs of other characters become one hyphen. */
export function handleize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} must be a JSON object`);
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} must be a string`);
  return value;
}

function asStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) {
    throw new Error(`${what} must be an array of strings`);
  }
  return value;
}

/** The URL `image_url` returns, carrying the image so `image_tag` can read its alt and size. */
class ImageUrl extends Drop {
  readonly url: string;
  readonly image: LiquidObject;
  readonly width: number | null;
  constructor(url: string, image: LiquidObject, width: number | null) {
    super();
    this.url = url;
    this.image = image;
    this.width = width;
  }
  override valueOf(): string {
    return this.url;
  }
  override toString(): string {
    return this.url;
  }
}

/** Keyword arguments arrive from liquidjs as `[name, value]` pairs. */
function keywordArgs(args: readonly unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) {
    if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string') {
      out[arg[0]] = arg[1] as unknown;
    }
  }
  return out;
}

function lookupPath(root: unknown, key: string): unknown {
  let node = root;
  for (const part of key.split('.')) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return node;
}

interface SectionData {
  readonly type: string;
  readonly settings?: Record<string, unknown>;
  readonly blocks?: Record<string, unknown>;
  readonly block_order?: readonly string[];
  readonly disabled?: boolean;
}

function sectionData(value: unknown, what: string): SectionData {
  const record = asRecord(value, what);
  return {
    type: asString(record['type'], `${what}.type`),
    ...(isRecord(record['settings']) ? { settings: record['settings'] } : {}),
    ...(isRecord(record['blocks']) ? { blocks: record['blocks'] } : {}),
    ...(record['block_order'] === undefined
      ? {}
      : { block_order: asStringArray(record['block_order'], `${what}.block_order`) }),
    ...(record['disabled'] === true ? { disabled: true } : {}),
  };
}

/** Parses a JSON template's `wrapper`, such as `div#id.class[data-x=1]` (shopify.dev). */
export function parseWrapper(wrapper: string): { open: string; close: string } {
  const match = /^(div|main|section)((?:[#.][\w-]+|\[[^\]]+\])*)$/.exec(wrapper);
  if (match === null) throw new Error(`unsupported template wrapper "${wrapper}"`);
  const tag = match[1] ?? 'div';
  const parts = match[2] ?? '';
  const ids = [...parts.matchAll(/#([\w-]+)/g)].map((m) => m[1] ?? '');
  const classes = [...parts.matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? '');
  const attrs = [...parts.matchAll(/\[([\w-]+)=([^\]]*)\]/g)].map(
    (m) => ` ${m[1] ?? ''}="${escapeHtml(m[2] ?? '')}"`,
  );
  const id = ids.length > 0 ? ` id="${ids.join(' ')}"` : '';
  const cls = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
  return { open: `<${tag}${id}${cls}${attrs.join('')}>`, close: `</${tag}>` };
}

export class ThemeRenderer {
  readonly theme: Theme;
  readonly store: StoreObjects;
  private readonly engine: Liquid;
  private readonly translations: Record<string, unknown>;
  private readonly settings: Record<string, unknown>;
  private readonly stylesheets: string;
  private globals: Record<string, unknown> = {};

  constructor(theme: Theme, store: StoreObjects) {
    this.theme = theme;
    this.store = store;
    this.engine = this.createEngine();
    this.translations = this.loadTranslations();
    this.settings = this.resolveGlobalSettings();
    this.stylesheets = this.collectStylesheets();
  }

  // ---------------------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------------------

  /** Renders a page's full HTML document. */
  renderPage(spec: PageSpec): string {
    this.globals = this.pageGlobals(spec);
    const path = `templates/${spec.template}.json`;
    const template = asRecord(themeJson(this.theme, path), path);
    const sections = asRecord(template['sections'], `${path} sections`);
    const order = asStringArray(template['order'], `${path} order`);
    const prefix = `template--${String(fnv1a(`${this.theme.name}/${spec.template}`))}`;
    let body = '';
    order.forEach((key, index) => {
      const data = sectionData(sections[key], `${path} sections.${key}`);
      if (data.disabled === true) return;
      body += this.renderSection(data, `${prefix}__${key}`, 'template', index);
    });
    if (typeof template['wrapper'] === 'string') {
      const { open, close } = parseWrapper(template['wrapper']);
      body = `${open}${body}${close}`;
    }
    const layout = template['layout'];
    if (layout === false) return body;
    const layoutName = typeof layout === 'string' ? layout : 'theme';
    const html = this.renderLiquid(`layout/${layoutName}.liquid`, {
      content_for_layout: body,
      content_for_header: HEADER_PLACEHOLDER,
    });
    const head =
      this.stylesheets === ''
        ? ''
        : `<style data-corpus="stylesheet-tags">\n${this.stylesheets}</style>`;
    return html.replace(HEADER_PLACEHOLDER, head);
  }

  /** An asset as the storefront serves it; `.css.liquid` and `.js.liquid` are rendered. */
  renderAsset(name: string): { body: string; contentType: string } | null {
    const types: Record<string, string> = {
      css: 'text/css; charset=utf-8',
      js: 'text/javascript; charset=utf-8',
      svg: 'image/svg+xml',
    };
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const contentType = types[ext];
    if (contentType === undefined) return null;
    const plain = this.theme.files.get(`assets/${name}`);
    if (plain !== undefined) return { body: plain, contentType };
    const liquidPath = `assets/${name}.liquid`;
    if (!this.theme.files.has(liquidPath)) return null;
    return { body: this.renderLiquid(liquidPath, {}), contentType };
  }

  private pageGlobals(spec: PageSpec): Record<string, unknown> {
    const s = this.store;
    const pageType = spec.template.split('.')[0] ?? spec.template;
    const globals: Record<string, unknown> = {
      shop: s.shop,
      settings: this.settings,
      routes: s.routes,
      linklists: s.linklists,
      collections: Object.fromEntries(s.collections),
      pages: Object.fromEntries(s.pages),
      blogs: Object.fromEntries(s.blogs),
      all_products: Object.fromEntries(s.products),
      cart: s.cart,
      customer: null,
      request: {
        locale: s.locale,
        page_type: pageType,
        path: spec.path,
        host: lookupPath(s.shop, 'domain'),
        design_mode: false,
        visual_preview_mode: false,
      },
      localization: { language: s.locale, available_languages: [s.locale] },
      template: {
        name: pageType.replace(/^customers\//, ''),
        suffix: spec.template.includes('.') ? (spec.template.split('.')[1] ?? null) : null,
        directory: spec.template.startsWith('customers/') ? 'customers' : null,
      },
      canonical_url: `${String(lookupPath(s.shop, 'url'))}${spec.path}`,
      page_description: lookupPath(s.shop, 'description'),
      current_page: 1,
    };
    let title = String(lookupPath(s.shop, 'name'));
    const resource = spec.resource;
    if (resource !== undefined) {
      const found = this.resource(resource.type, resource.handle);
      title = String(found.object['title']);
      Object.assign(globals, found.globals);
    }
    if (pageType === 'search') {
      globals['search'] = s.search;
      title = `Search: ${String(lookupPath(s.search, 'results_count'))} results found for "${String(lookupPath(s.search, 'terms'))}"`;
    }
    if (pageType === 'cart') title = 'Your Shopping Cart';
    if (pageType === 'customers/login') title = 'Account';
    if (pageType === 'password') title = String(lookupPath(s.shop, 'name'));
    globals['page_title'] = title;
    return globals;
  }

  private resource(
    type: NonNullable<PageSpec['resource']>['type'],
    handle: string,
  ): { object: LiquidObject; globals: Record<string, unknown> } {
    const missing = (): never => {
      throw new Error(`fixture ${type} "${handle}" does not exist`);
    };
    switch (type) {
      case 'product': {
        const object = this.store.products.get(handle) ?? missing();
        return { object, globals: { product: object } };
      }
      case 'collection': {
        const object = this.store.collections.get(handle) ?? missing();
        return { object, globals: { collection: object } };
      }
      case 'page': {
        const object = this.store.pages.get(handle) ?? missing();
        return { object, globals: { page: object } };
      }
      case 'blog': {
        const object = this.store.blogs.get(handle) ?? missing();
        return { object, globals: { blog: object } };
      }
      case 'article': {
        const [blogHandle = '', articleHandle = ''] = handle.split('/');
        const blog = this.store.blogs.get(blogHandle) ?? missing();
        const articles = blog['articles'] as readonly LiquidObject[];
        const object = articles.find((a) => a['handle'] === articleHandle) ?? missing();
        return { object, globals: { blog, article: object } };
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Sections and blocks
  // ---------------------------------------------------------------------------------------

  private renderSection(
    data: SectionData,
    id: string,
    location: string,
    index: number | null,
  ): string {
    const path = `sections/${data.type}.liquid`;
    const source = themeFile(this.theme, path);
    const schema = sectionSchema(source) ?? {};
    const settings = this.resolveSettings(schema['settings'], data.settings ?? {}, path);
    const blockSchemas = Array.isArray(schema['blocks']) ? (schema['blocks'] as unknown[]) : [];
    const blocks = this.buildBlocks(data.blocks ?? {}, data.block_order, blockSchemas, path);
    const section = {
      id,
      settings,
      blocks,
      location,
      index: index === null ? null : index + 1,
      index0: index,
    };
    const inner = this.renderLiquid(path, { section, __parent: section });
    const tag = typeof schema['tag'] === 'string' ? schema['tag'] : 'div';
    if (!['article', 'aside', 'div', 'footer', 'header', 'section'].includes(tag)) {
      throw new Error(`${path}: schema tag "${tag}" is not one Shopify accepts`);
    }
    const cls = typeof schema['class'] === 'string' ? ` ${schema['class']}` : '';
    return `<${tag} id="shopify-section-${id}" class="shopify-section${cls}">${inner}</${tag}>`;
  }

  private buildBlocks(
    blocks: Record<string, unknown>,
    order: readonly string[] | undefined,
    schemas: readonly unknown[],
    owner: string,
  ): LiquidObject[] {
    const ids = order ?? Object.keys(blocks);
    return ids.map((blockId) => {
      const raw = asRecord(blocks[blockId], `${owner} block ${blockId}`);
      const type = asString(raw['type'], `${owner} block ${blockId}.type`);
      const local = schemas.find((s) => isRecord(s) && s['type'] === type);
      const themeBlockPath = `blocks/${type}.liquid`;
      let schemaSettings: unknown = isRecord(local) ? local['settings'] : undefined;
      let childSchemas: readonly unknown[] = [];
      if (local === undefined && this.theme.files.has(themeBlockPath)) {
        const blockSchema = sectionSchema(themeFile(this.theme, themeBlockPath)) ?? {};
        schemaSettings = blockSchema['settings'];
        childSchemas = Array.isArray(blockSchema['blocks'])
          ? (blockSchema['blocks'] as unknown[])
          : [];
      }
      const settings = this.resolveSettings(
        schemaSettings,
        isRecord(raw['settings']) ? raw['settings'] : {},
        `${owner} block ${blockId}`,
      );
      const children = isRecord(raw['blocks'])
        ? this.buildBlocks(
            raw['blocks'],
            raw['block_order'] === undefined
              ? undefined
              : asStringArray(raw['block_order'], 'block_order'),
            childSchemas,
            `${owner} block ${blockId}`,
          )
        : [];
      return { id: blockId, type, settings, blocks: children, shopify_attributes: '' };
    });
  }

  private renderThemeBlock(
    block: LiquidObject,
    section: unknown,
    params: Record<string, unknown>,
  ): string {
    const path = `blocks/${String(block['type'])}.liquid`;
    return this.renderLiquid(path, { ...params, section, block, __parent: block });
  }

  private renderGroup(group: string): string {
    const path = `sections/${group}.json`;
    const json = asRecord(themeJson(this.theme, path), path);
    const sections = asRecord(json['sections'], `${path} sections`);
    const order = asStringArray(json['order'], `${path} order`);
    const type = asString(json['type'], `${path} type`);
    const prefix = `sections--${String(fnv1a(`${this.theme.name}/${group}`))}`;
    return order
      .map((key, index) => {
        const data = sectionData(sections[key], `${path} sections.${key}`);
        return data.disabled === true
          ? ''
          : this.renderSection(data, `${prefix}__${key}`, type, index);
      })
      .join('');
  }

  private renderStaticSection(type: string): string {
    const data = asRecord(themeJson(this.theme, 'config/settings_data.json'), 'settings_data');
    const current = isRecord(data['current']) ? data['current'] : {};
    const stored = isRecord(current['sections']) ? current['sections'][type] : undefined;
    const settings = isRecord(stored) && isRecord(stored['settings']) ? stored['settings'] : {};
    return this.renderSection({ type, settings }, type, 'static', null);
  }

  // ---------------------------------------------------------------------------------------
  // Settings and translations
  // ---------------------------------------------------------------------------------------

  private resolveSettings(
    schema: unknown,
    values: Record<string, unknown>,
    owner: string,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const definitions = Array.isArray(schema) ? schema : [];
    for (const definition of definitions) {
      if (!isRecord(definition) || typeof definition['id'] !== 'string') continue;
      const id = definition['id'];
      const type = typeof definition['type'] === 'string' ? definition['type'] : 'text';
      const value = id in values ? values[id] : definition['default'];
      out[id] = this.settingValue(type, value, `${owner} setting ${id}`);
    }
    for (const id of Object.keys(values)) {
      if (!(id in out)) throw new Error(`${owner}: setting "${id}" is not in the schema`);
    }
    return out;
  }

  private settingValue(type: string, value: unknown, what: string): unknown {
    if (value === undefined || value === null || value === '') {
      return type === 'checkbox' ? false : null;
    }
    switch (type) {
      case 'image_picker': {
        const name = asString(value, what).replace(/^shopify:\/\/shop_images\//, '');
        const image = this.store.images.get(name);
        if (image === undefined) throw new Error(`${what}: fixture image ${name} does not exist`);
        return image;
      }
      case 'collection': {
        const handle = asString(value, what);
        return this.store.collections.get(handle) ?? null;
      }
      case 'product': {
        const handle = asString(value, what);
        return this.store.products.get(handle) ?? null;
      }
      case 'link_list': {
        const handle = asString(value, what);
        return this.store.linklists[handle] ?? null;
      }
      default:
        return value;
    }
  }

  private resolveGlobalSettings(): Record<string, unknown> {
    const schema = themeJson(this.theme, 'config/settings_schema.json');
    const definitions = (Array.isArray(schema) ? schema : []).flatMap((group: unknown) =>
      isRecord(group) && Array.isArray(group['settings']) ? (group['settings'] as unknown[]) : [],
    );
    const data = asRecord(themeJson(this.theme, 'config/settings_data.json'), 'settings_data');
    let current = data['current'];
    if (typeof current === 'string') current = asRecord(data['presets'], 'presets')[current];
    const values = { ...asRecord(current, 'settings_data current') };
    delete values['sections'];
    delete values['content_for_index'];
    return this.resolveSettings(definitions, values, 'config/settings_data.json');
  }

  private loadTranslations(): Record<string, unknown> {
    const defaults = [...this.theme.files.keys()].filter((p) =>
      /^locales\/[^/]+\.default\.json$/.test(p),
    );
    const [file, ...extra] = defaults;
    if (file === undefined || extra.length > 0) {
      throw new Error(`${this.theme.name}: exactly one locales/*.default.json is required`);
    }
    return asRecord(themeJson(this.theme, file), file);
  }

  /** The `t` filter: lookup, pluralization by `count`, interpolation, escaping unless `_html`. */
  translate(key: string, args: Record<string, unknown>): string {
    let value = lookupPath(this.translations, key);
    if (isRecord(value)) {
      const count = Number(args['count']);
      value = count === 1 && 'one' in value ? value['one'] : value['other'];
    }
    if (typeof value !== 'string')
      return `translation missing: ${this.store.locale.iso_code}.${key}`;
    const text = value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) =>
      liquidString(args[name]),
    );
    return key.endsWith('_html') ? text : escapeHtml(text);
  }

  private collectStylesheets(): string {
    const parts: string[] = [];
    const pattern = /\{%-?\s*stylesheet\s*-?%\}([\s\S]*?)\{%-?\s*endstylesheet\s*-?%\}/g;
    for (const [path, source] of [...this.theme.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!/^(sections|blocks|snippets)\/.*\.liquid$/.test(path)) continue;
      for (const match of source.matchAll(pattern)) parts.push(match[1] ?? '');
    }
    return parts.join('\n');
  }

  // ---------------------------------------------------------------------------------------
  // The Liquid engine
  // ---------------------------------------------------------------------------------------

  private renderLiquid(path: string, scope: Record<string, unknown>): string {
    const source = themeFile(this.theme, path);
    try {
      const templates = this.engine.parse(source, path);
      const html: unknown = this.engine.renderSync(templates, scope, { globals: this.globals });
      if (typeof html !== 'string') throw new Error('rendering did not produce text');
      return html;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.theme.name}: ${path}: ${message}`, { cause: error });
    }
  }

  private createEngine(): Liquid {
    const theme = this.theme;
    const fs: FS = {
      exists: (file) => Promise.resolve(theme.files.has(file)),
      existsSync: (file) => theme.files.has(file),
      readFile: (file) => Promise.resolve(themeFile(theme, file)),
      readFileSync: (file) => themeFile(theme, file),
      resolve: (dir, file, ext) => `${dir}/${file}${file.endsWith(ext) ? '' : ext}`,
      contains: () => Promise.resolve(true),
      containsSync: () => true,
    };
    const engine = new Liquid({
      fs,
      root: ['snippets'],
      partials: ['snippets'],
      layouts: ['layout'],
      extname: '.liquid',
      strictFilters: true,
      strictVariables: false,
      jsTruthy: false,
      ownPropertyOnly: true,
      dynamicPartials: true,
      relativeReference: false,
      timezoneOffset: 0,
      cache: true,
    });
    this.registerTags(engine);
    this.registerFilters(engine);
    return engine;
  }

  private registerTags(engine: Liquid): void {
    const renderStatic = (type: string): string => this.renderStaticSection(type);
    const renderGroup = (group: string): string => this.renderGroup(group);
    const renderBlock = (
      block: LiquidObject,
      section: unknown,
      params: Record<string, unknown>,
    ): string => this.renderThemeBlock(block, section, params);

    engine.registerTag('schema', RawBlock);
    engine.registerTag('stylesheet', RawBlock);
    engine.registerTag('javascript', RawBlock);
    engine.registerTag('style', StyleTag);
    engine.registerTag('form', FormTag);
    engine.registerTag('paginate', PaginateTag);

    engine.registerTag(
      'section',
      class extends Tag {
        private readonly type: string;
        constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
          super(token, remain, liquid);
          this.type = quotedName(token.args, 'section');
        }
        render(_ctx: Context, emitter: Emitter): void {
          emitter.write(renderStatic(this.type));
        }
      },
    );

    engine.registerTag(
      'sections',
      class extends Tag {
        private readonly group: string;
        constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
          super(token, remain, liquid);
          this.group = quotedName(token.args, 'sections');
        }
        render(_ctx: Context, emitter: Emitter): void {
          emitter.write(renderGroup(this.group));
        }
      },
    );

    engine.registerTag(
      'content_for',
      class extends Tag {
        private readonly kind: string;
        private readonly hash: Hash;
        constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
          super(token, remain, liquid);
          this.kind = quotedName(token.args, 'content_for');
          this.hash = new Hash(token.args.replace(/^\s*(['"])[^'"]+\1\s*,?/, ''));
          if (this.kind !== 'blocks' && this.kind !== 'block') {
            throw new Error(`content_for "${this.kind}" is not supported`);
          }
        }
        *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
          const parent: unknown = ctx.getSync(['__parent']);
          const section: unknown = ctx.getSync(['section']);
          const children: unknown[] =
            isRecord(parent) && Array.isArray(parent['blocks'])
              ? (parent['blocks'] as unknown[])
              : [];
          if (this.kind === 'blocks') {
            for (const block of children) {
              if (isRecord(block)) emitter.write(renderBlock(block, section, {}));
            }
            return;
          }
          const hash = (yield this.hash.render(ctx)) as Record<string, unknown>;
          const type = asString(hash['type'], 'content_for block type');
          const id = asString(hash['id'], 'content_for block id');
          const stored = children.find((b): b is LiquidObject => isRecord(b) && b['id'] === id);
          const block = stored ?? { id, type, settings: {}, blocks: [], shopify_attributes: '' };
          const params = Object.fromEntries(
            Object.entries(hash).filter(([k]) => k !== 'type' && k !== 'id'),
          );
          emitter.write(renderBlock(block, section, params));
        }
      },
    );
  }

  private registerFilters(engine: Liquid): void {
    const store = this.store;
    const translate = (key: string, args: Record<string, unknown>): string =>
      this.translate(key, args);
    const asset = (name: string): string => themeFile(this.theme, `assets/${name}`);
    const imageOf = (value: unknown): LiquidObject | null => {
      if (value instanceof ImageUrl) return value.image;
      if (typeof value === 'string') {
        const name = value.replace(/^shopify:\/\/shop_images\//, '');
        return store.images.get(name) ?? { src: name, alt: '', width: 0, height: 0 };
      }
      if (!isRecord(value)) return null;
      if (typeof value['src'] === 'string') return value;
      for (const key of ['featured_media', 'featured_image', 'image']) {
        const inner = value[key];
        if (isRecord(inner) && typeof inner['src'] === 'string') return inner;
      }
      return null;
    };
    const imageUrl = (
      value: unknown,
      width: number | null,
      height: number | null,
    ): ImageUrl | string => {
      const image = imageOf(value);
      if (image === null) return '';
      const params = [
        'v=1',
        ...(width === null ? [] : [`width=${String(width)}`]),
        ...(height === null ? [] : [`height=${String(height)}`]),
      ];
      return new ImageUrl(
        `${FILES_PREFIX}${liquidString(image['src'])}?${params.join('&')}`,
        image,
        width,
      );
    };
    const money = (format: unknown, cents: unknown): string =>
      liquidString(format).replace(/\{\{\s*amount\s*\}\}/, formatAmount(Number(cents ?? 0)));

    engine.registerFilter('t', (key: unknown, ...args: unknown[]) =>
      translate(liquidString(key), keywordArgs(args)),
    );
    engine.registerFilter('asset_url', (name: unknown) => `${ASSET_PREFIX}${liquidString(name)}`);
    engine.registerFilter(
      'stylesheet_tag',
      (url: unknown) =>
        `<link href="${liquidString(url)}" rel="stylesheet" type="text/css" media="all" />`,
    );
    engine.registerFilter('inline_asset_content', (name: unknown) => asset(liquidString(name)));
    engine.registerFilter('image_url', (value: unknown, ...args: unknown[]) => {
      const kw = keywordArgs(args);
      const width = kw['width'] === undefined ? null : Number(kw['width']);
      const height = kw['height'] === undefined ? null : Number(kw['height']);
      return imageUrl(value, width, height);
    });
    engine.registerFilter('img_url', (value: unknown, size: unknown) => {
      const width = Number(/^(\d+)x/.exec(liquidString(size))?.[1] ?? Number.NaN);
      return imageUrl(value, Number.isFinite(width) ? width : null, null);
    });
    engine.registerFilter('image_tag', (value: unknown, ...args: unknown[]) => {
      const kw = keywordArgs(args);
      const image = imageOf(value) ?? { src: '', alt: '', width: 0, height: 0 };
      const naturalWidth = Number(image['width'] ?? 0);
      const naturalHeight = Number(image['height'] ?? 0);
      const requested =
        value instanceof ImageUrl && value.width !== null ? value.width : naturalWidth;
      const width =
        kw['width'] === undefined
          ? Math.min(requested, naturalWidth || requested)
          : Number(kw['width']);
      const height =
        kw['height'] === undefined
          ? naturalWidth > 0
            ? Math.round((width * naturalHeight) / naturalWidth)
            : 0
          : Number(kw['height']);
      const alt = liquidString('alt' in kw ? kw['alt'] : image['alt']);
      const extra = Object.entries(kw)
        .filter(([k]) => !['alt', 'width', 'height', 'widths', 'preload'].includes(k))
        .map(([k, v]) => ` ${k}="${escapeHtml(liquidString(v))}"`)
        .join('');
      return `<img src="${escapeHtml(liquidString(value))}" alt="${escapeHtml(alt)}" width="${String(width)}" height="${String(height)}"${extra}>`;
    });
    engine.registerFilter('money', (cents: unknown) => money(store.shop['money_format'], cents));
    engine.registerFilter('money_with_currency', (cents: unknown) =>
      money(store.shop['money_with_currency_format'], cents),
    );
    engine.registerFilter('money_without_currency', (cents: unknown) =>
      formatAmount(Number(cents ?? 0)),
    );
    engine.registerFilter('handle', (value: unknown) => handleize(liquidString(value)));
    engine.registerFilter('handleize', (value: unknown) => handleize(liquidString(value)));
    engine.registerFilter(
      'link_to',
      (text: unknown, url: unknown, title: unknown) =>
        `<a href="${escapeHtml(liquidString(url))}" title="${escapeHtml(liquidString(title))}">${liquidString(text)}</a>`,
    );
    const date = builtinFilters['date'];
    if (typeof date !== 'function') throw new Error('liquidjs has no date filter');
    engine.registerFilter(
      'date',
      function (this: unknown, value: unknown, ...args: unknown[]): unknown {
        const input = value === 'now' || value === 'today' ? FIXED_NOW : value;
        return (date as (this: unknown, ...a: unknown[]) => unknown).call(this, input, ...args);
      },
    );
  }
}

/** Liquid's view of a value as text: nil is empty, an image URL is its URL. */
export function liquidString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof ImageUrl) return value.url;
  return '';
}

function quotedName(args: string, tag: string): string {
  const match = /^\s*(['"])([^'"]+)\1/.exec(args);
  if (match?.[2] === undefined) throw new Error(`${tag} tag needs a quoted name`);
  return match[2];
}

/** Parses a block tag's body up to its end tag. */
function parseBody(name: string, remain: TopLevelToken[], parser: Parser): Template[] {
  const templates: Template[] = [];
  const stream = parser
    .parseStream(remain)
    .on(`tag:end${name}`, () => {
      stream.stop();
    })
    .on('template', (t: Template) => {
      templates.push(t);
    })
    .on('end', () => {
      throw new Error(`tag ${name} was not closed`);
    });
  stream.start();
  return templates;
}

/**
 * `schema`, `stylesheet` and `javascript`: the body is skipped and nothing renders in place.
 * Shopify bundles stylesheet and javascript bodies into compiled assets; the renderer puts the
 * stylesheets in `content_for_header` and leaves scripts out (ADR-202).
 */
class RawBlock extends Tag {
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
    super(token, remain, liquid);
    for (;;) {
      const next = remain.shift();
      if (next === undefined) throw new Error(`tag ${token.name} was not closed`);
      if ('name' in next && next.name === `end${token.name}`) return;
    }
  }
  render(): void {
    // Nothing renders in place.
  }
}

/** `{% style %}`: renders its body inside `<style data-shopify>`. */
class StyleTag extends Tag {
  private readonly body: Template[];
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(token, remain, liquid);
    this.body = parseBody('style', remain, parser);
  }
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    emitter.write('<style data-shopify>');
    yield this.liquid.renderer.renderTemplates(this.body, ctx, emitter);
    emitter.write('</style>');
  }
}

const FORM_ACTIONS: Readonly<Record<string, string>> = {
  product: '/cart/add',
  customer: '/contact#',
  contact: '/contact#',
  customer_login: '/account/login',
  create_customer: '/account',
  recover_customer_password: '/account/recover',
  localization: '/localization',
  storefront_password: '/password',
  new_comment: '/blogs',
};

/** `{% form 'type', object, key: value %}`: a form with Shopify's hidden fields. */
class FormTag extends Tag {
  private readonly body: Template[];
  private readonly type: string;
  private readonly hash: Hash;
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(token, remain, liquid);
    const match =
      /^\s*(['"])([a-z_]+)\1\s*(?:,\s*([A-Za-z_][\w.]*)\s*(?=,|$))?\s*,?\s*([\s\S]*)$/.exec(
        token.args,
      );
    if (match === null) throw new Error(`form tag: cannot read "${token.args}"`);
    this.type = match[2] ?? '';
    this.hash = new Hash(match[4] ?? '');
    this.body = parseBody('form', remain, parser);
  }
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const hash = (yield this.hash.render(ctx)) as Record<string, unknown>;
    const action = FORM_ACTIONS[this.type] ?? '/';
    const id = liquidString(hash['id']);
    const attrs = Object.entries(hash)
      .filter(([k]) => k !== 'id' && k !== 'class' && k !== 'return_to')
      .map(([k, v]) => ` ${k}="${escapeHtml(liquidString(v))}"`)
      .join('');
    const cls =
      hash['class'] === undefined ? '' : ` class="${escapeHtml(liquidString(hash['class']))}"`;
    const enctype = this.type === 'product' ? ' enctype="multipart/form-data"' : '';
    const href = action.endsWith('#') ? `${action}${id}` : action;
    const idAttr = id === '' ? '' : ` id="${escapeHtml(id)}"`;
    emitter.write(
      `<form method="post" action="${href}"${idAttr} accept-charset="UTF-8"${cls}${enctype}${attrs}>` +
        `<input type="hidden" name="form_type" value="${this.type}"><input type="hidden" name="utf8" value="✓">`,
    );
    ctx.push({ form: { errors: null, posted_successfully: false, email: null } });
    yield this.liquid.renderer.renderTemplates(this.body, ctx, emitter);
    ctx.pop();
    emitter.write('</form>');
  }
}

/** `{% paginate x.items by n %}`: page one of `x.items`, and the `paginate` object. */
class PaginateTag extends Tag {
  private readonly body: Template[];
  private readonly base: string;
  private readonly property: string;
  private readonly size: string;
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(token, remain, liquid);
    const match = /^\s*([A-Za-z_]\w*)\.(\w+)\s+by\s+(\S+)\s*$/.exec(token.args);
    if (match === null) throw new Error(`paginate tag: cannot read "${token.args}"`);
    this.base = match[1] ?? '';
    this.property = match[2] ?? '';
    this.size = match[3] ?? '';
    this.body = parseBody('paginate', remain, parser);
  }
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const object: unknown = ctx.getSync([this.base]);
    const items = isRecord(object) ? object[this.property] : undefined;
    const list: unknown[] = Array.isArray(items) ? (items as unknown[]) : [];
    const sizeValue = /^\d+$/.test(this.size)
      ? Number(this.size)
      : Number(ctx.getSync(this.size.split('.')));
    const size = Number.isFinite(sizeValue) && sizeValue > 0 ? sizeValue : list.length || 1;
    const pages = Math.max(1, Math.ceil(list.length / size));
    const path = liquidString(lookupPath(ctx.getSync(['request']), 'path')) || '/';
    const base = path.split('?')[0] ?? path;
    const url = (n: number): string => `${base}?page=${String(n)}`;
    const paginate = {
      current_page: 1,
      current_offset: 0,
      items: list.length,
      page_size: size,
      pages,
      previous: null,
      next: pages > 1 ? { title: 'Next', url: url(2), is_link: true } : null,
      parts: Array.from({ length: pages }, (_, i) => ({
        title: String(i + 1),
        url: url(i + 1),
        is_link: i !== 0,
      })),
    };
    ctx.push({
      [this.base]: { ...(isRecord(object) ? object : {}), [this.property]: list.slice(0, size) },
      paginate,
    });
    yield this.liquid.renderer.renderTemplates(this.body, ctx, emitter);
    ctx.pop();
  }
}
