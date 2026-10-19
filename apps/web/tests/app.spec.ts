import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import process from 'node:process';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { parsePolicy, pinnedPolicy, watchPolicyViolations } from './csp.ts';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Replaces Shopify's CDN scripts with a fake App Bridge that hands out `tokens` in order. */
async function embedded(page: Page, tokens: string[]) {
  await page.route('https://cdn.shopify.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
  await page.addInitScript((queue: string[]) => {
    (globalThis as unknown as { shopify: unknown }).shopify = {
      idToken: () => Promise.resolve(queue.shift() ?? 'none'),
    };
  }, tokens);
}

test('the home page is accessible and cannot be framed', async ({ page }) => {
  const violations = watchPolicyViolations(page);
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Accessibility fixed at the source',
  );
  await axe(page);
  expect(violations).toEqual([]);
});

test('the built app sends the pinned content security policy (audit M3)', async ({ page }) => {
  await page.route('https://cdn.shopify.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
  for (const [href, framing] of [
    ['/', ["'none'"]],
    ['/nope', ["'none'"]],
    [
      '/app?shop=demo-store.myshopify.com&host=abc',
      ['https://admin.shopify.com', 'https://demo-store.myshopify.com'],
    ],
  ] as const) {
    const response = await page.goto(href);
    const header = response?.headers()['content-security-policy'];
    expect(parsePolicy(header), href).toEqual(pinnedPolicy(framing));
    // Each response carries its own nonce, and only SvelteKit's inline script uses it.
    expect(header?.match(/'nonce-[^']+'/g), href).toHaveLength(1);
  }
});

test("scripts run from Shopify's script directory and from nowhere else (audit M3)", async ({
  page,
}) => {
  const violations = watchPolicyViolations(page);
  // Chromium announces a request and then fails it, with a reason that names the policy, when
  // the policy refuses it; the route handlers below never see it.
  const refused = new Map<string, string>();
  page.on('requestfailed', (request) => {
    refused.set(request.url(), request.failure()?.errorText ?? '');
  });
  await embedded(page, ['good']);
  // Registered last, so it wins: every script that runs records the address it came from.
  const records = `(globalThis.__ran ??= []).push(document.currentScript.getAttribute('src'));`;
  for (const host of ['https://cdn.shopify.com/**', 'https://evil.example/**']) {
    await page.route(host, (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: records }),
    );
  }
  await page.goto('/app?shop=demo-store.myshopify.com');
  await expect(page.getByRole('status')).toHaveText(
    'Rampsmith is installed on demo-store.myshopify.com.',
  );
  // The two scripts the page loads itself ran, and the page broke no rule.
  expect(violations).toEqual([]);

  const allowed = 'https://cdn.shopify.com/shopifycloud/later-chunk.js';
  const blocked = [
    // Files merchants upload to the same host.
    'https://cdn.shopify.com/s/files/1/0001/0002/files/upload.js',
    // A directory whose name starts the same way.
    'https://cdn.shopify.com/shopifycloud-evil/x.js',
    // Another directory of Shopify's own.
    'https://cdn.shopify.com/static/fonts/x.js',
    'https://evil.example/x.js',
  ];
  await page.evaluate(
    async (urls) => {
      await Promise.all(
        urls.map(
          (src) =>
            new Promise<void>((resolve) => {
              const script = document.createElement('script');
              script.src = src;
              // `load` for a script that ran, `error` for one the policy refused.
              for (const event of ['load', 'error']) {
                script.addEventListener(event, () => {
                  resolve();
                });
              }
              document.head.append(script);
            }),
        ),
      );
    },
    [allowed, ...blocked],
  );
  // An inline script without the nonce is refused too.
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = '(globalThis.__ran ??= []).push("inline");';
    document.head.append(script);
  });

  const ran = await page.evaluate(() => (globalThis as unknown as { __ran: string[] }).__ran);
  expect(ran.toSorted()).toEqual([
    'https://cdn.shopify.com/shopifycloud/app-bridge.js',
    allowed,
    'https://cdn.shopify.com/shopifycloud/polaris-1.1.js',
  ]);
  // The browser refused each one and said which rule did it.
  for (const url of blocked) {
    expect(refused.get(url), url).toMatch(/csp/i);
    expect(
      violations.filter((message) => message.includes(url) && message.includes('script-src')),
      url,
    ).toHaveLength(1);
  }
  expect([...refused.keys()].toSorted()).toEqual(blocked.toSorted());
  expect(violations.filter((message) => message.includes('inline script'))).toHaveLength(1);
});

test('the platform health check answers without touching the api', async ({ request }) => {
  const response = await request.get('/healthz');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('the skip link moves focus to the main content', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
});

test('the embedded app loads App Bridge, may be framed by the shop, and starts a session', async ({
  page,
}) => {
  const violations = watchPolicyViolations(page);
  await embedded(page, ['good']);
  const response = await page.goto('/app?shop=demo-store.myshopify.com&host=abc');
  expect(response?.headers()['content-security-policy']).toContain(
    'frame-ancestors https://admin.shopify.com https://demo-store.myshopify.com',
  );
  await expect(page.locator('meta[name="shopify-api-key"]')).toHaveAttribute(
    'content',
    'e2e-client-id',
  );
  await expect(page.locator('head script[src$="/shopifycloud/app-bridge.js"]')).toHaveCount(1);
  await expect(page.locator('head script[src$="/shopifycloud/polaris-1.1.js"]')).toHaveCount(1);
  await expect(page.getByRole('status')).toHaveText(
    'Rampsmith is installed on demo-store.myshopify.com.',
  );
  await axe(page);
  // Nothing the embedded page loads or does is refused by the content security policy.
  expect(violations).toEqual([]);
});

test('a stale session token is replaced once and the session starts', async ({ page }) => {
  await embedded(page, ['stale', 'good']);
  await page.goto('/app?shop=demo-store.myshopify.com');
  await expect(page.getByRole('status')).toHaveText(
    'Rampsmith is installed on demo-store.myshopify.com.',
  );
});

test('a session that cannot start says so accessibly', async ({ page }) => {
  await embedded(page, ['bad', 'worse']);
  await page.goto('/app?shop=demo-store.myshopify.com');
  await expect(page.getByText('Rampsmith could not reach your store')).toBeVisible();
  await axe(page);
});

test('unknown pages answer 404 with an accessible page', async ({ page }) => {
  const response = await page.goto('/nope');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  await axe(page);
});

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

test('exported telemetry carries no launch parameter, token or shop name (audit M2)', async () => {
  // A second copy of the built app exports its spans to a collector this test runs. The OTLP
  // body is protobuf, in which strings are plain bytes, so searching it searches every attribute.
  const bodies: Buffer[] = [];
  const collector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks));
      response.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const collectorPort = (collector.address() as AddressInfo).port;
  const appPort = await freePort();
  const app = spawn(process.execPath, ['build'], {
    env: {
      PATH: process.env['PATH'],
      HOST: '127.0.0.1',
      PORT: appPort.toString(),
      API_URL: 'http://127.0.0.1:3998',
      SHOPIFY_API_KEY: 'e2e-client-id',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort.toString()}`,
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_BSP_SCHEDULE_DELAY: '200',
    },
    stdio: 'ignore',
  });
  const origin = `http://127.0.0.1:${appPort.toString()}`;
  try {
    await expect
      .poll(
        () =>
          fetch(`${origin}/healthz`).then(
            (response) => response.status,
            () => 0,
          ),
        { timeout: 20_000 },
      )
      .toBe(200);
    const launch = `${origin}/app?embedded=1&hmac=x&id_token=y&session=z&shop=s.myshopify.com`;
    expect((await fetch(launch)).status).toBe(200);
    // The root span for the request has left the process, with its address cut to the path
    // (SvelteKit sees https here: adapter-node assumes it without a protocol header).
    await expect
      .poll(() => Buffer.concat(bodies).toString('latin1'), { timeout: 20_000 })
      .toContain(`://127.0.0.1:${appPort.toString()}/app`);
    const wire = Buffer.concat(bodies).toString('latin1');
    expect(wire).toContain('sveltekit.handle.root');
    for (const word of ['id_token', 'hmac', 'session', 'myshopify', 'embedded=1']) {
      expect(wire, word).not.toContain(word);
    }
  } finally {
    app.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      collector.close(() => {
        resolve();
      });
    });
  }
});
