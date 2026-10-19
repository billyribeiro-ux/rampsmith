/**
 * A fresh, migrated database per test file, created from the superuser in DATABASE_URL
 * (ADR-015), with one verified site and a scan ready for pages.
 *
 * The code under test connects as a throw-away LOGIN role that is a member of an application
 * role, as the deployed engine does (audit M4, ADR-052): never as the superuser, and never by
 * switching role inside a superuser session.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import { uuidv7 } from '@rampsmith/queue';
import postgres from 'postgres';

const MIGRATIONS = new URL('../../../crates/db/migrations/', import.meta.url);

export interface TestRole {
  readonly name: string;
  readonly password: string;
}

export interface TestDatabase {
  readonly name: string;
  /** The migration owner (a superuser): bypasses row-level security; used to seed and inspect. */
  readonly owner: postgres.Sql;
  /** A pool logged in as a throw-away LOGIN member of one of the application roles. */
  as(role: 'rampsmith_worker' | 'rampsmith_app'): postgres.Sql;
  /**
   * A throw-away role: LOGIN unless `login` is false (a group). `clauses` are CREATE ROLE
   * options such as `in role rampsmith_worker`.
   */
  createRole(clauses: string, login?: boolean): Promise<TestRole>;
  /** A pool logged in as `role` (one pool at most is needed per role). */
  connect(role: TestRole, options?: { readonly max?: number }): postgres.Sql;
  drop(): Promise<void>;
}

function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') throw new Error('DATABASE_URL must be set for the tests');
  return url;
}

export async function freshDatabase(): Promise<TestDatabase> {
  const url = databaseUrl();
  const quiet = { onnotice: () => undefined, max: 1 };
  const admin = postgres(url, quiet);
  const name = `rs_engine_${randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`create database ${name}`);
  const owner = postgres(url, { ...quiet, database: name, max: 4 });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await owner.unsafe(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  await owner`select ensure_finding_occurrence_partitions(3)`;

  const pools: postgres.Sql[] = [owner];
  const roles: string[] = [];
  const logins = new Map<string, TestRole>();
  const database: TestDatabase = {
    name,
    owner,
    async createRole(clauses, login = true) {
      const role = { name: `rs_t_${randomBytes(8).toString('hex')}`, password: randomUUID() };
      await admin.unsafe(
        `create role ${role.name} ${login ? 'login' : 'nologin'} password '${role.password}' ${clauses}`,
      );
      roles.push(role.name);
      return role;
    },
    connect(role, options = {}) {
      const pool = postgres(url, {
        ...quiet,
        database: name,
        user: role.name,
        pass: role.password,
        max: options.max ?? 10,
      });
      pools.push(pool);
      return pool;
    },
    as(role) {
      const login = logins.get(role);
      if (login === undefined) throw new Error(`no login for ${role}`);
      return database.connect(login);
    },
    async drop() {
      await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
      await admin.unsafe(`drop database ${name} with (force)`);
      for (const role of roles) await admin.unsafe(`drop role if exists ${role}`);
      await admin.end({ timeout: 1 });
    },
  };

  logins.set('rampsmith_worker', await database.createRole('in role rampsmith_worker'));
  logins.set('rampsmith_app', await database.createRole('in role rampsmith_app'));
  return database;
}

export interface Fixture {
  readonly tenantId: string;
  readonly siteId: string;
  readonly scanId: string;
}

/** A tenant with a site at `baseUrl` (verified unless told otherwise) and a scan of `pages`. */
export async function seed(
  owner: postgres.Sql,
  baseUrl: string,
  { pages = 2, verified = true }: { pages?: number; verified?: boolean } = {},
): Promise<Fixture> {
  const tenantId = uuidv7();
  const siteId = uuidv7();
  const scanId = uuidv7();
  await owner`insert into tenants (id, kind) values (${tenantId}, 'shopify_store')`;
  await owner`
    insert into sites (id, tenant_id, platform, base_url, verified_at, verification_method)
    values (${siteId}, ${tenantId}, 'shopify', ${baseUrl},
            ${verified ? new Date() : null}, ${verified ? 'shopify_install' : null})`;
  await owner`
    insert into scans (id, tenant_id, site_id, trigger, status, ruleset_version, pages_planned)
    values (${scanId}, ${tenantId}, ${siteId}, 'manual', 'queued', 'axe-4.14.0', ${pages})`;
  return { tenantId, siteId, scanId };
}
