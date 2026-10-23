import postgres from 'postgres';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { parsePolicy, pinnedPolicy, watchPolicyViolations } from './csp.ts';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Chromium's virtual platform authenticator: resident keys and user verification. */
async function platformAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

const SESSION_COOKIE = '__Host-rs_session';

/** Every `Set-Cookie` header the page's responses carry, as the server wrote it. */
function watchSetCookies(page: Page): string[] {
  const seen: string[] = [];
  page.on('response', (response) => {
    void response.headersArray().then(
      (headers) => {
        for (const { name, value } of headers) {
          if (name.toLowerCase() === 'set-cookie') seen.push(value);
        }
      },
      () => undefined,
    );
  });
  return seen;
}

/** A `Set-Cookie` header as its lower-cased attributes, without the name and value. */
function attributes(setCookie: string): string[] {
  return setCookie
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase());
}

test('signed-out visitors are sent to an accessible sign-in page', async ({ page }) => {
  const violations = watchPolicyViolations(page);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  const response = await page.request.get('/dashboard/sign-in');
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  // The dashboard gets the same pinned policy as every page (audit M3, ADR-054).
  expect(parsePolicy(response.headers()['content-security-policy'])).toEqual(
    pinnedPolicy(["'none'"]),
  );
  // Dashboard pages are never stored by a shared cache or kept for the back button (audit L8).
  expect(response.headers()['cache-control']).toBe('private, no-store');
  const redirect = await page.request.get('/dashboard', { maxRedirects: 0 });
  expect(redirect.status()).toBe(303);
  expect(redirect.headers()['cache-control']).toBe('private, no-store');
  await axe(page);
  expect(violations).toEqual([]);
});

test('a session the api has ended is dropped from the browser', async ({ page, context }) => {
  await platformAuthenticator(page);
  await page.goto('/dashboard/register');
  await page.getByLabel('Email address').fill(`lin+${Date.now().toString()}@example.com`);
  await page.getByLabel('Your name').fill('Lin');
  await page.getByRole('button', { name: 'Create account with a passkey' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const token = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  expect(token).not.toBe('');

  // The session ends at the api (expiry, or sign-out elsewhere) while the browser keeps the cookie.
  const ended = await fetch('http://127.0.0.1:3997/v1/auth/session', {
    method: 'DELETE',
    headers: { authorization: `Session ${token}` },
  });
  expect(ended.ok).toBe(true);

  // A __Host- cookie is deleted only by a Set-Cookie that is itself Secure, Path=/ and has no
  // Domain. Over http://localhost SvelteKit's own default would be Secure=false, and the browser
  // would keep the dead cookie.
  const setCookies = watchSetCookies(page);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/);
  expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  await expect.poll(() => setCookies.length).toBeGreaterThan(0);
  const deletion = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=;`));
  expect(attributes(deletion ?? '')).toEqual(
    expect.arrayContaining(['path=/', 'max-age=0', 'secure']),
  );
});

test('register with a passkey, sign out, and sign back in with it', async ({ page, context }) => {
  const violations = watchPolicyViolations(page);
  const setCookies = watchSetCookies(page);
  await platformAuthenticator(page);
  const email = `ada+${Date.now().toString()}@example.com`;

  await page.goto('/dashboard/sign-in');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create an account');
  await axe(page);

  // Keyboard only: fill both fields and submit with Enter.
  await page.getByLabel('Email address').focus();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Your name')).toBeFocused();
  await page.keyboard.type('Ada Lovelace');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText(`Signed in as Ada Lovelace (${email}).`)).toBeVisible();
  await axe(page);

  // The session token lives only in an HttpOnly cookie that the browser accepted under the
  // __Host- prefix, on http://localhost too (audit L8, ADR-055).
  const session = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
  expect(session?.httpOnly).toBe(true);
  expect(session?.secure).toBe(true);
  expect(session?.path).toBe('/');
  expect(session?.sameSite).toBe('Lax');
  expect(await page.evaluate(() => document.cookie)).not.toContain('rs_session');
  await expect.poll(() => setCookies.length).toBeGreaterThan(0);
  const issued = setCookies.filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
  expect(issued).toHaveLength(1);
  expect(attributes(issued[0] ?? '')).toEqual(
    expect.arrayContaining(['path=/', 'httponly', 'secure', 'samesite=lax']),
  );
  expect(attributes(issued[0] ?? '').filter((a) => a.startsWith('domain'))).toEqual([]);
  // A signed-in dashboard page is no-store too, and the cookie the browser holds opens it.
  const dashboard = await page.request.get('/dashboard');
  expect(dashboard.status()).toBe(200);
  expect(dashboard.headers()['cache-control']).toBe('private, no-store');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/);
  expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  // The cookie is gone because the deletion was itself Secure; without it the browser ignores
  // a Set-Cookie for a __Host- name.
  const deletion = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=;`));
  expect(attributes(deletion ?? '')).toEqual(
    expect.arrayContaining(['path=/', 'max-age=0', 'secure']),
  );

  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText(`Signed in as Ada Lovelace (${email}).`)).toBeVisible();
  // Registering, signing out and signing in broke no rule of the content security policy.
  expect(violations).toEqual([]);
});

test('an email that already has an account is refused with a message', async ({ page }) => {
  await platformAuthenticator(page);
  const email = `grace+${Date.now().toString()}@example.com`;
  for (const attempt of [1, 2]) {
    await page.goto('/dashboard/register');
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Your name').fill('Grace');
    await page.getByRole('button', { name: 'Create account with a passkey' }).click();
    if (attempt === 1) {
      await expect(page).toHaveURL(/\/dashboard$/);
      await page.getByRole('button', { name: 'Sign out' }).click();
    }
  }
  await expect(page.getByRole('alert')).toContainText('An account already uses this email');
  await axe(page);
});

test('a dismissed passkey prompt leaves the user on the page with a message', async ({ page }) => {
  // No authenticator: the browser rejects the request, as when a user cancels.
  await page.goto('/dashboard/sign-in');
  await page.evaluate(() => {
    navigator.credentials.get = () =>
      Promise.reject(new DOMException('The operation was cancelled', 'NotAllowedError'));
  });
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toContainText('Sign-in did not complete');
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/);
  await axe(page);
});

test('an agency creates an organization and a link code, and follows a store that approved', async ({
  page,
}) => {
  await platformAuthenticator(page);
  const stamp = Date.now().toString();
  await page.goto('/dashboard/register');
  await page.getByLabel('Email address').fill(`agency+${stamp}@example.com`);
  await page.getByLabel('Your name').fill('Agnes');
  await page.getByRole('button', { name: 'Create account with a passkey' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Reachable from the dashboard, with the keyboard.
  await page.getByRole('link', { name: 'Agency stores' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/agency$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agency stores');
  await expect(page.getByText('No store has approved a link yet.')).toBeVisible();
  await axe(page);

  await page.getByLabel('Organization name').fill(`Northwind ${stamp}`);
  await page.getByRole('button', { name: 'Create organization' }).click();
  const make = page.getByRole('button', { name: `Create a link code for Northwind ${stamp}` });
  await expect(make).toBeVisible();
  await make.focus();
  await page.keyboard.press('Enter');
  const code = page.locator('output');
  await expect(code).toHaveText(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  await expect(page.getByText('It cannot be shown again.')).toBeVisible();
  await axe(page);

  // The merchant's approval happens in the embedded app (covered by the api and App Home tests);
  // here the grant is written as the owner so the overview and the unlink can be exercised.
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') throw new Error('DATABASE_URL is required');
  const sql = postgres(url, { database: 'rampsmith_e2e', max: 1, onnotice: () => undefined });
  try {
    const [org] = await sql<{ id: string }[]>`
      select id from organizations where name = ${`Northwind ${stamp}`}`;
    const domain = `agency-${stamp}.myshopify.com`;
    const [tenant] = await sql<{ id: string }[]>`
      insert into tenants (id, kind) values (gen_random_uuid(), 'shopify_store') returning id`;
    const [site] = await sql<{ id: string }[]>`
      insert into sites (id, tenant_id, platform, base_url)
      values (gen_random_uuid(), ${tenant?.id ?? ''}, 'shopify', ${`https://${domain}`})
      returning id`;
    const [shop] = await sql<{ id: string }[]>`
      insert into shopify_shops (id, tenant_id, site_id, shop_domain, scopes, api_version, status,
                                 installed_at)
      values (gen_random_uuid(), ${tenant?.id ?? ''}, ${site?.id ?? ''}, ${domain}, '{}',
              '2026-10', 'installed', now())
      returning id`;
    await sql`
      insert into store_links (id, tenant_id, shop_id, organization_id)
      values (gen_random_uuid(), ${tenant?.id ?? ''}, ${shop?.id ?? ''}, ${org?.id ?? ''})`;
  } finally {
    await sql.end();
  }
  await page.reload();
  const row = page.getByRole('row').filter({ hasText: `agency-${stamp}.myshopify.com` });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Not scanned yet');
  await axe(page);

  // Stopping to follow takes effect at once.
  const stop = row.getByRole('button', { name: `Stop following agency-${stamp}.myshopify.com` });
  await stop.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('No store has approved a link yet.')).toBeVisible();
  const [left] = await postgresCount(url, stamp);
  expect(left).toBe(0);
});

/** Live links for the store the test linked: zero once the agency ended the link. */
async function postgresCount(url: string, stamp: string): Promise<[number]> {
  const sql = postgres(url, { database: 'rampsmith_e2e', max: 1, onnotice: () => undefined });
  try {
    const [row] = await sql<{ n: string }[]>`
      select count(*) as n from store_links l join shopify_shops s on s.id = l.shop_id
       where s.shop_domain = ${`agency-${stamp}.myshopify.com`} and l.revoked_at is null`;
    return [Number(row?.n ?? '-1')];
  } finally {
    await sql.end();
  }
}
