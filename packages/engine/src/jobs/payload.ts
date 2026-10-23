/**
 * Payload validation for the engine's jobs (ADR-036): every payload is checked against the JSON
 * Schema generated from `crates/contracts`, so the Rust producer and this consumer cannot drift.
 * Failures are permanent (a retry would fail the same way) and never echo a payload value.
 */
import { readFileSync } from 'node:fs';
import type {
  AiAltText,
  AuditData,
  FreeScanRun,
  ScanFinalize,
  ScanPageV2,
  ScanPlan,
  VerifyScan,
} from '@rampsmith/contracts-ts';
import { JobFailure, type ClaimedJob } from '@rampsmith/queue';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

/** The part of a claimed job the handlers read. */
export type JobInput = Pick<ClaimedJob, 'payloadSchema' | 'payload' | 'tenantId'> &
  Partial<Pick<ClaimedJob, 'lease' | 'maxAttempts'>>;

/** Whether a failure of this attempt is the job's last: no retry will follow. */
export function isLastAttempt(job: JobInput): boolean {
  return (
    job.lease !== undefined && job.maxAttempts !== undefined && job.lease.attempt >= job.maxAttempts
  );
}

/**
 * What `runWorker` calls; it must reject rather than throw. `signal` aborts when the job's
 * lease is lost, and a handler that pays for work (a download, a model call) passes it on.
 */
export type JobHandler = (job: JobInput, signal?: AbortSignal) => Promise<void>;

/** Each engine payload schema and the generated type it validates to. */
interface Payloads {
  'scan.plan@1': ScanPlan;
  'scan.page@2': ScanPageV2;
  'scan.finalize@1': ScanFinalize;
  'audit.data@1': AuditData;
  'ai.alt_text@1': AiAltText;
  'verify.scan@1': VerifyScan;
  'free_scan.run@1': FreeScanRun;
}
export type PayloadSchema = keyof Payloads;

/** The schema file `gen-schemas` writes for each payload schema. */
const FILES: Readonly<Record<PayloadSchema, string>> = {
  'scan.plan@1': 'scan-plan',
  'scan.page@2': 'scan-page-v2',
  'scan.finalize@1': 'scan-finalize',
  'audit.data@1': 'audit-data',
  'ai.alt_text@1': 'ai-alt-text',
  'verify.scan@1': 'verify-scan',
  'free_scan.run@1': 'free-scan-run',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UINT32_MAX = 4_294_967_295;

function isUri(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const ajv = new Ajv2020({ strict: true, allErrors: false });
ajv.addFormat('uuid', UUID);
// The engine loads only https pages (PLAN §11), so `uri` means an https URL here.
ajv.addFormat('uri', isUri);
ajv.addFormat('uint32', {
  type: 'number',
  validate: (n: number) => Number.isInteger(n) && n >= 0 && n <= UINT32_MAX,
});

const validators = new Map<PayloadSchema, ValidateFunction>();

function validatorFor(schema: PayloadSchema): ValidateFunction {
  const cached = validators.get(schema);
  if (cached !== undefined) return cached;
  const url = import.meta.resolve(`@rampsmith/contracts-ts/schemas/${FILES[schema]}.schema.json`);
  const compiled = ajv.compile(JSON.parse(readFileSync(new URL(url), 'utf8')) as object);
  validators.set(schema, compiled);
  return compiled;
}

function permanent(code: string, message: string): JobFailure {
  return new JobFailure('permanent', { code, message });
}

/** Returns the payload typed by its schema, or throws a permanent `JobFailure`. */
export function parsePayload<S extends PayloadSchema>(job: JobInput, expected: S): Payloads[S] {
  if (job.payloadSchema !== expected) {
    throw permanent('payload_schema_unknown', `expected ${expected}, got ${job.payloadSchema}`);
  }
  const validate = validatorFor(expected);
  if (!validate(job.payload)) {
    // Only the failing keyword and location: never the value, which may be store content.
    const first = validate.errors?.[0];
    const where = first === undefined ? '' : ` (${first.keyword} at ${first.instancePath || '/'})`;
    throw permanent('payload_invalid', `payload does not match ${expected}${where}`);
  }
  return job.payload as Payloads[S];
}

/** Every engine job acts for one tenant (PLAN §9). */
export function requireTenant(job: JobInput): string {
  if (job.tenantId === null) throw permanent('tenant_missing', 'this job needs a tenant');
  return job.tenantId;
}
