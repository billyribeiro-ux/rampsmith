/**
 * Startup check on the engine's database login (audit M4, ADR-052).
 *
 * Row-level security separates tenants only for a role that is not a superuser, does not have
 * BYPASSRLS and does not own the tables (PostgreSQL does not apply policies to a table's owner
 * unless the table is forced, and the migrations enable but do not force them). Every query the
 * engine runs sets `app.tenant_id` and relies on that. If DATABASE_URL names the migration
 * owner by mistake, nothing else would notice: every query would still work, across tenants.
 * So the engine refuses to run unless its login is a plain member of `rampsmith_worker`.
 * There is no setting that turns the check off.
 */
import type postgres from 'postgres';

/** The group role the engine's login must be a member of. */
const WORKER_ROLE = 'rampsmith_worker';

interface RoleFacts {
  readonly effective: string;
  readonly login: string;
  readonly effective_super: boolean | null;
  readonly effective_bypass: boolean | null;
  readonly login_super: boolean | null;
  readonly login_bypass: boolean | null;
  readonly member: boolean;
  readonly can_redact: boolean;
  readonly owned: readonly string[];
}

/** How many owned relation names an error message lists. */
const LISTED = 5;

/**
 * What is wrong with the connected role, one sentence each; empty when the role is fit.
 *
 * Both the effective role (`current_user`, which row-level security looks at) and the login
 * role (`session_user`) are checked: a superuser session that switched to a worker role with
 * `SET ROLE` is subject to policies only until it switches back.
 */
export async function checkWorkerRole(
  sql: postgres.Sql,
  workerRole: string = WORKER_ROLE,
): Promise<string[]> {
  const [facts] = await sql<RoleFacts[]>`
    select current_user::text as effective,
           session_user::text as login,
           (select rolsuper from pg_roles where rolname = current_user) as effective_super,
           (select rolbypassrls from pg_roles where rolname = current_user) as effective_bypass,
           (select rolsuper from pg_roles where rolname = session_user) as login_super,
           (select rolbypassrls from pg_roles where rolname = session_user) as login_bypass,
           coalesce(
             (select pg_has_role(current_user, r.oid, 'usage')
                from pg_roles r where r.rolname = ${workerRole}),
             false) as member,
           coalesce(
             has_function_privilege(
               current_user, to_regprocedure('public.redact_ai_calls()'), 'execute'),
             false) as can_redact,
           coalesce(
             (select array_agg(c.relname::text order by c.relname)
                from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public'
                 and c.relowner = (select oid from pg_roles where rolname = current_user)),
             '{}') as owned`;
  if (facts === undefined) return ['the role could not be read from pg_roles'];

  const reasons: string[] = [];
  const names =
    facts.effective === facts.login ? facts.effective : `${facts.login}/${facts.effective}`;
  if (facts.effective_super !== false || facts.login_super !== false) {
    reasons.push(`it is a superuser (${names})`);
  }
  if (facts.effective_bypass !== false || facts.login_bypass !== false) {
    reasons.push(`it has BYPASSRLS (${names})`);
  }
  if (facts.owned.length > 0) {
    const shown = facts.owned.slice(0, LISTED).join(', ');
    const more = facts.owned.length > LISTED ? ', …' : '';
    reasons.push(
      `it owns ${facts.owned.length.toString()} relation(s) in schema public (${shown}${more})`,
    );
  }
  if (!facts.member) {
    reasons.push(`it is not a member of ${workerRole}, or does not inherit its privileges`);
  }
  // Only ctl deletes a redacted shop's AI call records (through redact_ai_calls()). The engine
  // handles merchant-controlled pages, so it must not be able to delete the cost record
  // (ADR-037, ADR-089).
  if (facts.can_redact) {
    reasons.push(
      "it may execute redact_ai_calls(), which only ctl's login may (it is a member of " +
        'rampsmith_redactor)',
    );
  }
  return reasons;
}

/** Throws unless the connected role may run the engine; the message names every reason. */
export async function assertWorkerRole(sql: postgres.Sql): Promise<void> {
  const reasons = await checkWorkerRole(sql);
  if (reasons.length === 0) return;
  const [role] = await sql<{ name: string }[]>`select current_user::text as name`;
  throw new Error(
    `database role "${role?.name ?? 'unknown'}" cannot run the engine, because ` +
      `${reasons.join('; ')}. Connect as a LOGIN role that is a member of ${WORKER_ROLE}, ` +
      'is not a superuser, has no BYPASSRLS and owns nothing in schema public (ADR-052).',
  );
}
