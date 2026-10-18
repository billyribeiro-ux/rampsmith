/**
 * Scan tokens for egress (ADR-025): the engine signs what one page load may reach; Chromium
 * presents the token as its proxy password; egress verifies it. The format is shared with
 * crates/egress and pinned by `crates/egress/testdata/tokens.json`.
 */
import { createHmac } from 'node:crypto';

export interface ScanToken {
  readonly v: 1;
  /** The scan or page job, for egress logs. */
  readonly scan: string;
  /** Exact hosts, or `.suffix` for subdomains. */
  readonly hosts: readonly string[];
  /** Connections the page may open. */
  readonly budget: number;
  /** Unix seconds. */
  readonly exp: number;
}

const CONTEXT = 'rampsmith-egress-v1.';

export function signScanToken(secret: string, token: ScanToken): string {
  if (Buffer.byteLength(secret) < 32) {
    throw new Error('EGRESS_TOKEN_SECRET must be at least 32 bytes');
  }
  // Field order matches the Rust struct, so both sides produce the same bytes.
  const body = Buffer.from(
    JSON.stringify({
      v: token.v,
      scan: token.scan,
      hosts: token.hosts,
      budget: token.budget,
      exp: token.exp,
    }),
  ).toString('base64url');
  const tag = createHmac('sha256', secret).update(CONTEXT).update(body).digest('base64url');
  return `${body}.${tag}`;
}
