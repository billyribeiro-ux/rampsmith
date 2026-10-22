/**
 * Password-protected storefronts (PLAN §11, "Operating rules"; ADR-071). Shopify answers every
 * storefront URL of a protected store with a redirect to `/password`, a page with one form that
 * posts the password to `/password`. The engine opens it only with a password handed to it for
 * this scan; it never holds a key to unseal the stored one (ADR-035), never writes the password
 * anywhere, and reports a protected store it could not open as blocked.
 */
import type { Page } from 'playwright';

/** Whether the page is Shopify's storefront password page. */
export function isPasswordPage(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === '/password';
  } catch {
    return false;
  }
}

/** Submits `password` on the password page; true when the store let the browser through. */
export async function unlockStorefront(
  page: Page,
  password: string,
  timeoutMs: number,
): Promise<boolean> {
  const input = page.locator('form[action$="/password"] input[type="password"]').first();
  try {
    await input.fill(password, { timeout: timeoutMs });
    await Promise.all([
      page.waitForURL((u) => !isPasswordPage(u.href), { timeout: timeoutMs }),
      input.press('Enter', { timeout: timeoutMs }),
    ]);
    return true;
  } catch {
    return false;
  }
}
