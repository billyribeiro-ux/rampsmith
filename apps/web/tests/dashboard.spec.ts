import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

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

test('signed-out visitors are sent to an accessible sign-in page', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  const response = await page.request.get('/dashboard/sign-in');
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await axe(page);
});

test('register with a passkey, sign out, and sign back in with it', async ({ page, context }) => {
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

  // The session token lives only in an HttpOnly cookie.
  const session = (await context.cookies()).find((c) => c.name === 'rs_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Lax');
  expect(await page.evaluate(() => document.cookie)).not.toContain('rs_session');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/);
  expect((await context.cookies()).find((c) => c.name === 'rs_session')).toBeUndefined();

  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText(`Signed in as Ada Lovelace (${email}).`)).toBeVisible();
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
