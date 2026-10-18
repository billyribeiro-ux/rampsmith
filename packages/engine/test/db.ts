/**
 * A fresh, migrated database per test file, created from the superuser in DATABASE_URL
 * (ADR-015), with one verified site and a scan ready for pages.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import { uuidv7 } from '@rampsmith/queue';
import postgres from 'postgres';

const MIGRATIONS = new URL('../../../crates/db/migrations/', import.meta.url);

export interface TestDatabase {
  readonly owner: postgres.Sql;
  as(role: 'rampsmith_worker' | 'rampsmith_app'): postgres.Sql;
  drop(): Promise<void>;
}

export async function freshDatabase(): Promise<TestDatabase> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') throw new Error('DATABASE_URL must be set for the tests');
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
  return {
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
