//! The R1 queue stubs `ctl` registers (ADR-038): each answers with a typed permanent failure
//! until it is built; unknown queues are refused.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use ctl::jobs::{self, NOT_IMPLEMENTED};
use queue::Failure;
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

mod support;

use support::world::world;

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn every_unbuilt_queue_fails_permanently_and_an_unknown_queue_is_refused(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let w = world(opts, conn).await;
    assert_eq!(
        jobs::QUEUES,
        [
            "shopify.read_store",
            "shopify.apply_data_fix",
            "shopify.revert_data_fix",
            "webhook.process"
        ]
    );
    for queue in [
        "shopify.read_store",
        "shopify.apply_data_fix",
        "shopify.revert_data_fix",
    ] {
        let Err(Failure::Permanent(error)) = w
            .jobs
            .dispatch(w.job(queue, &format!("{queue}@1"), json!({})))
            .await
        else {
            panic!("{queue} did not fail permanently");
        };
        assert_eq!(error.code, NOT_IMPLEMENTED, "{queue}");
        assert!(error.message.contains(queue), "{queue}: {}", error.message);
    }
    let Err(Failure::Permanent(error)) = w
        .jobs
        .dispatch(w.job("scan.page", "scan.page@1", json!({})))
        .await
    else {
        panic!("scan.page was not refused");
    };
    assert_eq!(error.code, "queue_unknown");
}
