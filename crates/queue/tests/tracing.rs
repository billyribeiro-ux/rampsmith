//! One trace follows work across the queue (PLAN §10, §21): the enqueuer's trace context is
//! stored with the job, and the worker's job span continues it.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::time::Duration;

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use queue::{NewJob, WorkerConfig};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use support::{owner_pool, worker_pool};
use tracing::Instrument;
use tracing_subscriber::layer::SubscriberExt;

#[sqlx::test(migrations = "../db/migrations")]
async fn a_job_span_continues_the_trace_that_enqueued_it(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("test")));
    let _default = tracing::subscriber::set_default(subscriber);

    let pool = worker_pool(opts.clone(), conn.clone()).await;
    let owner = owner_pool(opts, conn).await;
    async {
        let mut c = pool.acquire().await.unwrap();
        queue::enqueue(
            &mut c,
            &NewJob::new("test.effect", "test.effect@1", json!({})),
        )
        .await
        .unwrap();
    }
    .instrument(tracing::info_span!("webhook"))
    .await;
    let stored: Option<String> = sqlx::query_scalar("select traceparent from jobs")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(
        stored.is_some(),
        "the enqueuer's trace context was not stored"
    );

    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let done_tx = std::sync::Mutex::new(Some(done_tx));
    let mut config = WorkerConfig::new("test.effect", "w1");
    config.poll_interval = Duration::from_millis(100);
    let handler = move |_job| {
        let signal = done_tx.lock().unwrap().take();
        async move {
            tracing::info_span!("handler").in_scope(|| ());
            if let Some(tx) = signal {
                let _ = tx.send(());
            }
            Ok(())
        }
    };
    queue::run(pool, config, handler, async {
        let _ = done_rx.await;
    })
    .await
    .unwrap();

    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    let webhook = spans
        .iter()
        .find(|s| s.name == "webhook")
        .expect("webhook span");
    let job = spans.iter().find(|s| s.name == "job").expect("job span");
    let handler = spans
        .iter()
        .find(|s| s.name == "handler")
        .expect("handler span");
    assert_eq!(job.span_context.trace_id(), webhook.span_context.trace_id());
    assert_eq!(job.parent_span_id, webhook.span_context.span_id());
    assert_eq!(handler.parent_span_id, job.span_context.span_id());
    let attrs: Vec<String> = job.attributes.iter().map(|kv| kv.key.to_string()).collect();
    for key in ["queue", "job_id", "attempt"] {
        assert!(
            attrs.iter().any(|k| k == key),
            "job span lacks {key}: {attrs:?}"
        );
    }
}
