//! The append-only audit log: who did what to which subject, and when.

use domain::ActorKind;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::parse;
use crate::{DbError, TenantTx};

/// Input for [`append`].
#[derive(Debug, Clone)]
pub struct NewEntry {
    /// Who acted.
    pub actor_kind: ActorKind,
    /// Their id within that kind, if any.
    pub actor_id: Option<String>,
    /// Dotted lowercase action, such as `fix.approved`.
    pub action: String,
    /// The kind of subject, such as `fix`.
    pub subject_type: String,
    /// The subject's id.
    pub subject_id: Uuid,
    /// Structured detail. Never tokens or personal data.
    pub data: Value,
}

/// A stored audit entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// The entry's id.
    pub id: Uuid,
    /// Who acted.
    pub actor_kind: ActorKind,
    /// Their id.
    pub actor_id: Option<String>,
    /// What they did.
    pub action: String,
    /// The kind of subject.
    pub subject_type: String,
    /// The subject's id.
    pub subject_id: Uuid,
    /// Structured detail.
    pub data: Value,
    /// When it happened.
    pub at: OffsetDateTime,
}

struct Row {
    id: Uuid,
    actor_kind: String,
    actor_id: Option<String>,
    action: String,
    subject_type: String,
    subject_id: Uuid,
    data: Value,
    at: OffsetDateTime,
}

impl TryFrom<Row> for Entry {
    type Error = DbError;

    fn try_from(r: Row) -> Result<Self, DbError> {
        Ok(Self {
            id: r.id,
            actor_kind: parse(&r.actor_kind, "audit_log.actor_kind")?,
            actor_id: r.actor_id,
            action: r.action,
            subject_type: r.subject_type,
            subject_id: r.subject_id,
            data: r.data,
            at: r.at,
        })
    }
}

/// Appends an entry. Entries can never be changed or removed.
pub async fn append(tx: &mut TenantTx, new: &NewEntry) -> Result<Entry, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query_as!(
        Row,
        r#"insert into audit_log (id, tenant_id, actor_kind, actor_id, action, subject_type, subject_id, data)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id, actor_kind, actor_id, action, subject_type, subject_id, data, at"#,
        Uuid::now_v7(),
        tenant,
        new.actor_kind.as_str(),
        new.actor_id,
        new.action,
        new.subject_type,
        new.subject_id,
        new.data,
    )
    .fetch_one(tx.conn())
    .await?;
    row.try_into()
}

/// The tenant's latest entries, newest first.
pub async fn list(tx: &mut TenantTx, limit: i64) -> Result<Vec<Entry>, DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query_as!(
        Row,
        r#"select id, actor_kind, actor_id, action, subject_type, subject_id, data, at
             from audit_log where tenant_id = $1 order by at desc, id desc limit $2"#,
        tenant,
        limit,
    )
    .fetch_all(tx.conn())
    .await?;
    rows.into_iter().map(Entry::try_from).collect()
}
