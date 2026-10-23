//! The runtime role guard (audit M4, ADR-040).
//!
//! Row-level security isolates tenants only for a role that cannot bypass it. A superuser, a
//! role with `BYPASSRLS` and the owner of a table (row-level security is not forced on the
//! tables, ADR-006) all read every tenant, and nothing in a connection string tells them
//! apart from the application's own login. [`Db::verify_runtime_role`] asks the database who
//! it is actually connected as and refuses anything but a plain `LOGIN` member of the group
//! role the service is meant to run as. `api` calls it at startup and in `/readyz`; `ctl`
//! calls it at startup. There is deliberately no switch to turn it off.

use std::fmt;

use crate::{Db, DbError};

/// The application role a service must run as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeRole {
    /// The `api` service: acts for one tenant per transaction (`rampsmith_app`).
    App,
    /// A service that claims jobs across tenants (`rampsmith_worker`) and may not delete the AI
    /// call record: the engine's profile.
    Worker,
    /// `ctl`: a worker that also deletes a redacted shop's AI call records, through
    /// `redact_ai_calls()`, by membership of `rampsmith_redactor` (ADR-089).
    Ctl,
}

impl RuntimeRole {
    /// The `NOLOGIN` group role the service's `LOGIN` role must be a member of.
    #[must_use]
    pub const fn group(self) -> &'static str {
        match self {
            Self::App => "rampsmith_app",
            Self::Worker | Self::Ctl => "rampsmith_worker",
        }
    }

    /// Whether the role must be able to execute `redact_ai_calls()`: `Some(true)` it must,
    /// `Some(false)` it must not. Only `ctl` redacts; the api and the engine run next to
    /// merchant-controlled input and may not delete the cost record (ADR-037, ADR-089).
    const fn redacts(self) -> bool {
        matches!(self, Self::Ctl)
    }

    /// The group role the service must not also belong to. The `jobs` policies are per role
    /// and permissive policies combine with OR, so an `api` login that is also a worker would
    /// read every tenant's jobs.
    const fn forbidden(self) -> Option<&'static str> {
        match self {
            Self::App => Some("rampsmith_worker"),
            Self::Worker | Self::Ctl => None,
        }
    }
}

/// One way the connected role is unfit to run a service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoleViolation {
    /// The connected role is a superuser.
    Superuser,
    /// The connected role has `BYPASSRLS`.
    BypassRls,
    /// The login the session started as is a superuser, so `SET ROLE` can be undone with
    /// `RESET ROLE`.
    SessionSuperuser,
    /// The login the session started as has `BYPASSRLS`.
    SessionBypassRls,
    /// The role owns this many relations: owners are not bound by row-level security.
    OwnsRelations(i64),
    /// The role owns the database, and with it the `public` schema and every table in it.
    OwnsDatabase,
    /// The role may create objects in the `public` schema.
    CanCreateInPublic,
    /// The role is not a member of the group role, or does not inherit its privileges.
    NotMember(&'static str),
    /// The role belongs to a group role this service must not use.
    AlsoMember(&'static str),
    /// The role may execute `redact_ai_calls()`, which only `ctl` may.
    CanRedact,
    /// The role may not execute `redact_ai_calls()`, so `shop/redact` would fail for ever.
    CannotRedact,
}

impl fmt::Display for RoleViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Superuser => f.write_str("the role is a superuser"),
            Self::BypassRls => f.write_str("the role has BYPASSRLS"),
            Self::SessionSuperuser => {
                f.write_str("the session's login role is a superuser (SET ROLE can be undone)")
            }
            Self::SessionBypassRls => f.write_str("the session's login role has BYPASSRLS"),
            Self::OwnsRelations(n) => write!(f, "the role owns {n} relation(s)"),
            Self::OwnsDatabase => f.write_str("the role owns the database"),
            Self::CanCreateInPublic => {
                f.write_str("the role may create objects in the public schema")
            }
            Self::NotMember(group) => {
                write!(
                    f,
                    "the role is not a member of {group} (or does not inherit it)"
                )
            }
            Self::AlsoMember(group) => write!(f, "the role must not be a member of {group}"),
            Self::CanRedact => f.write_str(
                "the role may execute redact_ai_calls(), which only ctl's login may \
                 (it must not be a member of rampsmith_redactor)",
            ),
            Self::CannotRedact => f.write_str(
                "the role may not execute redact_ai_calls(), so a shop could never be redacted \
                 (ctl's login must be a member of rampsmith_redactor)",
            ),
        }
    }
}

/// Why the runtime role could not be confirmed.
#[derive(Debug, thiserror::Error)]
pub enum RoleError {
    /// The database answered, and the connected role is not fit to serve. Never retry.
    #[error("refusing to run as database role `{role}`: {}", list(.violations))]
    Refused {
        /// `current_user`, for the operator. A role name is not a secret.
        role: String,
        /// Everything that is wrong, not only the first problem.
        violations: Vec<RoleViolation>,
    },
    /// The database could not be asked. Retrying may help.
    #[error("could not check the database role: {0}")]
    Unreachable(#[from] DbError),
}

fn list(violations: &[RoleViolation]) -> String {
    violations
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

impl Db {
    /// Confirms the pool is connected as a plain `LOGIN` member of `role`'s group role: not a
    /// superuser, without `BYPASSRLS`, owning no relation and not the database, unable to
    /// create objects in `public`, inheriting the group's privileges, and (for the api) not
    /// also a worker. Only `ctl` may execute `redact_ai_calls()`, and it must. The session's own login must be as unprivileged as `current_user`.
    pub async fn verify_runtime_role(&self, role: RuntimeRole) -> Result<(), RoleError> {
        let row = sqlx::query!(
            r#"select
                 cu.rolname::text as "role!",
                 cu.rolsuper as "is_super!",
                 cu.rolbypassrls as "has_bypass!",
                 su.oid <> cu.oid as "switched!",
                 su.rolsuper as "session_super!",
                 su.rolbypassrls as "session_bypass!",
                 (select count(*) from pg_class c
                    join pg_namespace n on n.oid = c.relnamespace
                   where c.relowner = cu.oid
                     and n.nspname !~ '^pg_' and n.nspname <> 'information_schema') as "owned!",
                 pg_has_role(current_user, 'pg_database_owner', 'member') as "owns_database!",
                 has_schema_privilege(current_user, 'public', 'create') as "can_create!",
                 case when exists (select 1 from pg_roles where rolname = $1::text)
                      then pg_has_role(current_user, $1::text::name, 'usage')
                      else false end as "member!",
                 case when $2::text is not null
                       and exists (select 1 from pg_roles where rolname = $2::text)
                      then pg_has_role(current_user, $2::text::name, 'member')
                      else false end as "forbidden!",
                 coalesce(has_function_privilege(
                            current_user, to_regprocedure('public.redact_ai_calls()'), 'execute'),
                          false) as "can_redact!"
               from pg_roles cu, pg_roles su
              where cu.rolname = current_user and su.rolname = session_user"#,
            role.group(),
            role.forbidden(),
        )
        .fetch_one(self.pool())
        .await
        .map_err(DbError::from)?;

        let mut violations = Vec::new();
        let mut flag = |bad: bool, violation: RoleViolation| {
            if bad {
                violations.push(violation);
            }
        };
        flag(row.is_super, RoleViolation::Superuser);
        flag(row.has_bypass, RoleViolation::BypassRls);
        // Only a session that changed role (SET ROLE) has a different login to check.
        flag(
            row.switched && row.session_super,
            RoleViolation::SessionSuperuser,
        );
        flag(
            row.switched && row.session_bypass,
            RoleViolation::SessionBypassRls,
        );
        flag(row.owned > 0, RoleViolation::OwnsRelations(row.owned));
        flag(row.owns_database, RoleViolation::OwnsDatabase);
        flag(row.can_create, RoleViolation::CanCreateInPublic);
        flag(!row.member, RoleViolation::NotMember(role.group()));
        if let Some(group) = role.forbidden() {
            flag(row.forbidden, RoleViolation::AlsoMember(group));
        }
        if role.redacts() {
            flag(!row.can_redact, RoleViolation::CannotRedact);
        } else {
            flag(row.can_redact, RoleViolation::CanRedact);
        }
        if violations.is_empty() {
            Ok(())
        } else {
            Err(RoleError::Refused {
                role: row.role,
                violations,
            })
        }
    }
}
