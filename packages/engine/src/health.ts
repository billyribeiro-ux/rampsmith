/**
 * The deploy health listener (ADR-264): `GET /healthz` answers 200 while the engine is up.
 *
 * Railway's deploy-time health check needs an HTTP endpoint on `PORT`. The engine is a worker
 * with no public port, so this is the whole surface: one path, a fixed body, no other route and
 * no data. `main.ts` starts it after the database login and the browser are up.
 */
import { createServer, type Server } from 'node:http';

const DEFAULT_PORT = 8080;

/** `PORT` as a port number; unset means 8080, anything else that is not a port is an error. */
export function healthPort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_PORT;
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT must be a port number');
  }
  return port;
}

export interface HealthServer {
  /** The port it listens on (the real one when started on 0). */
  readonly port: number;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Starts the listener on `[::]` (IPv4 too where the host allows both), else on `0.0.0.0`. */
export async function startHealthServer(portValue: string | undefined): Promise<HealthServer> {
  const port = healthPort(portValue);
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': 2 });
      response.end('ok');
      return;
    }
    response.writeHead(404, { 'content-length': 0 });
    response.end();
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  try {
    await listen(server, port, '::');
  } catch (error) {
    // A host without IPv6 (EAFNOSUPPORT, EADDRNOTAVAIL) still gets the IPv4 wildcard.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EAFNOSUPPORT' && code !== 'EADDRNOTAVAIL') throw error;
    await listen(server, port, '0.0.0.0');
  }
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  return {
    port: bound,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
