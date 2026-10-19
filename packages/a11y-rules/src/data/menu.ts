// Menu items with empty or duplicate labels (PLAN §11, "Data audit"). A menu item renders as
// a link whose name is its label: an empty label leaves the link unnamed (WCAG 2.2 SC 2.4.4
// and 4.1.2), and two items at the same level with the same label but different destinations
// cannot be told apart from their context, which is the same list (SC 2.4.4).
// Shopify nests menu items up to 3 levels (Admin GraphQL 2026-10, `Menu`); the walk accepts
// any shape, bounded in depth and size, and never follows an item twice.
import { findingBase } from '../rules.ts';
import type { DataFinding } from '../types.ts';

export interface MenuItemInput {
  /** The menu item resource, such as `gid://shopify/MenuItem/1`. */
  readonly resource: string;
  readonly title: string;
  /** The destination, when the item links somewhere. */
  readonly url: string | null;
  readonly items: readonly MenuItemInput[];
}

export interface MenuInput {
  readonly resource: string;
  readonly items: readonly MenuItemInput[];
}

const MAX_DEPTH = 16;
const MAX_ITEMS = 10_000;

function normalizeLabel(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function normalizeUrl(url: string | null): string {
  const value = (url ?? '').trim();
  // Trailing slashes trimmed with a loop: /\/+$/ backtracks quadratically on long slash runs.
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end).toLowerCase();
}

export function auditMenu(menu: MenuInput): readonly DataFinding[] {
  const findings: DataFinding[] = [];
  const seen = new Set<MenuItemInput>();
  let visited = 0;
  // Breadth-first, one sibling list at a time; the loop reads lists appended while it runs.
  const levels: { readonly items: readonly MenuItemInput[]; readonly depth: number }[] = [
    { items: menu.items, depth: 1 },
  ];

  for (const level of levels) {
    const firstByLabel = new Map<string, MenuItemInput>();
    for (const item of level.items) {
      if (seen.has(item) || visited >= MAX_ITEMS) continue;
      seen.add(item);
      visited += 1;
      const title = item.title;
      const location = { resource: item.resource, field: 'title', start: 0, end: title.length };
      const label = normalizeLabel(title);
      if (label === '') {
        findings.push({ ...findingBase('rs-menu-item-label-empty', 'violation'), location });
      } else {
        const first = firstByLabel.get(label);
        if (first === undefined) firstByLabel.set(label, item);
        else if (normalizeUrl(first.url) !== normalizeUrl(item.url)) {
          findings.push({
            ...findingBase('rs-menu-item-label-duplicate', 'violation'),
            location,
            data: { duplicateOf: first.resource },
          });
        }
      }
      if (level.depth < MAX_DEPTH && Array.isArray(item.items) && item.items.length > 0) {
        levels.push({ items: item.items, depth: level.depth + 1 });
      }
    }
  }
  return findings;
}
