//! The R1 queue stubs `ctl` registers (ADR-038): each answers with a typed permanent failure.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use ctl::jobs::{self, NOT_IMPLEMENTED};
use db::Db;
use queue::{ClaimedJob, Failure, Lease};
use sqlx::postgres::PgPoolOptions;
use time::OffsetDateTime;
use uuid::Uuid;

fn job(queue: &str) -> ClaimedJob {
    ClaimedJob {
        lease: Lease {
            job_id: Uuid::nil(),
            worker: "test".to_owned(),
            attempt: 1,
        },
        queue: queue.to_owned(),
        payload_schema: format!("{queue}@1"),
        payload: serde_json::json!({}),
        tenant_id: None,
        max_attempts: 3,
        locked_until: OffsetDateTime::now_utc(),
        traceparent: None,
    }
}

/// A handle that never connects: the stubs do not touch the database.
fn db() -> Db {
    Db::from_pool(
        PgPoolOptions::new()
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .unwrap(),
    )
}

#[tokio::test]
async fn every_r1_queue_is_registered_and_fails_permanently_until_it_is_built() {
    assert_eq!(
        jobs::QUEUES,
        [
            "shopify.read_store",
            "shopify.apply_data_fix",
            "shopify.revert_data_fix",
            "webhook.process"
        ]
    );
    let db = db();
    for queue in jobs::QUEUES {
        let Err(Failure::Permanent(error)) = jobs::dispatch(&db, job(queue)).await else {
            panic!("{queue} did not fail permanently");
        };
        assert_eq!(error.code, NOT_IMPLEMENTED, "{queue}");
        assert!(!error.retryable, "{queue}");
        assert!(error.message.contains(queue), "{queue}: {}", error.message);
    }
}

#[tokio::test]
async fn a_queue_ctl_does_not_serve_is_refused() {
    let Err(Failure::Permanent(error)) = jobs::dispatch(&db(), job("scan.page")).await else {
        panic!("scan.page was not refused");
    };
    assert_eq!(error.code, "queue_unknown");
}
