import { afterEach, describe, expect, it } from 'vitest';
import { healthPort, startHealthServer, type HealthServer } from '../src/health.ts';

let server: HealthServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('healthPort', () => {
  it('defaults to 8080 and reads PORT', () => {
    expect(healthPort(undefined)).toBe(8080);
    expect(healthPort(' ')).toBe(8080);
    expect(healthPort('3000')).toBe(3000);
  });

  it.each(['abc', '-1', '65536', '80.5'])('refuses %j', (value) => {
    expect(() => healthPort(value)).toThrow('PORT must be a port number');
  });
});

describe('the health listener', () => {
  it('answers 200 on GET /healthz and 404 on everything else', async () => {
    server = await startHealthServer('0');
    const base = `http://127.0.0.1:${server.port.toString()}`;
    const ok = await fetch(`${base}/healthz`, { headers: { host: 'healthcheck.railway.app' } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ok');
    for (const [path, method] of [
      ['/', 'GET'],
      ['/readyz', 'GET'],
      ['/healthz/', 'GET'],
      ['/healthz?x=1', 'GET'],
      ['/healthz', 'POST'],
    ] as const) {
      const response = await fetch(`${base}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});
