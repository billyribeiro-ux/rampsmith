/** A local storefront for browser tests: pages with known failures, a clean page, a challenge. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const LAYOUT = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`;

const PAGES: Record<string, { status: number; html: string }> = {
  '/': {
    status: 200,
    html: LAYOUT(
      'Demo store',
      `<div id="shopify-section-template--1234__main">
         <img src="/scarf.png">
         <a href="/products/scarf"></a>
         <p style="color:#bbb;background:#fff">Low contrast price</p>
         <input type="email" value="shopper@example.com" aria-label="Email">
       </div>`,
    ),
  },
  '/clean': {
    status: 200,
    html: LAYOUT('Clean page', '<p>Nothing to fix here.</p>'),
  },
  // Two 16-pixel buttons side by side: each fails 2.5.8 Target Size (Minimum).
  '/targets': {
    status: 200,
    html: LAYOUT(
      'Small targets',
      `<div style="display:flex;gap:0">
         <button type="button" style="width:16px;height:16px;padding:0;border:0" aria-label="Previous"></button>
         <button type="button" style="width:16px;height:16px;padding:0;border:0" aria-label="Next"></button>
       </div>`,
    ),
  },
  '/challenge': {
    status: 403,
    html: `<!doctype html><html lang="en"><head><title>Just a moment...</title></head>
           <body><div id="cf-chl-widget"></div></body></html>`,
  },
};

export interface Site {
  readonly origin: string;
  readonly port: number;
  readonly requests: string[];
  close(): Promise<void>;
}

export async function startSite(): Promise<Site> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const page = PAGES[req.url ?? ''];
    if (page === undefined) {
      res.writeHead(req.url === '/scarf.png' ? 200 : 404, { 'content-type': 'image/png' }).end();
      return;
    }
    res.writeHead(page.status, { 'content-type': 'text/html; charset=utf-8' }).end(page.html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port.toString()}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
