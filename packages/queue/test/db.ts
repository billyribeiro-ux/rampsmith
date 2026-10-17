/**
 * A fresh, migrated database per test file, created from the superuser in DATABASE_URL
 * (ADR-015). Migrations are the same SQL files `sqlx migrate` applies in production.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import postgres from 'postgres';

const MIGRATIONS = new URL('../../../crates/db/migrations/', import.meta.url);

export interface TestDatabase {
  readonly url: string;
  readonly name: string;
  /** The migration owner: bypasses row-level security; used to move time and inspect. */
  readonly owner: postgres.Sql;
  /** A pool connected as one of the application roles. */
  as(role: 'rampsmith_worker' | 'rampsmith_app'): postgres.Sql;
  drop(): Promise<void>;
}

function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL must name a PostgreSQL 18 superuser connection for the tests');
  }
  return url;
}

export async function freshDatabase(): Promise<TestDatabase> {
  const url = databaseUrl();
  const quiet = { onnotice: () => undefined, max: 1 };
  const admin = postgres(url, quiet);
  const name = `rs_queue_${randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`create database ${name}`);
  const owner = postgres(url, { ...quiet, database: name, max: 4 });
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await owner.unsafe(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  const pools: postgres.Sql[] = [owner];
  return {
    url,
    name,
    owner,
    as(role) {
      const pool = postgres(url, { ...quiet, database: name, max: 10, connection: { role } });
      pools.push(pool);
      return pool;
    },
    async drop() {
      await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end({ timeout: 1 });
    },
  };
}
