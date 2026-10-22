//! The queues `ctl` serves (ADR-035) and the refusal of any other.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use ctl::jobs;
use queue::Failure;
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

mod support;

use support::world::world;

#[sqlx::test(migrator = "db::MIGRATOR")]
async fn ctl_serves_the_four_r1_queues_and_refuses_any_other(
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
    // A payload of the wrong schema is a permanent failure of the handler, not of the registry.
    for queue in jobs::QUEUES {
        let Err(Failure::Permanent(error)) =
            w.jobs.dispatch(w.job(queue, "wrong@9", json!({}))).await
        else {
            panic!("{queue} accepted a payload of another schema");
        };
        assert_eq!(error.code, "payload_schema_unknown", "{queue}");
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
