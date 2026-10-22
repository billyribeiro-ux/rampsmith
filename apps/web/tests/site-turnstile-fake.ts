/**
 * A stand-in for Cloudflare Turnstile in browser tests (LAUNCH.md section C, row 6): the real
 * service needs the founder's Cloudflare widget, so the site tests point `TURNSTILE_ORIGIN` here.
 * It serves the two things the site uses and follows Cloudflare's documented behaviour:
 *
 * - `GET /turnstile/v0/api.js`: a script with the explicit-render API (`render`, `reset`,
 *   `remove`) that puts a `cf-turnstile-response` field and a visible status in the container.
 *   Every render and reset issues a new single-use token, `fake-pass-<n>`.
 * - `POST /turnstile/v0/siteverify`: form data with `secret` and `response`. It answers
 *   `success: true` once per issued token and `timeout-or-duplicate` after that, and it answers
 *   `invalid-input-secret` for any secret but `fake-secret` and `invalid-input-response` for a
 *   token that does not start with `fake-pass-`.
 * - `GET /calls`: the siteverify requests seen, so a test can check what the site sent.
 */
import { createServer } from 'node:http';
import process from 'node:process';

const port = Number(process.env['TURNSTILE_FAKE_PORT'] ?? '3990');
const SECRET = 'fake-secret';

const used = new Set<string>();
const calls: { secret: string; response: string; remoteip: string | null }[] = [];

const script = `
(() => {
  let counter = 0;
  const fresh = () => 'fake-pass-' + (++counter) + '-' + Math.random().toString(36).slice(2, 10);
  const widgets = new Map();
  const status = (input) => {
    const label = input.parentElement.querySelector('[data-fake-status]');
    label.textContent = 'Bot check passed (test stand-in)';
  };
  globalThis.turnstile = {
    render(container, options) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'cf-turnstile-response';
      const label = document.createElement('p');
      label.setAttribute('data-fake-status', '');
      container.append(input, label);
      const id = 'fake-' + widgets.size;
      widgets.set(id, { input, options });
      input.value = fresh();
      status(input);
      if (options && options.callback) options.callback(input.value);
      return id;
    },
    reset(id) {
      const widget = widgets.get(id);
      if (widget) { widget.input.value = fresh(); status(widget.input); }
    },
    remove(id) {
      const widget = widgets.get(id);
      if (widget) { widget.input.nextElementSibling.remove(); widget.input.remove(); widgets.delete(id); }
    },
  };
})();
`;

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (request.method === 'GET' && url.pathname === '/turnstile/v0/api.js') {
    // The tokens are made by this script in the page; the server accepts any `fake-pass-` token
    // that has not been used yet, which is what single use means.
    response.writeHead(200, { 'content-type': 'text/javascript' }).end(script);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/calls') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(calls));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/turnstile/v0/siteverify') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const token = form.get('response') ?? '';
      calls.push({
        secret: form.get('secret') ?? '',
        response: token,
        remoteip: form.get('remoteip'),
      });
      const reply = (body: object) =>
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (form.get('secret') !== SECRET) {
        reply({ success: false, 'error-codes': ['invalid-input-secret'] });
      } else if (token === '') {
        reply({ success: false, 'error-codes': ['missing-input-response'] });
      } else if (!token.startsWith('fake-pass-')) {
        reply({ success: false, 'error-codes': ['invalid-input-response'] });
      } else if (used.has(token)) {
        reply({ success: false, 'error-codes': ['timeout-or-duplicate'] });
      } else {
        used.add(token);
        reply({ success: true, hostname: 'localhost', challenge_ts: new Date().toISOString() });
      }
    });
    return;
  }
  response.writeHead(404).end();
}).listen(port, '127.0.0.1');
