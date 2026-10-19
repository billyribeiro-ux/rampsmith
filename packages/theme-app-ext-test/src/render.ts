// Renders the app embed with liquidjs and stand-ins for the Shopify objects and filters it
// uses, so the browser tests can load it inside a storefront fixture. This is the substitute
// for Shopify's own renderer (LAUNCH.md section E); the live check renders it on a
// development store.
import { readFileSync } from 'node:fs';
import { Liquid, Tag, type Parser, type TagToken, type TopLevelToken } from 'liquidjs';
import { escapeHtml, flatten, readLocale, translator, type Translate } from './locales.ts';
import { BLOCK_FILE, SNIPPETS_DIR, STOREFRONT_LOCALE } from './paths.ts';

/** Where the fixture serves extension assets, standing in for cdn.shopify.com. */
export const CDN_ORIGIN = 'https://cdn.fixture.test';
export const ASSET_PATH = '/extensions/rampsmith/assets/';

export interface EmbedSettings {
  readonly show_statement_link: boolean;
  readonly statement_url: string | null;
  readonly show_report_form: boolean;
  readonly color_scheme: string;
}

export interface EmbedInput {
  readonly settings?: Partial<EmbedSettings>;
  /** The app-data metafield `rampsmith.statement_url`, or null when unset. */
  readonly statementMetafield?: string | null;
  /** The app-data metafield `rampsmith.proxy_path`, or null when unset. */
  readonly proxyPathMetafield?: string | null;
  readonly path?: string | null;
  readonly pageType?: string;
  readonly locale?: string;
  readonly designMode?: boolean;
  readonly privacyPolicyUrl?: string | null;
  readonly blockId?: string;
  readonly translate?: Translate;
}

interface SchemaSetting {
  readonly id?: string;
  readonly type: string;
  readonly default?: unknown;
}

export interface BlockSchema {
  readonly name: string;
  readonly target: string;
  readonly settings: readonly SchemaSetting[];
  readonly [key: string]: unknown;
}

const SCHEMA = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/u;

/** The block's `{% schema %}` JSON. */
export function readSchema(source = readFileSync(BLOCK_FILE, 'utf8')): BlockSchema {
  const match = SCHEMA.exec(source);
  if (match?.[1] === undefined) throw new Error('blocks/accessibility.liquid has no schema');
  return JSON.parse(match[1]) as BlockSchema;
}

/** The settings a freshly enabled embed has: each setting's schema default. */
export function defaultSettings(schema = readSchema()): EmbedSettings {
  const values: Record<string, unknown> = {};
  for (const setting of schema.settings) {
    if (setting.id !== undefined) values[setting.id] = setting.default ?? null;
  }
  return values as unknown as EmbedSettings;
}

/** Liquid's string form of a scalar; nil and objects print as nothing. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** {% schema %}: read by Shopify, never rendered. Consumes everything up to {% endschema %}. */
class SchemaTag extends Tag {
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(token, remain, liquid);
    const stream = parser.parseStream(remain);
    stream
      .on('tag:endschema', () => {
        stream.stop();
      })
      .on('end', () => {
        throw new Error('{% schema %} is not closed');
      });
    stream.start();
  }

  render(): string {
    return '';
  }
}

function engine(translate: Translate, globals: Record<string, unknown>): Liquid {
  // Shopify's global objects stay visible inside {% render %}; everything else must be
  // passed as a parameter, as on Shopify.
  const liquid = new Liquid({
    root: [SNIPPETS_DIR],
    extname: '.liquid',
    strictFilters: true,
    relativeReference: false,
    globals,
  });
  liquid.registerTag('schema', SchemaTag);
  liquid.registerFilter('t', (key: unknown, ...args: unknown[]) => {
    const vars: Record<string, string | number> = {};
    for (const arg of args) {
      if (Array.isArray(arg) && typeof arg[0] === 'string') vars[arg[0]] = asText(arg[1]);
    }
    return translate(asText(key), vars);
  });
  // Shopify's `escape` is Ruby's CGI.escapeHTML; liquidjs writes &#34; where it writes &quot;.
  liquid.registerFilter('escape', (value: unknown) => escapeHtml(asText(value)));
  liquid.registerFilter(
    'asset_url',
    (name: unknown) => `${CDN_ORIGIN}${ASSET_PATH}${encodeURIComponent(asText(name))}`,
  );
  return liquid;
}

const storefront = flatten(readLocale(STOREFRONT_LOCALE));

/** Renders blocks/accessibility.liquid as Shopify would for one storefront request. */
export async function renderEmbed(input: EmbedInput = {}): Promise<string> {
  const translate = input.translate ?? translator(storefront);
  const metafield = (value: string | null | undefined) =>
    value === null || value === undefined ? null : { value };
  const scope = {
    block: {
      id: input.blockId ?? 'AdGh1Q3Bp',
      settings: { ...defaultSettings(), ...input.settings },
    },
    app: {
      metafields: {
        rampsmith: {
          statement_url: metafield(input.statementMetafield),
          proxy_path: metafield(input.proxyPathMetafield),
        },
      },
    },
  };
  const globals = {
    request: {
      path: input.path === undefined ? '/products/blue-shirt' : input.path,
      page_type: input.pageType ?? 'product',
      locale: { iso_code: input.locale ?? 'en' },
      design_mode: input.designMode ?? false,
    },
    routes: { root_url: '/', account_url: '/account' },
    shop: {
      privacy_policy:
        input.privacyPolicyUrl === null
          ? null
          : { url: input.privacyPolicyUrl ?? '/policies/privacy-policy', title: 'Privacy policy' },
    },
  };
  return engine(translate, globals).parseAndRender(
    readFileSync(BLOCK_FILE, 'utf8'),
    scope,
  ) as Promise<string>;
}
