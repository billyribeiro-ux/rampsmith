/**
 * Audit M4: row-level security isolates tenants only while the engine's login is not a
 * superuser, not BYPASSRLS and not the owner of the tables. The engine checks that at startup
 * (ADR-052). These tests run the check against the real PostgreSQL, with throw-away roles.
 */
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { assertWorkerRole, checkWorkerRole } from '../src/role-guard.ts';
import { freshDatabase, type TestDatabase } from './db.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await freshDatabase();
});
afterAll(async () => {
  await db.drop();
});

async function login(clauses: string): Promise<postgres.Sql> {
  return db.connect(await db.createRole(clauses), { max: 1 });
}

describe('the engine database role guard', () => {
  it('accepts a plain LOGIN member of rampsmith_worker', async () => {
    const sql = await login('in role rampsmith_worker');
    await expect(assertWorkerRole(sql)).resolves.toBeUndefined();
    await expect(checkWorkerRole(sql)).resolves.toEqual([]);
  });

  it('accepts a role that is a member through another role', async () => {
    const group = await db.createRole('in role rampsmith_worker', false);
    const sql = await login(`in role ${group.name}`);
    await expect(assertWorkerRole(sql)).resolves.toBeUndefined();
  });

  it('refuses a superuser, such as the migration owner', async () => {
    await expect(assertWorkerRole(db.owner)).rejects.toThrow(/superuser/);
    const sql = await login('superuser in role rampsmith_worker');
    await expect(assertWorkerRole(sql)).rejects.toThrow(/superuser/);
  });

  it('refuses a role with BYPASSRLS', async () => {
    const sql = await login('bypassrls in role rampsmith_worker');
    await expect(assertWorkerRole(sql)).rejects.toThrow(/BYPASSRLS/);
  });

  it('refuses a role that owns a relation in the public schema', async () => {
    const role = await db.createRole('in role rampsmith_worker');
    await db.owner.unsafe(`create table public.guard_probe (id int)`);
    await db.owner.unsafe(`alter table public.guard_probe owner to ${role.name}`);
    try {
      const sql = db.connect(role, { max: 1 });
      await expect(assertWorkerRole(sql)).rejects.toThrow(/owns .*guard_probe/);
    } finally {
      await db.owner.unsafe(`drop table public.guard_probe`);
    }
  });

  it('refuses a role that owns a sequence or a view, not only tables', async () => {
    for (const [create, name] of [
      ['create sequence public.guard_seq', 'guard_seq'],
      ['create view public.guard_view as select 1 as one', 'guard_view'],
    ] as const) {
      const role = await db.createRole('in role rampsmith_worker');
      await db.owner.unsafe(create);
      await db.owner.unsafe(
        `alter ${name.endsWith('seq') ? 'sequence' : 'view'} public.${name} owner to ${role.name}`,
      );
      try {
        await expect(assertWorkerRole(db.connect(role, { max: 1 }))).rejects.toThrow(
          new RegExp(`owns .*${name}`),
        );
      } finally {
        await db.owner.unsafe(`drop ${name.endsWith('seq') ? 'sequence' : 'view'} public.${name}`);
      }
    }
  });

  it('refuses a role that is not a member of rampsmith_worker', async () => {
    const sql = await login('');
    await expect(assertWorkerRole(sql)).rejects.toThrow(/rampsmith_worker/);
    const app = await login('in role rampsmith_app');
    await expect(assertWorkerRole(app)).rejects.toThrow(/rampsmith_worker/);
  });

  it('refuses a worker that may delete AI call records (ctl is the only one, ADR-089)', async () => {
    const sql = await login('in role rampsmith_worker, rampsmith_redactor');
    const reasons = await checkWorkerRole(sql);
    expect(reasons.join('; ')).toMatch(/redact_ai_calls\(\)/);
    await expect(assertWorkerRole(sql)).rejects.toThrow(/rampsmith_redactor/);
    // The same group through another role does not get around the check.
    const group = await db.createRole('in role rampsmith_redactor', false);
    const indirect = await login(`in role rampsmith_worker, ${group.name}`);
    await expect(assertWorkerRole(indirect)).rejects.toThrow(/redact_ai_calls/);
  });

  it('refuses a member that does not inherit the role privileges', async () => {
    const sql = await login('noinherit in role rampsmith_worker');
    await expect(assertWorkerRole(sql)).rejects.toThrow(/rampsmith_worker/);
  });

  it('refuses a superuser session that only switched to a worker role', async () => {
    // What `postgres://superuser@…?options=-c role=rampsmith_worker` would give: row-level
    // security applies to current_user, but the session can switch back at any time.
    const url = new URL(process.env['DATABASE_URL'] ?? '');
    const sql = db.connect(
      { name: decodeURIComponent(url.username), password: decodeURIComponent(url.password) },
      { max: 1 },
    );
    await sql`set role rampsmith_worker`;
    await expect(assertWorkerRole(sql)).rejects.toThrow(/superuser/);
  });

  it('names every reason at once and never prints a password', async () => {
    const role = await db.createRole('bypassrls');
    await db.owner.unsafe(`create table public.guard_reasons (id int)`);
    await db.owner.unsafe(`alter table public.guard_reasons owner to ${role.name}`);
    try {
      const error: unknown = await assertWorkerRole(db.connect(role, { max: 1 })).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(role.name);
      expect(message).toMatch(/BYPASSRLS/);
      expect(message).toMatch(/owns 1 relation\(s\) in schema public \(guard_reasons\)/);
      expect(message).toMatch(/not a member of rampsmith_worker/);
      expect(message).not.toContain(role.password);
    } finally {
      await db.owner.unsafe(`drop table public.guard_reasons`);
    }
  });

  it('reports a missing rampsmith_worker role as a reason, not a crash', async () => {
    const reasons = await checkWorkerRole(db.owner, 'rampsmith_no_such_role');
    expect(reasons.join('; ')).toMatch(/not a member of rampsmith_no_such_role/);
  });
});
