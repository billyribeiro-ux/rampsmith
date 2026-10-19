/**
 * Versioned prompts (PLAN §13 "Prompts and outputs"; ADR-213). Each task's instruction
 * prefix lives in `prompts/<task>/v<N>.txt`, identical across calls so prompt caching applies,
 * and `prompts/manifest.json` pins the current version and the SHA-256 of the prefix together
 * with its output schema. The version string, such as `alt-text@1`, is stored with every call
 * and every fix it produced. Changing a prompt or its schema without bumping the version fails
 * the manifest test.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ALT_TEXT_SCHEMA,
  EXPLAIN_SCHEMA,
  GRADE_SCHEMA,
  PATCH_PROPOSAL_SCHEMA,
  REWRITE_SCHEMA,
  TIE_BREAK_SCHEMA,
} from './outputs.ts';
import type { CompiledSchema } from './schema.ts';

export const PROMPT_IDS = [
  'alt-text',
  'rewrite',
  'tie-break',
  'patch-proposal',
  'explain',
  'grade-alt-text',
] as const;

export type PromptId = (typeof PROMPT_IDS)[number];

const SCHEMAS: Readonly<Record<PromptId, CompiledSchema<unknown>>> = {
  'alt-text': ALT_TEXT_SCHEMA,
  rewrite: REWRITE_SCHEMA,
  'tie-break': TIE_BREAK_SCHEMA,
  'patch-proposal': PATCH_PROPOSAL_SCHEMA,
  explain: EXPLAIN_SCHEMA,
  'grade-alt-text': GRADE_SCHEMA,
};

interface ManifestEntry {
  readonly version: number;
  readonly sha256: string;
}

const PROMPTS_DIR = new URL('../prompts/', import.meta.url);

function readManifest(): Readonly<Record<PromptId, ManifestEntry>> {
  const raw = JSON.parse(readFileSync(new URL('manifest.json', PROMPTS_DIR), 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('prompts/manifest.json must be an object');
  }
  const out: Partial<Record<PromptId, ManifestEntry>> = {};
  for (const id of PROMPT_IDS) {
    const entry = (raw as Record<string, unknown>)[id];
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !Number.isInteger((entry as { version?: unknown }).version) ||
      typeof (entry as { sha256?: unknown }).sha256 !== 'string'
    ) {
      throw new Error(`prompts/manifest.json has no valid entry for ${id}`);
    }
    out[id] = entry as ManifestEntry;
  }
  return out as Record<PromptId, ManifestEntry>;
}

export interface Prompt {
  readonly id: PromptId;
  /** Stored with every call and every fix, for example `alt-text@1`. */
  readonly version: string;
  /** The instruction prefix, sent as the system prompt. */
  readonly text: string;
  readonly schema: CompiledSchema<unknown>;
  readonly sha256: string;
}

/** SHA-256 over the prefix and its strict output schema, as the manifest records it. */
export function fingerprint(text: string, schema: CompiledSchema<unknown>): string {
  return createHash('sha256')
    .update(text, 'utf8')
    .update('\n\u0000schema\u0000\n', 'utf8')
    .update(JSON.stringify(schema.strict), 'utf8')
    .digest('hex');
}

export function promptPath(id: PromptId, version: number): URL {
  return new URL(`${id}/v${String(version)}.txt`, PROMPTS_DIR);
}

let cache: ReadonlyMap<PromptId, Prompt> | undefined;

/** Loads every current prompt and checks it against the manifest. */
export function loadPrompts(): ReadonlyMap<PromptId, Prompt> {
  if (cache !== undefined) {
    return cache;
  }
  const manifest = readManifest();
  const prompts = new Map<PromptId, Prompt>();
  for (const id of PROMPT_IDS) {
    const entry = manifest[id];
    const text = readFileSync(promptPath(id, entry.version), 'utf8');
    const schema = SCHEMAS[id];
    const sha256 = fingerprint(text, schema);
    if (sha256 !== entry.sha256) {
      throw new Error(
        `prompt ${id}@${String(entry.version)} differs from prompts/manifest.json; bump its version`,
      );
    }
    prompts.set(id, { id, version: `${id}@${String(entry.version)}`, text, schema, sha256 });
  }
  cache = prompts;
  return prompts;
}

export function prompt(id: PromptId): Prompt {
  const found = loadPrompts().get(id);
  if (found === undefined) {
    throw new Error(`unknown prompt ${id}`);
  }
  return found;
}
