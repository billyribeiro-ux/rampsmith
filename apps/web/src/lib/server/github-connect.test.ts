import { describe, expect, it } from 'vitest';
import type { ApiClient } from '@rampsmith/contracts-ts';
import { finishConnection, installationUrl, outcomeOf, stateOf } from './github-connect.ts';

const STATE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

function client(status: number | 'throw'): { client: ApiClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const fake = {
    POST: (path: string, init: unknown) => {
      calls.push([path, init]);
      return status === 'throw'
        ? Promise.reject(new Error('down'))
        : Promise.resolve({ response: { status } });
    },
  };
  return { client: fake as unknown as ApiClient, calls };
}

const input = { state: STATE, echoed: null, code: 'c0de', installationId: '42' };

describe('the state', () => {
  it('is 43 URL-safe characters or nothing', () => {
    expect(stateOf(STATE)).toBe(STATE);
    for (const bad of [undefined, null, 5, '', 'short', `${STATE}x`, `${STATE.slice(1)}/`, 'a b']) {
      expect(stateOf(bad)).toBeUndefined();
    }
  });
});

describe('installationUrl', () => {
  it('names the App and carries the state', () => {
    expect(installationUrl('rampsmith', STATE)).toBe(
      `https://github.com/apps/rampsmith/installations/new?state=${STATE}`,
    );
  });

  it('refuses an unset or odd slug, and a state that is not ours', () => {
    for (const slug of ['', '-x', 'x-', 'Ramp', 'a/b', 'a?b', 'x'.repeat(40)]) {
      expect(installationUrl(slug, STATE)).toBeUndefined();
    }
    expect(installationUrl('rampsmith', 'nope')).toBeUndefined();
  });
});

describe('finishConnection', () => {
  it('passes what GitHub sent, with the state from the cookie, to the api', async () => {
    const { client: c, calls } = client(200);
    expect(await finishConnection(c, { ...input, echoed: STATE })).toBe('connected');
    expect(calls).toEqual([
      [
        '/v1/github/callback',
        {
          body: { state: STATE, echoed_state: STATE, code: 'c0de', installation_id: 42 },
        },
      ],
    ]);
  });

  it('sends no echoed state when GitHub added none', async () => {
    const { client: c, calls } = client(200);
    await finishConnection(c, input);
    expect(JSON.stringify(calls)).toContain('"echoed_state":null');
  });

  it('does not ask the api without the cookie, a code or a plain installation id', async () => {
    const { client: c, calls } = client(200);
    expect(await finishConnection(c, { ...input, state: undefined })).toBe('expired');
    expect(await finishConnection(c, { ...input, code: null })).toBe('refused');
    expect(await finishConnection(c, { ...input, code: 'x'.repeat(513) })).toBe('refused');
    for (const id of [null, '', '0', '-1', '4x', '1e3', '99999999999999999999']) {
      expect(await finishConnection(c, { ...input, installationId: id })).toBe('refused');
    }
    expect(calls).toEqual([]);
  });

  it.each([
    [400, 'expired'],
    [403, 'refused'],
    [409, 'refused'],
    [404, 'unavailable'],
    [502, 'unavailable'],
    [500, 'unavailable'],
    ['throw', 'unavailable'],
  ] as const)('reads api answer %s as %s', async (status, outcome) => {
    expect(await finishConnection(client(status).client, input)).toBe(outcome);
  });
});

describe('outcomeOf', () => {
  it('knows its four words and nothing else', () => {
    for (const word of ['connected', 'expired', 'refused', 'unavailable'] as const) {
      expect(outcomeOf(word)).toBe(word);
    }
    for (const other of [null, '', 'ok', '<script>', 'CONNECTED']) {
      expect(outcomeOf(other)).toBe('unavailable');
    }
  });
});
