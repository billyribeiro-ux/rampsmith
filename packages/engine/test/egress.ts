/** Runs the real egress binary (built by `mise run build:egress`) for browser tests. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';
import type { AddressInfo } from 'node:net';

export const EGRESS_SECRET = 'engine-e2e-egress-secret-0123456789abcdef';

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

export interface Egress {
  readonly url: string;
  stop(): Promise<void>;
}

/** egress on a free port, opening loopback and `httpPort` for the local test site only. */
export async function startEgress(httpPort: number): Promise<Egress> {
  const port = await freePort();
  const binary =
    process.env['RAMPSMITH_EGRESS_BIN'] ??
    new URL('../../../target/debug/egress', import.meta.url).pathname;
  const child: ChildProcess = spawn(binary, [], {
    env: {
      ...process.env,
      EGRESS_BIND: `127.0.0.1:${port.toString()}`,
      EGRESS_TOKEN_SECRET: EGRESS_SECRET,
      EGRESS_ALLOWED_CIDRS: '127.0.0.0/8',
      EGRESS_HTTP_PORTS: httpPort.toString(),
      RUST_LOG: 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 100; i += 1) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = createServer().listen(port, '127.0.0.1');
      socket.once('error', () => {
        resolve(true);
      });
      socket.once('listening', () => {
        socket.close();
        resolve(false);
      });
    });
    if (up) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    url: `http://127.0.0.1:${port.toString()}`,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}
