import { describe, expect, it } from 'vitest';
import { createEmailRenderer, SettingsError } from '../src/index.ts';
import { FIXTURES, SETTINGS } from './fixtures.ts';

const HOOKS = 'https://hooks.rampsmith.example';
const ONE_CLICK = `${HOOKS}/webhooks/email/unsubscribe?t=TESTONLYoneclick`;

function welcomeInput(extra: Record<string, unknown>): unknown {
  const fixture = FIXTURES.welcome[0];
  if (fixture === undefined) throw new Error('no welcome fixture');
  return { ...fixture[1], ...extra };
}

describe('the RFC 8058 one-click address (ADR-274)', () => {
  const emails = createEmailRenderer({ ...SETTINGS, oneClickOrigin: HOOKS });

  it('goes in List-Unsubscribe while the visible link stays on the app origin', () => {
    const email = emails.renderUnknown('welcome', welcomeInput({ oneClickUrl: ONE_CLICK }));
    expect(email.headers['List-Unsubscribe']).toBe(`<${ONE_CLICK}>`);
    expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(email.text).toContain(
      'Turn off emails like this one:\nhttps://app.rampsmith.example/email/unsubscribe?t=',
    );
    expect(email.text).not.toContain(HOOKS);
    expect(email.html).not.toContain(HOOKS);
    expect(email.problems).toEqual([]);
  });

  it('falls back to the visible link when no one-click address is given', () => {
    const input = welcomeInput({}) as { unsubscribeUrl: string };
    const email = emails.renderUnknown('welcome', input);
    expect(email.headers['List-Unsubscribe']).toBe(`<${input.unsubscribeUrl}>`);
  });

  it('refuses a one-click address on any other origin', () => {
    for (const bad of [
      'https://evil.example/webhooks/email/unsubscribe?t=x',
      'https://app.rampsmith.example/email/unsubscribe?t=x',
      'http://hooks.rampsmith.example/webhooks/email/unsubscribe?t=x',
      `https://user:pass@hooks.rampsmith.example/x`,
    ]) {
      expect(
        () => emails.renderUnknown('welcome', welcomeInput({ oneClickUrl: bad })),
        bad,
      ).toThrow(/oneClickUrl/u);
    }
  });

  it('reports a plain-HTTP one-click origin as a send problem', () => {
    const local = createEmailRenderer({ ...SETTINGS, oneClickOrigin: 'http://localhost:8081' });
    const email = local.renderUnknown(
      'welcome',
      welcomeInput({ oneClickUrl: 'http://localhost:8081/webhooks/email/unsubscribe?t=x' }),
    );
    expect(email.problems).toContain('unsubscribe-not-https');
  });

  it('rejects an origin that is not an origin', () => {
    expect(() => createEmailRenderer({ ...SETTINGS, oneClickOrigin: `${HOOKS}/path` })).toThrow(
      SettingsError,
    );
  });
});
