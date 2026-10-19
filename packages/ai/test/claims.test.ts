import { describe, expect, it } from 'vitest';
import { bannedClaims, introducedClaims } from '../src/claims.ts';

describe('bannedClaims', () => {
  it('uses the claims-lint rules, in order of appearance', () => {
    const rules = bannedClaims('This store is fully accessible and ADA compliant.').map(
      (c) => c.rule,
    );
    expect(rules).toEqual(['absolute-accessibility', 'compliance']);
    expect(bannedClaims('Blue ceramic mug')).toEqual([]);
  });
});

describe('introducedClaims', () => {
  it("keeps the merchant's own words", () => {
    expect(
      introducedClaims('Certified organic cotton tee in navy', ['Certified organic cotton tee']),
    ).toEqual([]);
  });

  it('rejects claims the model added', () => {
    expect(
      introducedClaims('Navy tee, 100% accessible and guaranteed to fit', [
        'Organic cotton tee',
      ]).map((c) => c.rule),
    ).toEqual(['absolute-accessibility', 'guarantee']);
  });

  it('matches case-insensitively and across whitespace', () => {
    expect(introducedClaims('CERTIFIED  organic', ['certified organic'])).toEqual([]);
  });
});
