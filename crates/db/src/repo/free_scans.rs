//! The free scanner's anonymous scans (PLAN §16, ADR-267). Not tenant rows: every function
//! takes a [`PublicTx`]. The table is the visitor's quota ledger and the 24-hour result cache;
//! it holds a keyed hash of the visitor's address, never the address.

use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{DbError, PublicTx};

/// A free scan.
#[derive(Debug, Clone, PartialEq)]
pub struct FreeScan {
    /// The scan's id.
    pub id: Uuid,
    /// The scanned domain, without a leading `www.`.
    pub domain: String,
    /// `queued`, `running`, `complete`, `refused` or `failed`.
    pub status: String,
    /// Why a refused scan was refused: `robots`, `bot-challenge` or `unreachable`.
    pub refusal: Option<String>,
    /// The result, once complete.
    pub result: Option<Value>,
    /// When the visitor asked.
    pub created_at: OffsetDateTime,
}

/// How many scans an address or a domain has used in the last 24 hours, and the seconds until
/// the oldest of them leaves the window. Only scans that ran or were refused count; a scan
/// that failed on our side costs the visitor nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Used {
    /// Scans in the window.
    pub count: i64,
    /// Seconds until the oldest of them is 24 hours old; zero when there are none.
    pub frees_in_seconds: i64,
}

/// Serialises requests for one address and one domain until the transaction ends, so two
/// concurrent requests cannot both pass a cap that has one place left. Locks are always taken
/// in this order (address, then domain), so they cannot deadlock.
pub async fn lock(tx: &mut PublicTx, ip_hash: &[u8], domain: &str) -> Result<(), DbError> {
    sqlx::query!(
        "select pg_advisory_xact_lock(hashtextextended('free_scan.ip:' || encode($1::bytea, 'hex'), 0))",
        ip_hash,
    )
    .fetch_one(tx.conn())
    .await?;
    sqlx::query!(
        "select pg_advisory_xact_lock(hashtextextended('free_scan.domain:' || $1, 0))",
        domain,
    )
    .fetch_one(tx.conn())
    .await?;
    Ok(())
}

/// The newest complete result for `domain` that has not expired: the 24-hour cache.
pub async fn cached(tx: &mut PublicTx, domain: &str) -> Result<Option<FreeScan>, DbError> {
    let row = sqlx::query!(
        r#"select id, domain, status, refusal, result, created_at from free_scans
            where domain = $1 and status = 'complete' and expires_at > now()
            order by created_at desc limit 1"#,
        domain,
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(|r| FreeScan {
        id: r.id,
        domain: r.domain,
        status: r.status,
        refusal: r.refusal,
        result: r.result,
        created_at: r.created_at,
    }))
}

/// What the address behind `ip_hash` has used today.
pub async fn used_by_ip(tx: &mut PublicTx, ip_hash: &[u8]) -> Result<Used, DbError> {
    let row = sqlx::query!(
        r#"select count(*) as "count!",
                  coalesce(ceil(extract(epoch from (min(created_at) + interval '24 hours' - now()))), 0)::bigint
                    as "frees_in!"
             from free_scans
            where ip_hash = $1 and status <> 'failed' and created_at > now() - interval '24 hours'"#,
        ip_hash,
    )
    .fetch_one(tx.conn())
    .await?;
    Ok(Used {
        count: row.count,
        frees_in_seconds: row.frees_in.max(0),
    })
}

/// What `domain` has used today.
pub async fn used_by_domain(tx: &mut PublicTx, domain: &str) -> Result<Used, DbError> {
    let row = sqlx::query!(
        r#"select count(*) as "count!",
                  coalesce(ceil(extract(epoch from (min(created_at) + interval '24 hours' - now()))), 0)::bigint
                    as "frees_in!"
             from free_scans
            where domain = $1 and status <> 'failed' and created_at > now() - interval '24 hours'"#,
        domain,
    )
    .fetch_one(tx.conn())
    .await?;
    Ok(Used {
        count: row.count,
        frees_in_seconds: row.frees_in.max(0),
    })
}

/// A scan of `domain` that is queued or running: a second request for the same domain joins
/// it instead of starting another.
pub async fn in_flight_for(tx: &mut PublicTx, domain: &str) -> Result<Option<FreeScan>, DbError> {
    let row = sqlx::query!(
        r#"select id, domain, status, refusal, result, created_at from free_scans
            where domain = $1 and status in ('queued', 'running') and expires_at > now()
            order by created_at desc limit 1"#,
        domain,
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(|r| FreeScan {
        id: r.id,
        domain: r.domain,
        status: r.status,
        refusal: r.refusal,
        result: r.result,
        created_at: r.created_at,
    }))
}

/// How many scans are queued or running, across all visitors: the ceiling that keeps a flood
/// of distinct addresses and domains from filling the engine's queue.
pub async fn in_flight_count(tx: &mut PublicTx) -> Result<i64, DbError> {
    Ok(sqlx::query_scalar!(
        r#"select count(*) as "count!" from free_scans where status in ('queued', 'running')"#
    )
    .fetch_one(tx.conn())
    .await?)
}

/// Records a queued scan.
pub async fn create(
    tx: &mut PublicTx,
    id: Uuid,
    domain: &str,
    origin: &str,
    ip_hash: &[u8],
) -> Result<(), DbError> {
    sqlx::query!(
        r#"insert into free_scans (id, domain, origin, ip_hash, status)
           values ($1, $2, $3, $4, 'queued')"#,
        id,
        domain,
        origin,
        ip_hash,
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// Queues the engine's run of a scan that [`create`] recorded, in the same transaction.
pub async fn enqueue(tx: &mut PublicTx, id: Uuid) -> Result<(), DbError> {
    sqlx::query!("select free_scan_enqueue($1)", id)
        .fetch_one(tx.conn())
        .await?;
    Ok(())
}

/// A scan that has not expired.
pub async fn get(tx: &mut PublicTx, id: Uuid) -> Result<Option<FreeScan>, DbError> {
    let row = sqlx::query!(
        r#"select id, domain, status, refusal, result, created_at from free_scans
            where id = $1 and expires_at > now()"#,
        id,
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(|r| FreeScan {
        id: r.id,
        domain: r.domain,
        status: r.status,
        refusal: r.refusal,
        result: r.result,
        created_at: r.created_at,
    }))
}

/// Deletes expired scans; the worker role runs it. Returns how many went.
pub async fn sweep(tx: &mut PublicTx) -> Result<i64, DbError> {
    Ok(
        sqlx::query_scalar!(r#"select free_scans_sweep() as "swept!""#)
            .fetch_one(tx.conn())
            .await?,
    )
}

/// Whether an engine whose Chromium has its own sandbox is serving free scans (a heartbeat in
/// the last 45 seconds, ADR-280). The api checks it before it spends anything on a request.
pub async fn engine_available(tx: &mut PublicTx) -> Result<bool, DbError> {
    Ok(
        sqlx::query_scalar!(r#"select free_scan_engine_available() as "available!""#)
            .fetch_one(tx.conn())
            .await?,
    )
}
