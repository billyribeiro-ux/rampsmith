/**
 * What happens when a visitor submits the free scanner's form (PLAN §16), as a function of
 * injected dependencies so every branch is testable without a network or a clock.
 *
 * Order matters:
 * 1. The address is checked first: it costs nothing and keeps junk away from Cloudflare.
 * 2. The per-IP cap is read before the challenge so a blocked IP does not spend siteverify
 *    calls; it is only spent when a scan is actually started.
 * 3. The challenge is verified before any cache read, so the cache cannot be probed anonymously.
 * 4. A cached result needs no scan and no quota.
 * 5. The cap and the domain limit are reserved before the scanner is called, and given back if
 *    no scan ran, so a request that was refused or failed never costs the visitor a scan.
 */
import {
  fixtureScanner,
  notConnectedScanner,
  type FreeScanResult,
  type FreeScanner,
} from './client.ts';
import { DAY_MS, ResultCache, WindowLimiter } from './limits.ts';
import { parsePublicUrl, type UrlRefusal } from './url.ts';
import type { FreeScanDelegate } from './delegate.ts';
import type { TurnstileVerdict } from './turnstile.ts';

const SCANS_PER_IP_PER_DAY = 3;
const SCANS_PER_DOMAIN_PER_DAY = 1;

export type FreeScanBackend = 'not-connected' | 'fixture' | 'api';

export type FreeScanOutcomeForPage =
  | { readonly kind: 'invalid-url'; readonly reason: UrlRefusal }
  | { readonly kind: 'challenge-failed' }
  | { readonly kind: 'challenge-unavailable' }
  | {
      readonly kind: 'rate-limited';
      readonly scope: 'ip' | 'domain';
      readonly retryAfterSeconds: number;
    }
  | { readonly kind: 'not-connected' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'still-running'; readonly id: string }
  | { readonly kind: 'refused'; readonly reason: 'robots' | 'bot-challenge' | 'unreachable' }
  | { readonly kind: 'scanner-error' }
  | { readonly kind: 'result'; readonly result: FreeScanResult; readonly cached: boolean };

export interface FreeScanDeps {
  readonly scanner: FreeScanner;
  /**
   * The api, when it runs the scan (ADR-267). It then checks the challenge, keeps the daily
   * limits and the 24-hour cache itself, in the database, so none of the three happens here.
   */
  readonly delegate?: FreeScanDelegate;
  readonly verifyChallenge: (token: string, ip: string) => Promise<TurnstileVerdict>;
  readonly now: () => number;
  /** Test hook: how many results the cache may hold. */
  readonly cacheMaxEntries?: number;
}

interface FreeScanAsk {
  readonly url: string;
  readonly ip: string;
  readonly token: string;
}

export interface FreeScanService {
  run(ask: FreeScanAsk): Promise<FreeScanOutcomeForPage>;
  /** A scan the visitor was told is still running. Only the api path has one. */
  status(id: string): Promise<FreeScanOutcomeForPage>;
}

export function createFreeScanService(deps: FreeScanDeps): FreeScanService {
  const byIp = new WindowLimiter({
    limit: SCANS_PER_IP_PER_DAY,
    windowMs: DAY_MS,
    maxKeys: 50_000,
  });
  const byDomain = new WindowLimiter({
    limit: SCANS_PER_DOMAIN_PER_DAY,
    windowMs: DAY_MS,
    maxKeys: 50_000,
  });
  const cache = new ResultCache<FreeScanResult>({
    ttlMs: DAY_MS,
    maxEntries: deps.cacheMaxEntries ?? 2000,
  });

  return {
    status: (id) =>
      deps.delegate === undefined
        ? Promise.resolve({ kind: 'scanner-error' })
        : deps.delegate.status(id),

    async run({ url, ip, token }) {
      const parsed = parsePublicUrl(url);
      if (!parsed.ok) return { kind: 'invalid-url', reason: parsed.reason };
      if (deps.delegate !== undefined) return deps.delegate.start({ url, ip, token });

      const ipGate = byIp.check(ip, deps.now());
      if (!ipGate.allowed) {
        return { kind: 'rate-limited', scope: 'ip', retryAfterSeconds: ipGate.retryAfterSeconds };
      }

      const verdict = await deps.verifyChallenge(token, ip);
      if (!verdict.ok) {
        return verdict.reason === 'unavailable'
          ? { kind: 'challenge-unavailable' }
          : { kind: 'challenge-failed' };
      }

      const cached = cache.get(parsed.domain, deps.now());
      if (cached !== undefined) return { kind: 'result', result: cached, cached: true };

      // Reserve synchronously, so concurrent requests cannot all pass the checks above.
      const reservedAt = deps.now();
      const ipGateNow = byIp.check(ip, reservedAt);
      if (!ipGateNow.allowed) {
        return {
          kind: 'rate-limited',
          scope: 'ip',
          retryAfterSeconds: ipGateNow.retryAfterSeconds,
        };
      }
      const domainGate = byDomain.check(parsed.domain, reservedAt);
      if (!domainGate.allowed) {
        return {
          kind: 'rate-limited',
          scope: 'domain',
          retryAfterSeconds: domainGate.retryAfterSeconds,
        };
      }
      byIp.record(ip, reservedAt);
      byDomain.record(parsed.domain, reservedAt);
      const giveBack = () => {
        byIp.forget(ip, reservedAt);
        byDomain.forget(parsed.domain, reservedAt);
      };

      let outcome;
      try {
        outcome = await deps.scanner.scan({ origin: parsed.origin, domain: parsed.domain });
      } catch {
        giveBack();
        return { kind: 'scanner-error' };
      }
      switch (outcome.state) {
        case 'not-connected':
          giveBack();
          return { kind: 'not-connected' };
        case 'refused':
          giveBack();
          return { kind: 'refused', reason: outcome.reason };
        case 'complete':
          cache.set(parsed.domain, outcome.result, deps.now());
          return { kind: 'result', result: outcome.result, cached: false };
      }
    },
  };
}

/** The scanner a deployment uses, from its `FREE_SCANNER_BACKEND` setting. */
export function scannerFor(backend: FreeScanBackend): FreeScanner {
  return backend === 'fixture' ? fixtureScanner() : notConnectedScanner;
}
