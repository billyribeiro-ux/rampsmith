export { detectChallenge, type Challenge } from './challenge.ts';
export { signScanToken, type ScanToken } from './egress-token.ts';
export { fingerprint, normalizeSelector, templateOrigin } from './fingerprint.ts';
export {
  AXE_VERSION,
  WCAG_TAGS,
  scanPage,
  type Occurrence,
  type PageScan,
  type ScanOptions,
  type StateScan,
} from './scan-page.ts';
export { parseRobots, robotsAllows, type Robots, type RobotsResponse } from './robots.ts';
export { recordPage, type PageContext, type RecordOutcome } from './store.ts';
export { scanPageHandler, SHOPIFY_CDN_HOSTS, type EngineDeps } from './worker.ts';
export { BOT_TOKEN, DEFAULT_BOT_INFO_URL, userAgent } from './user-agent.ts';
