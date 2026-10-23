/**
 * The App Home's data layer. Pages call `AppApi`; the browser implementation talks to the
 * app's own BFF routes (`/app/api/shopify/...`) with a fresh App Bridge session token on every
 * request (ADR-022, `sessionFetch`), because the embedded browser never calls the Rust api
 * directly (connect-src 'self', PLAN §16). Tests give pages a typed in-memory fake instead.
 */
import { sessionFetch, type SessionTokenSource } from '#lib/shopify/session-fetch.ts';
import type {
  AgencyCodePreview,
  AgencyLink,
  AgencyLinkList,
  FindingDetail,
  FindingList,
  FindingOrigin,
  FindingStatus,
  FixFilter,
  FixList,
  FixSummary,
  Impact,
  Overview,
  ProblemBody,
  RegressionList,
  ScanSummary,
  EmailPreferences,
  Settings,
  SettingsUpdate,
  StartedScan,
  StatementContent,
  StatementState,
} from './types.ts';

/** A failed request. `code` is the api's stable problem code, or `network`/`unexpected`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: readonly { readonly field: string; readonly message: string }[];

  constructor(
    status: number,
    code: string,
    fieldErrors: readonly { readonly field: string; readonly message: string }[] = [],
  ) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export interface FindingQuery {
  readonly impact?: Impact;
  readonly status?: FindingStatus;
  readonly origin?: FindingOrigin;
  /** A WCAG success criterion such as `1.1.1`. */
  readonly criterion?: string;
  readonly hasFix?: boolean;
  readonly cursor?: string;
}

/** What the statement preview shows. */
export interface StatementPreview {
  readonly status: 'not_evaluated' | 'known_barriers' | 'no_known_barriers';
  /** A complete HTML document, shown in a sandboxed frame. */
  readonly document: string;
  /** The sections to paste into a store page. */
  readonly fragment: string;
  readonly text: string;
}

interface Download {
  readonly filename: string;
  readonly blob: Blob;
}

export interface AppApi {
  startSession(): Promise<{ readonly shop: string; readonly installed: boolean }>;
  overview(): Promise<Overview>;
  startScan(): Promise<StartedScan>;
  scan(id: string): Promise<ScanSummary>;
  findings(query: FindingQuery): Promise<FindingList>;
  finding(id: string): Promise<FindingDetail>;
  fixes(filter: FixFilter, cursor?: string): Promise<FixList>;
  editFix(id: string, alt: string): Promise<FixSummary>;
  /** `confirmFlagged` must be true to approve a draft that was flagged for review. */
  approveFix(id: string, options?: { readonly confirmFlagged?: boolean }): Promise<FixSummary>;
  rejectFix(id: string): Promise<FixSummary>;
  undoFix(id: string): Promise<FixSummary>;
  regressions(): Promise<RegressionList>;
  dismissRegression(id: string): Promise<void>;
  agencyLinks(): Promise<AgencyLinkList>;
  previewAgencyLink(code: string): Promise<AgencyCodePreview>;
  approveAgencyLink(code: string): Promise<AgencyLink>;
  revokeAgencyLink(id: string): Promise<void>;
  settings(): Promise<Settings>;
  updateSettings(update: SettingsUpdate): Promise<Settings>;
  emailPreferences(): Promise<EmailPreferences>;
  setEmailPreference(category: 'notification', enabled: boolean): Promise<EmailPreferences>;
  statement(): Promise<StatementState>;
  saveStatement(content: StatementContent): Promise<StatementState>;
  previewStatement(content: StatementContent): Promise<StatementPreview>;
  /** A product image as a data URL; the page's CSP allows `data:` images only. */
  productImage(url: string): Promise<string>;
  /** An evidence crop as a data URL. */
  evidence(id: string): Promise<string>;
  exportLog(format: 'csv' | 'json'): Promise<Download>;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isProblem(value: unknown): value is ProblemBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

async function failure(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  if (isProblem(body)) {
    return new ApiError(response.status, body.code, body.errors ?? []);
  }
  return new ApiError(response.status, 'unexpected');
}

const BASE = '/app/api/shopify';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(new ApiError(0, 'unexpected'));
    };
    reader.readAsDataURL(blob);
  });
}

/** The browser implementation: one session-token request per call. */
export function createHttpApi(source: SessionTokenSource, fetchImpl: Fetch = fetch): AppApi {
  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await sessionFetch(source, fetchImpl, path, init);
    } catch {
      throw new ApiError(0, 'network');
    }
    if (!response.ok) throw await failure(response);
    return response;
  }
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await send(path, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (typeof body !== 'object' || body === null)
      throw new ApiError(response.status, 'unexpected');
    return body as T;
  }
  const write = (method: 'POST' | 'PUT', body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const fixAction = (id: string, action: 'approve' | 'reject' | 'undo', query = '') =>
    json<FixSummary>(`${BASE}/fixes/${encodeURIComponent(id)}/${action}${query}`, write('POST'));

  return {
    startSession: () => json('/app/api/session', write('POST')),
    overview: () => json<Overview>(`${BASE}/overview`),
    startScan: () => json<StartedScan>(`${BASE}/scans`, write('POST')),
    scan: (id) => json<ScanSummary>(`${BASE}/scans/${encodeURIComponent(id)}`),
    findings: (query) => {
      const p = new URLSearchParams();
      if (query.impact !== undefined) p.set('impact', query.impact);
      if (query.status !== undefined) p.set('status', query.status);
      if (query.origin !== undefined) p.set('origin', query.origin);
      if (query.criterion !== undefined) p.set('criterion', query.criterion);
      if (query.hasFix !== undefined) p.set('has_fix', String(query.hasFix));
      if (query.cursor !== undefined) p.set('cursor', query.cursor);
      const qs = p.toString();
      return json<FindingList>(`${BASE}/findings${qs === '' ? '' : `?${qs}`}`);
    },
    finding: (id) => json<FindingDetail>(`${BASE}/findings/${encodeURIComponent(id)}`),
    fixes: (filter, cursor) => {
      const p = new URLSearchParams({ state: filter });
      if (cursor !== undefined) p.set('cursor', cursor);
      return json<FixList>(`${BASE}/fixes?${p.toString()}`);
    },
    editFix: (id, alt) =>
      json<FixSummary>(`${BASE}/fixes/${encodeURIComponent(id)}`, write('PUT', { alt })),
    approveFix: (id, options) =>
      fixAction(id, 'approve', options?.confirmFlagged === true ? '?confirm_flagged=true' : ''),
    rejectFix: (id) => fixAction(id, 'reject'),
    undoFix: (id) => fixAction(id, 'undo'),
    regressions: () => json<RegressionList>(`${BASE}/regressions`),
    dismissRegression: async (id) => {
      await send(`${BASE}/regressions/${encodeURIComponent(id)}/dismiss`, write('POST'));
    },
    agencyLinks: () => json<AgencyLinkList>(`${BASE}/agency-links`),
    previewAgencyLink: (code) =>
      json<AgencyCodePreview>(`${BASE}/agency-links/preview`, write('POST', { code })),
    approveAgencyLink: (code) => json<AgencyLink>(`${BASE}/agency-links`, write('POST', { code })),
    revokeAgencyLink: async (id) => {
      await send(`${BASE}/agency-links/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        // SvelteKit's origin check treats a body-less write without a content type as a form post.
        headers: { 'content-type': 'application/json' },
      });
    },
    settings: () => json<Settings>(`${BASE}/settings`),
    updateSettings: (update) => json<Settings>(`${BASE}/settings`, write('PUT', update)),
    emailPreferences: () => json<EmailPreferences>(`${BASE}/email-preferences`),
    setEmailPreference: (category, enabled) =>
      json<EmailPreferences>(`${BASE}/email-preferences`, write('PUT', { category, enabled })),
    statement: () => json<StatementState>(`${BASE}/statement`),
    saveStatement: (content) => json<StatementState>(`${BASE}/statement`, write('PUT', content)),
    previewStatement: (content) =>
      json<StatementPreview>('/app/api/statement-preview', write('POST', content)),
    productImage: async (url) =>
      blobToDataUrl(await (await send(`/app/api/media?${new URLSearchParams({ u: url })}`)).blob()),
    evidence: async (id) =>
      blobToDataUrl(await (await send(`${BASE}/evidence/${encodeURIComponent(id)}`)).blob()),
    exportLog: async (format) => {
      const response = await send(`/app/api/log-export?format=${format}`);
      return {
        filename: `rampsmith-remediation-log.${format}`,
        blob: await response.blob(),
      };
    },
  };
}
