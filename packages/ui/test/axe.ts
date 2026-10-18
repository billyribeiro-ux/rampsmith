import axe from 'axe-core';
import { expect } from 'vitest';

/** The tag set the engine scans with (PLAN §11): WCAG 2.2 A and AA. */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Fails with every WCAG 2.2 A/AA violation axe finds inside `root`. */
export async function expectAccessible(root: Element): Promise<void> {
  const results = await axe.run(root, {
    runOnly: { type: 'tag', values: WCAG },
    resultTypes: ['violations'],
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}
