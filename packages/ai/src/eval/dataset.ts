/**
 * The labelled image set of the evaluation harness (PLAN §13 "Evaluation harness"; ADR-217).
 * A dataset is a directory with `manifest.json` and the images it lists. The repository holds
 * a small openly licensed set in `eval/dataset/`; the 500-image golden set the plan asks for
 * uses the same manifest format and lives outside the repository.
 */
import { readFileSync } from 'node:fs';
import { AiError } from '../errors.ts';
import { readImageSize, type ImageInput, type ImageMediaType } from '../images.ts';
import { compileSchema, object, text } from '../schema.ts';

export interface DatasetLicence {
  /** An SPDX id, or `LicenseRef-Public-Domain` for public-domain works. */
  readonly spdx: string;
  readonly author: string;
  readonly source: string;
  readonly obtained_from: string;
  readonly modifications: string;
  readonly notes?: string;
}

export interface DatasetImage {
  readonly id: string;
  readonly file: string;
  readonly category: string;
  readonly product_title: string;
  readonly product_type: string;
  readonly primary_locale: string;
  readonly expected: {
    readonly decorative: boolean;
    readonly contains_text: boolean;
    readonly people: boolean;
    readonly instruction_text: boolean;
  };
  /** Attribute groups a good draft mentions; a group is met when any synonym appears. */
  readonly required: readonly (readonly string[])[];
  /** Attributes the image and title do not support; mentioning one is an unsupported attribute. */
  readonly absent: readonly string[];
  /** Names a draft must never contain (people are never identified). */
  readonly forbidden_names: readonly string[];
  readonly references: readonly [string, string];
  readonly licence: DatasetLicence;
}

export interface DatasetManifest {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly reference_note: string;
  readonly images: readonly DatasetImage[];
}

const words = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 } };

const MANIFEST = compileSchema<DatasetManifest>(
  object({
    name: text(80, 'Dataset name'),
    version: { type: 'integer', minimum: 1 },
    description: text(500, 'What the dataset is'),
    reference_note: text(500, 'Who wrote the references'),
    images: {
      type: 'array',
      minItems: 1,
      items: object({
        id: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' },
        file: { type: 'string', pattern: '^images/[a-z0-9-]+\\.(?:jpg|png|gif|webp)$' },
        category: text(64, 'Category'),
        product_title: text(255, 'Product title'),
        product_type: text(255, 'Product type'),
        primary_locale: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' },
        expected: object({
          decorative: { type: 'boolean' },
          contains_text: { type: 'boolean' },
          people: { type: 'boolean' },
          instruction_text: { type: 'boolean' },
        }),
        required: { type: 'array', items: { ...words, minItems: 1 } },
        absent: words,
        forbidden_names: words,
        references: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: { type: 'string', maxLength: 300 },
        },
        licence: {
          type: 'object',
          properties: {
            spdx: {
              type: 'string',
              pattern: '^(?:CC0-1\\.0|CC-BY-[0-9.]+|LicenseRef-Public-Domain)$',
            },
            author: text(200, 'Author'),
            source: text(500, 'Where the licence is stated'),
            obtained_from: text(300, 'Where this copy came from'),
            modifications: text(300, 'What was changed'),
            notes: text(500, 'Notes'),
          },
          required: ['spdx', 'author', 'source', 'obtained_from', 'modifications'],
          additionalProperties: false,
        },
      }),
    },
  }),
);

export interface LoadedImage extends DatasetImage {
  readonly image: ImageInput;
}

const MEDIA: Readonly<Record<string, ImageMediaType>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** The dataset that ships in the repository. */
export const BUNDLED_DATASET = new URL('../../eval/dataset/', import.meta.url);

/** Loads and validates a dataset; every image is read, measured and checked. */
export function loadDataset(dir: URL = BUNDLED_DATASET): {
  manifest: DatasetManifest;
  images: LoadedImage[];
} {
  const raw = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as unknown;
  const checked = MANIFEST.check(raw);
  if (!checked.ok) {
    throw new AiError('ai_input_invalid', `the dataset manifest ${checked.reason}`);
  }
  const manifest = checked.value;
  const ids = new Set<string>();
  const images = manifest.images.map((entry): LoadedImage => {
    if (ids.has(entry.id)) {
      throw new AiError('ai_input_invalid', `duplicate dataset id ${entry.id}`);
    }
    ids.add(entry.id);
    const mediaType = MEDIA[entry.file.split('.').at(-1) ?? ''];
    if (mediaType === undefined) {
      throw new AiError('ai_input_invalid', `unsupported image type for ${entry.id}`);
    }
    const bytes = readFileSync(new URL(entry.file, dir));
    const size = readImageSize(bytes, mediaType);
    if (size === null) {
      throw new AiError('ai_input_invalid', `cannot read the size of ${entry.id}`);
    }
    return { ...entry, image: { mediaType, base64: bytes.toString('base64'), ...size } };
  });
  return { manifest, images };
}
