/**
 * The two browser hops of connecting GitHub (ADR-291): the cookie that binds the browser to the
 * one-time state, the redirect to GitHub's installation page, and what the callback does with
 * what GitHub sends back. The api is tests/mock-api.ts; GitHub itself is never contacted (the
 * redirect is read, not followed).
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { axe, PROXY_HEADERS, SITE_API } from './site-helpers.ts';

test.use({ baseURL: SITE_API, extraHTTPHeaders: PROXY_HEADERS });

const STATE = 'S'.repeat(43);

async function seen(request: APIRequestContext): Promise<object[]> {
  return (await (await request.get('http://127.0.0.1:3998/__github')).json()) as object[];
}

test('connect puts the state in an HttpOnly cookie and sends the browser to the App', async ({
  request,
}) => {
  const response = await request.get(`/github/connect?state=${STATE}`, { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers()['location']).toBe(
    `https://github.com/apps/rampsmith-e2e/installations/new?state=${STATE}`,
  );
  const cookie = response.headers()['set-cookie'] ?? '';
  expect(cookie).toContain(`rampsmith_github_state=${STATE}`);
  expect(cookie).toMatch(/HttpOnly/iu);
  expect(cookie).toMatch(/SameSite=Lax/iu);
  expect(cookie).toMatch(/Path=\/github/iu);
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
  expect(response.headers()['cache-control']).toContain('no-store');
});

test('connect refuses a state that is not one of ours, without setting a cookie', async ({
  request,
}) => {
  const response = await request.get('/github/connect?state=short', { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers()['location']).toBe('/github/connected?result=unavailable');
  expect(response.headers()['set-cookie']).toBeUndefined();
});

test('the callback hands the cookie state and GitHub code to the api and clears the cookie', async ({
  page,
  context,
  request,
}) => {
  await context.addCookies([
    { name: 'rampsmith_github_state', value: STATE, domain: '127.0.0.1', path: '/github' },
  ]);
  await page.goto(`/github/callback?code=fine&installation_id=4242&state=${STATE}`);
  await expect(page).toHaveURL(/\/github\/connected\?result=connected$/u);
  await expect(page.getByRole('heading', { level: 1, name: 'GitHub' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'GitHub is connected' })).toBeVisible();
  const sent = (await seen(request)).at(-1);
  expect(sent).toEqual({
    state: STATE,
    echoed_state: STATE,
    code: 'fine',
    installation_id: 4242,
  });
  const cookies = await context.cookies(`${SITE_API}/github`);
  expect(cookies.find((c) => c.name === 'rampsmith_github_state')).toBeUndefined();
  await axe(page);
});

test('a callback without the cookie never reaches the api', async ({ page, request }) => {
  const before = (await seen(request)).length;
  await page.goto('/github/callback?code=fine&installation_id=4242');
  await expect(
    page.getByRole('heading', { level: 2, name: 'This link has expired' }),
  ).toBeVisible();
  expect((await seen(request)).length).toBe(before);
  await axe(page);
});

for (const [code, heading] of [
  ['denied', 'GitHub could not be connected'],
  ['taken', 'GitHub could not be connected'],
  ['spent', 'This link has expired'],
  ['down', 'GitHub did not answer'],
] as const) {
  test(`the api answering "${code}" is shown as "${heading}"`, async ({ page, context }) => {
    await context.addCookies([
      { name: 'rampsmith_github_state', value: STATE, domain: '127.0.0.1', path: '/github' },
    ]);
    await page.goto(`/github/callback?code=${code}&installation_id=7`);
    await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
    await axe(page);
  });
}

test('a malformed installation id is refused before the api is asked', async ({
  page,
  context,
  request,
}) => {
  await context.addCookies([
    { name: 'rampsmith_github_state', value: STATE, domain: '127.0.0.1', path: '/github' },
  ]);
  const before = (await seen(request)).length;
  await page.goto('/github/callback?code=fine&installation_id=abc');
  await expect(
    page.getByRole('heading', { level: 2, name: 'GitHub could not be connected' }),
  ).toBeVisible();
  expect((await seen(request)).length).toBe(before);
});
