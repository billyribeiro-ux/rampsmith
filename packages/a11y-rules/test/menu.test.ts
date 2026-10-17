import { describe, expect, it } from 'vitest';
import { auditMenu, type MenuItemInput } from '../src/data/menu.ts';

let counter = 0;
function item(
  title: string,
  url: string | null = '/x',
  items: MenuItemInput[] = [],
): MenuItemInput {
  counter += 1;
  return { resource: `gid://shopify/MenuItem/${String(counter)}`, title, url, items };
}

describe('auditMenu', () => {
  it('flags an item with an empty or blank label', () => {
    const blank = item('  ');
    const findings = auditMenu({ resource: 'gid://shopify/Menu/1', items: [item('Shop'), blank] });
    expect(findings).toEqual([
      {
        ruleId: 'rs-menu-item-label-empty',
        criteria: ['2.4.4', '4.1.2'],
        impact: 'serious',
        outcome: 'violation',
        bestPractice: false,
        location: { resource: blank.resource, field: 'title', start: 0, end: 2 },
      },
    ]);
  });

  it('flags siblings with the same label and different destinations', () => {
    const first = item('Sale', '/collections/sale');
    const second = item(' sale ', '/collections/clearance');
    const findings = auditMenu({ resource: 'm', items: [first, second] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'rs-menu-item-label-duplicate',
      criteria: ['2.4.4'],
      impact: 'moderate',
      location: { resource: second.resource, field: 'title', start: 0, end: 6 },
      data: { duplicateOf: first.resource },
    });
  });

  it('accepts the same label for the same destination, or under different parents', () => {
    expect(auditMenu({ resource: 'm', items: [item('Sale', '/s'), item('Sale', '/s/')] })).toEqual(
      [],
    );
    const tree = [
      item('Women', '/w', [item('New', '/w/new')]),
      item('Men', '/m', [item('New', '/m/new')]),
    ];
    expect(auditMenu({ resource: 'm', items: tree })).toEqual([]);
  });

  it('checks nested levels', () => {
    const nested = item('', '/deep');
    const tree = [item('A', '/a', [item('B', '/b', [nested])])];
    expect(auditMenu({ resource: 'm', items: tree }).map((f) => f.location.resource)).toEqual([
      nested.resource,
    ]);
  });

  it('terminates on cyclic input and visits each item once', () => {
    const children: MenuItemInput[] = [];
    const loop: MenuItemInput = { resource: 'loop', title: '', url: null, items: children };
    children.push(loop, loop);
    const findings = auditMenu({ resource: 'm', items: [loop] });
    expect(findings).toHaveLength(1);
  });

  it('stays bounded on very wide menus', () => {
    const wide = Array.from({ length: 20_000 }, () => item(''));
    expect(auditMenu({ resource: 'm', items: wide })).toHaveLength(10_000);
  });
});
