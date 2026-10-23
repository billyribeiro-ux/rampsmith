import { RULES_VERSION } from '@rampsmith/a11y-rules';
import { AXE_VERSION } from './scan-page.ts';

/**
 * What a scan checked with, recorded on `scans.ruleset_version` when the scan is planned and
 * again when it is finalised: the axe-core version and the hash of the custom rule catalog.
 */
export const RULESET_VERSION = `axe-core ${AXE_VERSION}; ${RULES_VERSION}`;
