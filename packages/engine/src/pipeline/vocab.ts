/**
 * The scan pipeline's vocabulary (ADR-036): spelled as `crates/domain` and `packages/a11y-rules`
 * spell it, and the payload schema pins the strings.
 */
import type { ScanPageV2 } from '@rampsmith/contracts-ts';
import type { PageState } from '@rampsmith/a11y-rules';

export type PageType = ScanPageV2['page_type'];
export type Viewport = ScanPageV2['viewport'];
export type { PageState };

/** The eight page types of R1, in the order a plan visits them (PLAN §5). */
export const PAGE_TYPES = [
  'home',
  'product',
  'collection',
  'cart',
  'search',
  'login',
  'page',
  'article',
] as const satisfies readonly PageType[];

/** Page types a purchase passes through; a finding there counts double (PLAN §11 score). */
export const PURCHASE_PATH: ReadonlySet<PageType> = new Set(['product', 'cart', 'search']);

/** PLAN §11 step 3: 1280×800 and 390×844. */
export const VIEWPORT_SIZES: Readonly<Record<Viewport, { width: number; height: number }>> = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};
