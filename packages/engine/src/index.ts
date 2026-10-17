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
} from './scan-page.ts';
export { recordPage, type PageContext, type RecordOutcome } from './store.ts';
export { scanPageHandler, SHOPIFY_CDN_HOSTS, type EngineDeps } from './worker.ts';
