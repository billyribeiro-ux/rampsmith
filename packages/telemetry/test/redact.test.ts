/**
 * Audit M2 (PLAN §19, §21): telemetry carries ids, never tokens, query strings or shop names.
 * SvelteKit's root span sets `http.url` to the full request URL, which on the embedded app
 * holds Shopify's `id_token`, `hmac`, `session` and `shop` launch parameters.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, trace, type Attributes } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTelemetry, type Telemetry } from '../src/index.ts';
import { UrlRedactingSpanProcessor, redactText, redactUrl } from '../src/redact.ts';

const LAUNCH_URL =
  'http://localhost:3000/app?embedded=1&hmac=x&id_token=y&session=z&shop=s.myshopify.com';
const FORBIDDEN = ['id_token', 'hmac', 'session', 'myshopify', 's.myshopify.com', 'embedded=1'];

function expectClean(value: unknown): void {
  const text = JSON.stringify(value);
  for (const word of FORBIDDEN) expect(text, word).not.toContain(word);
}

describe('redactUrl', () => {
  it.each([
    [LAUNCH_URL, 'http://localhost:3000/app'],
    ['https://shop.example/a/b?x=1#frag', 'https://shop.example/a/b'],
    ['https://user:pw@shop.example:8443/a?x=1', 'https://shop.example:8443/a'],
    [
      'postgres://rampsmith:s3cret@db.internal:5432/app?sslmode=require',
      'postgres://db.internal:5432/app',
    ],
    ['/app?id_token=y&shop=s.myshopify.com', '/app'],
    ['/app#access_token=abc', '/app'],
    ['?id_token=y', ''],
    ['not a url?hmac=x', 'not a url'],
    ['https://shop.example', 'https://shop.example/'],
    ['', ''],
  ])('%j becomes %j', (value, expected) => {
    expect(redactUrl(value)).toBe(expected);
  });
});

describe('redactText', () => {
  it('reduces every URL in a message to origin and path and keeps the rest', () => {
    expect(
      redactText(
        'fetch failed: https://api.internal:3997/v1/session?token=abc, then http://x.example/?k=v. Done',
      ),
    ).toBe('fetch failed: https://api.internal:3997/v1/session, then http://x.example/. Done');
    expect(redactText('GET (https://shop.example/p?id_token=y)')).toBe(
      'GET (https://shop.example/p)',
    );
  });

  it('keeps Shopify shop names out of telemetry', () => {
    expect(redactText('install for demo-store.myshopify.com failed')).toBe(
      'install for [shop].myshopify.com failed',
    );
    expect(redactText('DEMO-STORE.MYSHOPIFY.COM')).toBe('[shop].myshopify.com');
  });

  it('leaves ordinary text, numbers and identifiers alone', () => {
    for (const text of ['scan.page failed after 3 attempts', 'job 0197-abc', '', 'a://']) {
      expect(redactText(text)).toBe(text);
    }
  });

  it('does not backtrack on hostile input', () => {
    const started = performance.now();
    redactText('http://'.repeat(50_000));
    redactText(`${'a'.repeat(200_000)}://`);
    redactText('x.myshopify.com'.repeat(20_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('UrlRedactingSpanProcessor', () => {
  function pipeline() {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new UrlRedactingSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    return { exporter, tracer: provider.getTracer('test'), provider };
  }

  it('rewrites the URL attributes SvelteKit and OpenTelemetry instrumentations set', async () => {
    const { exporter, tracer, provider } = pipeline();
    tracer
      .startSpan('sveltekit.handle.root', {
        attributes: {
          'http.route': '/app',
          'http.method': 'GET',
          'http.url': LAUNCH_URL,
          'sveltekit.is_data_request': false,
        },
      })
      .end();
    await provider.forceFlush();
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).toEqual({
      'http.route': '/app',
      'http.method': 'GET',
      'http.url': 'http://localhost:3000/app',
      'sveltekit.is_data_request': false,
    });
  });

  it('rewrites attributes set after the span started, and every URL-shaped key', () => {
    const { exporter, tracer } = pipeline();
    const span = tracer.startSpan('request');
    span.setAttribute('url.full', LAUNCH_URL);
    span.setAttribute('url.original', '/app?id_token=y');
    span.setAttribute('http.target', '/app?id_token=y&hmac=x');
    span.setAttribute('url.query', 'embedded=1&hmac=x&id_token=y&session=z&shop=s.myshopify.com');
    span.setAttribute('url.fragment', 'id_token=y');
    span.setAttribute('http.request.header.referer', 'https://admin.shopify.com/store/s?hmac=x');
    span.setAttribute('http.response.header.location', '/app?session=z');
    span.setAttribute('rampsmith.note', `redirecting to ${LAUNCH_URL} now`);
    span.setAttribute('rampsmith.urls', [LAUNCH_URL, 'https://ok.example/x']);
    span.setAttribute('rampsmith.count', 3);
    span.end();
    const [done] = exporter.getFinishedSpans();
    expectClean(done?.attributes);
    expect(done?.attributes).toMatchObject({
      'url.full': 'http://localhost:3000/app',
      'url.original': '/app',
      'http.target': '/app',
      'http.request.header.referer': 'https://admin.shopify.com/store/s',
      'http.response.header.location': '/app',
      'rampsmith.note': 'redirecting to http://localhost:3000/app now',
      'rampsmith.urls': ['http://localhost:3000/app', 'https://ok.example/x'],
      'rampsmith.count': 3,
    });
  });

  it('drops the value of query, fragment, cookie and authorization attributes', () => {
    const { exporter, tracer } = pipeline();
    const span = tracer.startSpan('request');
    span.setAttributes({
      'url.query': 'a=1',
      'http.request.header.cookie': '__Host-rs_session=abc',
      'http.request.header.authorization': 'Bearer eyJ',
      'http.response.header.set-cookie': ['__Host-rs_session=abc; Secure'],
      'http.request.header.x-shopify-hmac-sha256': 'abc',
      'http.request.header.accept': 'text/html',
    });
    span.end();
    const [done] = exporter.getFinishedSpans();
    expect(done?.attributes).toEqual({
      'url.query': '[redacted]',
      'http.request.header.cookie': '[redacted]',
      'http.request.header.authorization': '[redacted]',
      'http.response.header.set-cookie': '[redacted]',
      'http.request.header.x-shopify-hmac-sha256': '[redacted]',
      'http.request.header.accept': 'text/html',
    });
  });

  it('rewrites events (exceptions) and links', () => {
    const { exporter, tracer } = pipeline();
    const linked = tracer.startSpan('other');
    const span = tracer.startSpan('request', {
      links: [{ context: linked.spanContext(), attributes: { 'http.url': LAUNCH_URL } }],
    });
    span.recordException(new Error(`fetch failed: ${LAUNCH_URL}`));
    span.addEvent('redirect', { 'http.url': LAUNCH_URL });
    span.end();
    linked.end();
    const done = exporter.getFinishedSpans().find((s) => s.name === 'request');
    expectClean(done?.events);
    expectClean(done?.links);
    expect(done?.events[0]?.attributes?.['exception.message']).toBe(
      'fetch failed: http://localhost:3000/app',
    );
  });

  it('is applied by startTelemetry, which the engine and the web server both call', async () => {
    let running: Telemetry | undefined;
    try {
      const exporter = new InMemorySpanExporter();
      running = startTelemetry({
        serviceName: 'web',
        serviceVersion: '0.0.0',
        env: {},
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      trace.getTracer('sveltekit').startActiveSpan('sveltekit.handle.root', (span) => {
        span.setAttributes({ 'http.url': LAUNCH_URL, 'http.route': '/app' });
        span.end();
      });
      const [span] = exporter.getFinishedSpans();
      expect(span?.attributes['http.url']).toBe('http://localhost:3000/app');
      expectClean(span?.attributes);
    } finally {
      await running?.shutdown();
      trace.disable();
    }
  });

  it('survives values it does not understand', () => {
    const { exporter, tracer } = pipeline();
    const attributes: Attributes = {
      'a.number': 1,
      'a.bool': true,
      'a.empty': '',
      'a.mixed': ['x', 'y'],
      'a.numbers': [1, 2],
    };
    tracer.startSpan('odd', { attributes }).end();
    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual(attributes);
    expect(context.active()).toBeDefined();
  });
});

describe('the exporting pipeline', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    trace.disable();
  });

  it('sends OTLP bodies with no token, query string or shop name in them', async () => {
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
    const { port } = collector.address() as AddressInfo;
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${port.toString()}`);
    vi.stubEnv('OTEL_METRICS_EXPORTER', 'none');
    try {
      const running = startTelemetry({
        serviceName: 'web',
        serviceVersion: '0.0.0',
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'set' },
      });
      expect(running.exporting).toBe(true);
      trace.getTracer('sveltekit').startActiveSpan('sveltekit.handle.root', (span) => {
        span.setAttributes({ 'http.url': LAUNCH_URL, 'http.route': '/app' });
        span.end();
      });
      await running.shutdown();
    } finally {
      await new Promise<void>((resolve) => {
        collector.close(() => {
          resolve();
        });
      });
    }
    const wire = Buffer.concat(bodies).toString('latin1');
    // The span did leave the process, with its (redacted) URL...
    expect(wire).toContain('http://localhost:3000/app');
    expect(wire).toContain('sveltekit.handle.root');
    // ...and nothing of the launch parameters did.
    for (const word of FORBIDDEN) expect(wire, word).not.toContain(word);
  });
});
