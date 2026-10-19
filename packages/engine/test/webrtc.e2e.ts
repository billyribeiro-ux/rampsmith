/**
 * Audit M1: a scanned page must not reach the network over WebRTC. WebRTC sends UDP (STUN,
 * TURN, DTLS) from the browser process itself, so it bypasses the HTTP proxy and with it egress's
 * address policy. The engine launches Chromium with `disable_non_proxied_udp`; these tests run a
 * page that probes a local UDP listener two ways and count what arrives, with and without it.
 */
import { createSocket, type Socket } from 'node:dgram';
import process from 'node:process';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../src/browser.ts';
import { signScanToken } from '../src/egress-token.ts';
import { scanPage } from '../src/scan-page.ts';
import { EGRESS_SECRET, startEgress, type Egress } from './egress.ts';
import { startSite, type Site } from './site.ts';

const UA = 'RampsmithBot/test (accessibility scanner)';
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

interface Listener {
  readonly port: number;
  readonly packets: Buffer[];
  close(): Promise<void>;
}

/** A UDP socket on loopback that records every datagram it receives. */
async function listen(): Promise<Listener> {
  const socket: Socket = createSocket('udp4');
  const packets: Buffer[] = [];
  socket.on('message', (message) => {
    packets.push(message);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    packets,
    close: () =>
      new Promise<void>((resolve) => {
        socket.close(() => {
          resolve();
        });
      }),
  };
}

let site: Site;
let egress: Egress;
let hardened: Browser;
let plain: Browser;

beforeAll(async () => {
  site = await startSite();
  egress = await startEgress(site.port);
  // The engine's own launch settings.
  hardened = await launchBrowser({
    chromiumSandbox: false,
    ...(executablePath === undefined ? {} : { executablePath }),
  });
  // Chromium as it was launched before the fix: no WebRTC policy.
  plain = await chromium.launch({
    proxy: { server: 'per-context' },
    ...(executablePath === undefined ? {} : { executablePath }),
  });
});
afterAll(async () => {
  await hardened.close();
  await plain.close();
  await egress.stop();
  await site.close();
});

function token(): string {
  return signScanToken(EGRESS_SECRET, {
    v: 1,
    scan: 'webrtc-e2e',
    hosts: ['127.0.0.1'],
    budget: 50,
    exp: Math.floor(Date.now() / 1000) + 60,
  });
}

/** Scans the probe page through egress and returns the datagrams each listener received. */
async function probe(browser: Browser): Promise<{ stun: Buffer[]; peer: Buffer[] }> {
  const stun = await listen();
  const peer = await listen();
  try {
    const scan = await scanPage(browser, {
      url: `${site.origin}/webrtc?stun=${stun.port.toString()}&peer=${peer.port.toString()}`,
      userAgent: UA,
      proxy: { server: egress.url, token: token() },
    });
    expect(scan.status).toBe(200);
    // The page keeps the scan open for about three seconds; allow in-flight packets to land.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { stun: [...stun.packets], peer: [...peer.packets] };
  } finally {
    await stun.close();
    await peer.close();
  }
}

describe('WebRTC cannot bypass egress (M1)', () => {
  it('sends no UDP to a stun: server or a remote candidate with the engine launch settings', async () => {
    const received = await probe(hardened);
    expect(received.stun).toHaveLength(0);
    expect(received.peer).toHaveLength(0);
  });

  it('would send UDP without the policy, which proves the probe reaches the network', async () => {
    const received = await probe(plain);
    expect(received.stun.length + received.peer.length).toBeGreaterThan(0);
  });
});
