/**
 * The free scanner's real path (ADR-265): the api owns everything that protects it. It checks
 * the address, verifies the Turnstile token server-side, enforces the daily limits and the
 * 24-hour cache from the database, and queues the scan for the engine. This module only
 * carries the visitor's request there, with the shared service token, and turns the api's
 * answers into the outcomes the page shows.
 *
 * The visitor's address is forwarded so the api can count it (it stores a keyed hash, never the
 * address). A Turnstile token works once, so the web server must not also verify it.
 */
import type { ApiClient } from '@rampsmith/contracts-ts';
import type { FreeScanResult } from './client.ts';
import type { FreeScanOutcomeForPage } from './service.ts';
import type { UrlRefusal } from './url.ts';

/** How the service hands a request to the api. */
export interface FreeScanDelegate {
  /** Starts a scan, or joins or reuses one, and waits a while for the answer. */
  start(ask: {
    readonly url: string;
    readonly ip: string;
    readonly token: string;
  }): Promise<FreeScanOutcomeForPage>;
  /** The state of a scan the visitor was told is still running. */
  status(id: string): Promise<FreeScanOutcomeForPage>;
}

export interface DelegateOptions {
  readonly client: ApiClient;
  /** `FREE_SCAN_SERVICE_TOKEN`. */
  readonly serviceToken: string;
  /** How long one request waits for a scan to finish. Default 45 seconds. */
  readonly waitMs?: number;
  /** Time between checks while waiting. Default 1.5 seconds. */
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const REFUSALS = ['robots', 'bot-challenge', 'unreachable'] as const;
const URL_REASONS: readonly UrlRefusal[] = [
  'empty',
  'invalid',
  'scheme',
  'credentials',
  'port',
  'address',
  'private',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The api's result in the page's shape; `undefined` if it is not what the contract says. */
function resultFrom(value: unknown): FreeScanResult | undefined {
  if (!isRecord(value)) return undefined;
  const { domain, scanned_at, pages, checks_passed, checks_run, failures } = value;
  if (
    typeof domain !== 'string' ||
    typeof scanned_at !== 'string' ||
    !Array.isArray(pages) ||
    typeof checks_passed !== 'number' ||
    typeof checks_run !== 'number' ||
    !Array.isArray(failures)
  ) {
    return undefined;
  }
  const mapped: FreeScanResult['failures'][number][] = [];
  for (const failure of failures) {
    if (!isRecord(failure) || !Array.isArray(failure['examples'])) return undefined;
    const { rule_id, title, criterion, count } = failure;
    if (
      typeof rule_id !== 'string' ||
      typeof title !== 'string' ||
      typeof criterion !== 'string' ||
      typeof count !== 'number'
    ) {
      return undefined;
    }
    const examples: { page: string; snippet: string }[] = [];
    for (const example of failure['examples']) {
      if (!isRecord(example)) return undefined;
      const { page, snippet } = example;
      if (typeof page !== 'string' || typeof snippet !== 'string') return undefined;
      examples.push({ page, snippet });
    }
    mapped.push({ ruleId: rule_id, title, criterion, count, examples });
  }
  if (!pages.every((page) => typeof page === 'string')) return undefined;
  return {
    domain,
    scannedAt: scanned_at,
    pages,
    checksPassed: checks_passed,
    checksRun: checks_run,
    failures: mapped,
    isFixture: false,
  };
}

interface Scan {
  readonly id: string;
  readonly status: string;
  readonly refusal: string | null;
  readonly result: unknown;
  readonly cached: boolean;
}

function scanFrom(value: unknown): Scan | undefined {
  if (!isRecord(value)) return undefined;
  const { id, status, refusal, result, cached } = value;
  if (typeof id !== 'string' || typeof status !== 'string') return undefined;
  return {
    id,
    status,
    refusal: typeof refusal === 'string' ? refusal : null,
    result,
    cached: cached === true,
  };
}

/** What a finished or unfinished scan means for the page. */
function outcomeOf(scan: Scan): FreeScanOutcomeForPage | 'waiting' {
  switch (scan.status) {
    case 'queued':
    case 'running':
      return 'waiting';
    case 'complete': {
      const result = resultFrom(scan.result);
      return result === undefined
        ? { kind: 'scanner-error' }
        : { kind: 'result', result, cached: scan.cached };
    }
    case 'refused': {
      const reason = REFUSALS.find((r) => r === scan.refusal);
      return reason === undefined ? { kind: 'scanner-error' } : { kind: 'refused', reason };
    }
    default:
      return { kind: 'scanner-error' };
  }
}

function errorFields(body: unknown): { field: string; message: string }[] {
  if (!isRecord(body) || !Array.isArray(body['errors'])) return [];
  return body['errors'].flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry['field'] === 'string' && typeof entry['message'] === 'string'
      ? [{ field: entry['field'], message: entry['message'] }]
      : [],
  );
}

export function apiDelegate(options: DelegateOptions): FreeScanDelegate {
  const waitMs = options.waitMs ?? 45_000;
  const pollMs = options.pollMs ?? 1500;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = { authorization: `Bearer ${options.serviceToken}` };

  async function fetchScan(id: string): Promise<Scan | undefined> {
    const got = await options.client
      .GET('/v1/free-scans/{id}', { params: { path: { id } }, headers })
      .catch(() => undefined);
    return got?.response.status === 200 ? scanFrom(got.data) : undefined;
  }

  /** Waits for a queued scan until the deadline. */
  async function wait(first: Scan, deadline: number): Promise<FreeScanOutcomeForPage> {
    let scan = first;
    for (;;) {
      const outcome = outcomeOf(scan);
      if (outcome !== 'waiting') return outcome;
      if (now() >= deadline) return { kind: 'still-running', id: scan.id };
      await sleep(pollMs);
      const next = await fetchScan(scan.id);
      if (next === undefined) return { kind: 'scanner-error' };
      scan = next;
    }
  }

  return {
    async start({ url, ip, token }) {
      const deadline = now() + waitMs;
      const sent = await options.client
        .POST('/v1/free-scans', {
          body: { url, turnstile_token: token, client_ip: ip },
          headers,
        })
        .catch(() => undefined);
      if (sent === undefined) return { kind: 'scanner-error' };
      const { response } = sent;
      if (response.status === 200 || response.status === 202) {
        const scan = scanFrom(sent.data);
        return scan === undefined ? { kind: 'scanner-error' } : wait(scan, deadline);
      }
      const fields = errorFields(sent.error);
      switch (response.status) {
        case 422: {
          if (fields.some((f) => f.field === 'turnstile_token')) {
            return { kind: 'challenge-failed' };
          }
          const reason = URL_REASONS.find(
            (r) => r === fields.find((f) => f.field === 'url')?.message,
          );
          return { kind: 'invalid-url', reason: reason ?? 'invalid' };
        }
        case 429: {
          const scope =
            fields.find((f) => f.field === 'limit')?.message === 'domain' ? 'domain' : 'ip';
          const seconds = Number(response.headers.get('retry-after'));
          return {
            kind: 'rate-limited',
            scope,
            retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 86_400,
          };
        }
        case 503:
          return fields.some((f) => f.field === 'turnstile_token')
            ? { kind: 'challenge-unavailable' }
            : { kind: 'busy' };
        default:
          // 401 means the service token is wrong, which only an operator can fix.
          return { kind: 'scanner-error' };
      }
    },

    async status(id) {
      const scan = await fetchScan(id);
      if (scan === undefined) return { kind: 'scanner-error' };
      const outcome = outcomeOf(scan);
      return outcome === 'waiting' ? { kind: 'still-running', id: scan.id } : outcome;
    },
  };
}
