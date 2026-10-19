/**
 * Prepares the database the browser tests' real api uses: a fresh `rampsmith_e2e` database
 * with every migration applied, and a LOGIN user that is a member of `rampsmith_app`, exactly
 * like a deployment (ADR-006). Reads the superuser connection from DATABASE_URL.
 */
import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import postgres from 'postgres';

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  throw new Error('DATABASE_URL must name a PostgreSQL superuser connection');
}
const MIGRATIONS = new URL('../../../crates/db/migrations/', import.meta.url);
const quiet = { onnotice: () => undefined, max: 1 };

const admin = postgres(url, quiet);
await admin.unsafe('drop database if exists rampsmith_e2e with (force)');
await admin.unsafe('create database rampsmith_e2e');
await admin.end();

const owner = postgres(url, { ...quiet, database: 'rampsmith_e2e' });
for (const file of readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  await owner.unsafe(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
}
await owner.unsafe(`
  do $$
  begin
    create role rampsmith_e2e_login login password 'e2e' in role rampsmith_app;
  exception
    when duplicate_object then null;
  end
  $$`);
await owner.end();
