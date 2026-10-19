/** Audit M4: the engine process itself refuses an unsafe database login (ADR-052). */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase, type TestDatabase, type TestRole } from './db.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});
afterAll(async () => {
  await db.drop();
});

/** DATABASE_URL for the test database, as `role` (or as DATABASE_URL's own user). */
function databaseUrl(role?: TestRole): string {
  const url = new URL(process.env['DATABASE_URL'] ?? '');
  url.pathname = `/${db.name}`;
  if (role !== undefined) {
    url.username = role.name;
    url.password = role.password;
  }
  return url.href;
}

/** Runs `src/main.ts` against `url` and returns how it ended. */
function runEngine(url: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname], {
      env: {
        PATH: process.env['PATH'],
        DATABASE_URL: url,
        EGRESS_PROXY_URL: 'http://127.0.0.1:9',
        EGRESS_TOKEN_SECRET: 'engine-main-test-secret-0123456789abcdef',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`engine did not exit; stderr so far: ${stderr}`));
    }, 30_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

describe('the engine process', () => {
  it('refuses to start when DATABASE_URL names a superuser', async () => {
    const { code, stderr } = await runEngine(databaseUrl());
    expect(code).toBe(1);
    expect(stderr).toMatch(/superuser/);
    expect(stderr).toMatch(/rampsmith_worker/);
    expect(stderr).not.toContain('postgres://');
  });

  it('refuses to start when the login is not a member of rampsmith_worker', async () => {
    const role = await db.createRole('');
    const { code, stderr } = await runEngine(databaseUrl(role));
    expect(code).toBe(1);
    expect(stderr).toMatch(/not a member of rampsmith_worker/);
    expect(stderr).not.toContain(role.password);
  });

  it('refuses to start when the login owns tables', async () => {
    const role = await db.createRole('in role rampsmith_worker');
    await db.owner.unsafe(`create table public.main_probe (id int)`);
    await db.owner.unsafe(`alter table public.main_probe owner to ${role.name}`);
    const { code, stderr } = await runEngine(databaseUrl(role));
    expect(code).toBe(1);
    expect(stderr).toMatch(/owns 1 relation\(s\) in schema public \(main_probe\)/);
  });
});
