//! Bounces and complaints from SES through SNS (ADR-278), against a real database and a fake
//! SNS: a test certificate is generated here, the messages are signed with its key exactly as SNS
//! signs them (RSA PKCS#1 v1.5, SHA-256, over the documented string to sign), and the endpoint
//! verifies them with the real verification code. Only the certificate download is replaced.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use api::ses_events::{
    Fetch, FetchError, Fetching, SesEventsState, SnsMessage, SnsTopic, ses_events_router,
    string_to_sign,
};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use db::Db;
use rcgen::{CertificateParams, KeyPair, PKCS_RSA_SHA256, RsaKeySize, SigningKey};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;

mod support;

use support::app_login_pool;

const TOPIC: &str = "arn:aws:sns:eu-west-1:123456789012:rampsmith-ses-events";
const CERT_URL: &str = "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem";
const BOUNCED: &str = "gone@demo-store.example";

/// A signing identity: one RSA key and its certificate in PEM.
struct Identity {
    key: KeyPair,
    pem: String,
}

fn identity() -> Identity {
    let key = KeyPair::generate_rsa_for(&PKCS_RSA_SHA256, RsaKeySize::_2048).unwrap();
    let cert = CertificateParams::new(vec!["sns.eu-west-1.amazonaws.com".to_owned()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    Identity {
        pem: cert.pem(),
        key,
    }
}

/// The fake SNS: serves a certificate for the one URL it knows and the confirmation address, and
/// counts what was asked.
#[derive(Debug)]
struct FakeSns {
    pem: String,
    certificate_fetches: AtomicUsize,
    confirmations: AtomicUsize,
    down: bool,
}

impl Fetch for FakeSns {
    fn get<'a>(&'a self, url: &'a Url) -> Fetching<'a> {
        Box::pin(async move {
            if self.down {
                return Err(FetchError);
            }
            if url.path().to_ascii_lowercase().ends_with("pem") {
                self.certificate_fetches.fetch_add(1, Ordering::SeqCst);
                Ok(self.pem.clone().into_bytes())
            } else {
                self.confirmations.fetch_add(1, Ordering::SeqCst);
                Ok(b"<ConfirmSubscriptionResponse/>".to_vec())
            }
        })
    }
}

struct Harness {
    router: Router,
    sns: Arc<FakeSns>,
    signer: Identity,
    owner: PgPool,
    tenant: Uuid,
}

async fn harness_with(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
    served: Option<&Identity>,
    down: bool,
) -> Harness {
    let owner = opts.clone().connect_with(conn.clone()).await.unwrap();
    let signer = identity();
    let sns = Arc::new(FakeSns {
        pem: served.map_or_else(|| signer.pem.clone(), |other| other.pem.clone()),
        certificate_fetches: AtomicUsize::new(0),
        confirmations: AtomicUsize::new(0),
        down,
    });
    let db = Db::from_pool(app_login_pool(opts, conn).await);
    let router = ses_events_router(SesEventsState::new(
        db,
        SnsTopic::parse(TOPIC).unwrap(),
        sns.clone(),
    ));
    let tenant: Uuid = sqlx::query_scalar(
        "insert into tenants (id, kind) values (gen_random_uuid(), 'shopify_store') returning id",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    Harness {
        router,
        sns,
        signer,
        owner,
        tenant,
    }
}

async fn harness(opts: PgPoolOptions, conn: PgConnectOptions) -> Harness {
    harness_with(opts, conn, None, false).await
}

impl Harness {
    async fn delivery(&self, tenant: Uuid, key: &str, message_id: &str) {
        sqlx::query(
            "insert into email_deliveries (tenant_id, message_key, template, state, message_id)
             values ($1, $2, 'first_scan_complete', 'sent', $3)",
        )
        .bind(tenant)
        .bind(key)
        .bind(message_id)
        .execute(&self.owner)
        .await
        .unwrap();
    }

    async fn other_tenant(&self) -> Uuid {
        sqlx::query_scalar(
            "insert into tenants (id, kind) values (gen_random_uuid(), 'shopify_store') returning id",
        )
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    /// The reasons on the tenant's suppression list for `address`.
    async fn reasons(&self, tenant: Uuid, address: &str) -> Vec<String> {
        sqlx::query_scalar(
            "select reason from email_suppressions
              where tenant_id = $1 and address_hash = email_address_hash($1, $2)",
        )
        .bind(tenant)
        .bind(address)
        .fetch_all(&self.owner)
        .await
        .unwrap()
    }

    async fn suppressions(&self) -> i64 {
        sqlx::query_scalar("select count(*) from email_suppressions")
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }

    async fn audits(&self, tenant: Uuid) -> Vec<Value> {
        sqlx::query_scalar(
            "select data from audit_log where tenant_id = $1 and action = 'email.suppressed'",
        )
        .bind(tenant)
        .fetch_all(&self.owner)
        .await
        .unwrap()
    }

    /// A signed `Notification` with `event` as its `Message`.
    fn notification(&self, event: &Value) -> Value {
        self.signed("Notification", &event.to_string(), TOPIC, CERT_URL, "2")
    }

    fn signed(&self, kind: &str, message: &str, topic: &str, cert: &str, version: &str) -> Value {
        self.signed_to(kind, message, topic, cert, version, None)
    }

    fn signed_to(
        &self,
        kind: &str,
        message: &str,
        topic: &str,
        cert: &str,
        version: &str,
        subscribe: Option<&str>,
    ) -> Value {
        let mut m = SnsMessage {
            r#type: kind.to_owned(),
            message_id: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324".to_owned(),
            topic_arn: topic.to_owned(),
            message: message.to_owned(),
            subject: None,
            timestamp: "2026-10-23T10:00:00.000Z".to_owned(),
            signature: String::new(),
            signature_version: version.to_owned(),
            signing_cert_url: cert.to_owned(),
            subscribe_url: None,
            token: None,
        };
        if kind != "Notification" {
            m.subscribe_url = Some(subscribe.map_or_else(
                || {
                    format!(
                        "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn={topic}&Token=abc"
                    )
                },
                str::to_owned,
            ));
            m.token = Some("abc".to_owned());
        }
        let text = string_to_sign(&m).unwrap();
        let signature = STANDARD.encode(self.signer.key.sign(text.as_bytes()).unwrap());
        let mut body = json!({
            "Type": m.r#type, "MessageId": m.message_id, "TopicArn": m.topic_arn,
            "Message": m.message, "Timestamp": m.timestamp, "Signature": signature,
            "SignatureVersion": m.signature_version, "SigningCertURL": m.signing_cert_url,
            "UnsubscribeURL": "https://sns.eu-west-1.amazonaws.com/?Action=Unsubscribe",
        });
        if let (Some(url), Some(token)) = (m.subscribe_url, m.token) {
            body["SubscribeURL"] = url.into();
            body["Token"] = token.into();
        }
        body
    }

    async fn post(&self, header_type: Option<&str>, body: &Value) -> StatusCode {
        self.post_raw(header_type, body.to_string()).await
    }

    async fn post_raw(&self, header_type: Option<&str>, body: String) -> StatusCode {
        let mut request = Request::post("/webhooks/ses").header("content-type", "text/plain");
        if let Some(kind) = header_type {
            request = request.header("x-amz-sns-message-type", kind);
        }
        self.router
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap()
            .status()
    }
}

fn bounce(kind: &str, message_id: &str, address: &str) -> Value {
    json!({
        "eventType": "Bounce",
        "bounce": {"bounceType": kind, "bounceSubType": "General",
            "bouncedRecipients": [{"emailAddress": address, "action": "failed"}]},
        "mail": {"messageId": message_id, "destination": [address]},
    })
}

fn complaint(message_id: &str, address: &str) -> Value {
    json!({
        "eventType": "Complaint",
        "complaint": {"complainedRecipients": [{"emailAddress": address}],
            "complaintFeedbackType": "abuse"},
        "mail": {"messageId": message_id},
    })
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_signed_permanent_bounce_puts_the_address_on_the_senders_list(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn).await;
    h.delivery(h.tenant, "welcome:shop-1", "0102-aaaa").await;
    let body = h.notification(&bounce("Permanent", "0102-aaaa", BOUNCED));
    assert_eq!(h.post(Some("Notification"), &body).await, StatusCode::OK);
    assert_eq!(h.reasons(h.tenant, BOUNCED).await, ["bounced"]);
    assert_eq!(h.sns.certificate_fetches.load(Ordering::SeqCst), 1);
    let audits = h.audits(h.tenant).await;
    assert_eq!(audits, [json!({"reason": "bounced", "recipients": 1})]);
    assert!(
        !audits[0].to_string().contains("demo-store"),
        "the audit entry holds no address"
    );
    // The same notification again (SNS redelivers) changes nothing and reuses the certificate.
    assert_eq!(h.post(Some("Notification"), &body).await, StatusCode::OK);
    assert_eq!(h.reasons(h.tenant, BOUNCED).await, ["bounced"]);
    assert_eq!(h.sns.certificate_fetches.load(Ordering::SeqCst), 1);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_complaint_is_recorded_and_the_notification_type_shape_works_too(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn).await;
    h.delivery(h.tenant, "welcome:shop-1", "0102-bbbb").await;
    let body = h.notification(&complaint("0102-bbbb", "grumpy@demo-store.example"));
    assert_eq!(h.post(Some("Notification"), &body).await, StatusCode::OK);
    assert_eq!(
        h.reasons(h.tenant, "grumpy@demo-store.example").await,
        ["complained"]
    );
    let old_shape = json!({
        "notificationType": "Bounce",
        "bounce": {"bounceType": "Permanent", "bouncedRecipients": [{"emailAddress": "Old@demo-store.example"}]},
        "mail": {"messageId": "0102-bbbb"},
    });
    let body = h.notification(&old_shape);
    assert_eq!(h.post(Some("Notification"), &body).await, StatusCode::OK);
    // The hash ignores case.
    assert_eq!(
        h.reasons(h.tenant, "old@demo-store.example").await,
        ["bounced"]
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn transient_bounces_deliveries_and_unknown_messages_write_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn).await;
    h.delivery(h.tenant, "welcome:shop-1", "0102-cccc").await;
    for event in [
        bounce("Transient", "0102-cccc", BOUNCED),
        bounce("Undetermined", "0102-cccc", BOUNCED),
        json!({"eventType": "Delivery", "delivery": {"recipients": [BOUNCED]},
               "mail": {"messageId": "0102-cccc"}}),
        json!({"eventType": "Send", "mail": {"messageId": "0102-cccc"}}),
        bounce("Permanent", "0102-not-ours", BOUNCED),
    ] {
        let body = h.notification(&event);
        assert_eq!(h.post(Some("Notification"), &body).await, StatusCode::OK);
    }
    assert_eq!(h.suppressions().await, 0);
    assert_eq!(h.audits(h.tenant).await, Vec::<Value>::new());
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_bounce_is_written_to_the_tenant_that_sent_the_message_and_no_other(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn).await;
    let other = h.other_tenant().await;
    h.delivery(h.tenant, "welcome:shop-1", "0102-mine").await;
    h.delivery(other, "welcome:shop-9", "0102-theirs").await;
    let body = h.notification(&bounce("Permanent", "0102-theirs", BOUNCED));
    assert_eq!(h.post(Some("Notification"), &body).await, StatusCode::OK);
    assert_eq!(h.reasons(other, BOUNCED).await, ["bounced"]);
    assert_eq!(h.reasons(h.tenant, BOUNCED).await, Vec::<String>::new());
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_unsubscribe_after_a_bounce_does_not_weaken_it_and_a_bounce_widens_an_unsubscribe(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    use db::repo::email::{SuppressionReason, suppress};
    let h = harness(opts, conn).await;
    h.delivery(h.tenant, "welcome:shop-1", "0102-dddd").await;
    // Unsubscribed first, then bounced: the bounce wins.
    sqlx::query(
        "insert into email_suppressions (tenant_id, address_hash, reason)
         values ($1, email_address_hash($1, $2), 'unsubscribed')",
    )
    .bind(h.tenant)
    .bind(BOUNCED)
    .execute(&h.owner)
    .await
    .unwrap();
    let body = h.notification(&bounce("Permanent", "0102-dddd", BOUNCED));
    assert_eq!(h.post(Some("Notification"), &body).await, StatusCode::OK);
    assert_eq!(h.reasons(h.tenant, BOUNCED).await, ["bounced"]);
    // The repo function keeps it when an unsubscribe arrives afterwards.
    let pool = app_pool_for(&h).await;
    let mut tx = pool
        .tenant(domain::TenantId::from_uuid(h.tenant))
        .await
        .unwrap();
    suppress(&mut tx, BOUNCED, SuppressionReason::Unsubscribed)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(h.reasons(h.tenant, BOUNCED).await, ["bounced"]);
}

async fn app_pool_for(h: &Harness) -> Db {
    // The owner pool bypasses row-level security, so go through the application login the way
    // the endpoint does.
    let options = h.owner.connect_options();
    let opts = PgPoolOptions::new();
    Db::from_pool(app_login_pool(opts, (*options).clone()).await)
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_tampered_message_is_refused_and_writes_nothing(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn).await;
    h.delivery(h.tenant, "welcome:shop-1", "0102-eeee").await;
    let mut body = h.notification(&bounce("Permanent", "0102-eeee", BOUNCED));
    let swapped = bounce("Permanent", "0102-eeee", "someone-else@demo-store.example");
    body["Message"] = swapped.to_string().into();
    assert_eq!(
        h.post(Some("Notification"), &body).await,
        StatusCode::UNAUTHORIZED
    );
    // A tampered timestamp, subject or message id is covered too.
    for (field, value) in [
        ("Timestamp", "2026-10-23T10:00:01.000Z"),
        ("MessageId", "other"),
        ("Subject", "added"),
    ] {
        let mut body = h.notification(&bounce("Permanent", "0102-eeee", BOUNCED));
        body[field] = value.into();
        assert_eq!(
            h.post(Some("Notification"), &body).await,
            StatusCode::UNAUTHORIZED,
            "{field}"
        );
    }
    assert_eq!(h.suppressions().await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_message_signed_by_another_key_is_refused(opts: PgPoolOptions, conn: PgConnectOptions) {
    let genuine = identity();
    let h = harness_with(opts, conn, Some(&genuine), false).await;
    h.delivery(h.tenant, "welcome:shop-1", "0102-ffff").await;
    // Signed with the harness signer, but the "AWS" certificate is another key's.
    let body = h.notification(&bounce("Permanent", "0102-ffff", BOUNCED));
    assert_eq!(
        h.post(Some("Notification"), &body).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(h.suppressions().await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_message_for_another_topic_is_refused_before_any_fetch(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn).await;
    h.delivery(h.tenant, "welcome:shop-1", "0102-gggg").await;
    let body = h.signed(
        "Notification",
        &bounce("Permanent", "0102-gggg", BOUNCED).to_string(),
        "arn:aws:sns:eu-west-1:123456789012:someone-elses-topic",
        CERT_URL,
        "2",
    );
    assert_eq!(
        h.post(Some("Notification"), &body).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(h.sns.certificate_fetches.load(Ordering::SeqCst), 0);
    assert_eq!(h.suppressions().await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn signature_version_one_and_hostile_certificate_urls_are_refused_without_fetching(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn).await;
    h.delivery(h.tenant, "welcome:shop-1", "0102-hhhh").await;
    let event = bounce("Permanent", "0102-hhhh", BOUNCED).to_string();
    let v1 = h.signed("Notification", &event, TOPIC, CERT_URL, "1");
    assert_eq!(
        h.post(Some("Notification"), &v1).await,
        StatusCode::UNAUTHORIZED
    );
    for url in [
        "http://sns.eu-west-1.amazonaws.com/a.pem",
        "https://evil.example/a.pem",
        "https://sns.eu-west-1.amazonaws.com.evil.example/a.pem",
        "https://sns.us-east-1.amazonaws.com/a.pem",
        "https://sns.eu-west-1.amazonaws.com:8443/a.pem",
        "https://sns.eu-west-1.amazonaws.com/a.pem?x=1",
        "https://sns.eu-west-1.amazonaws.com/a.txt",
        "not a url",
        "",
    ] {
        let body = h.signed("Notification", &event, TOPIC, url, "2");
        assert_eq!(
            h.post(Some("Notification"), &body).await,
            StatusCode::UNAUTHORIZED,
            "{url:?}"
        );
    }
    assert_eq!(h.sns.certificate_fetches.load(Ordering::SeqCst), 0);
    assert_eq!(h.suppressions().await, 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn malformed_requests_are_refused(opts: PgPoolOptions, conn: PgConnectOptions) {
    let h = harness(opts, conn).await;
    let body = h.notification(&bounce("Permanent", "x", BOUNCED));
    // No header, a header that disagrees with the body's type, not JSON, and a missing field.
    assert_eq!(h.post(None, &body).await, StatusCode::BAD_REQUEST);
    assert_eq!(
        h.post(Some("SubscriptionConfirmation"), &body).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.post_raw(Some("Notification"), "nope".to_owned()).await,
        StatusCode::BAD_REQUEST
    );
    let mut missing = body.clone();
    missing.as_object_mut().unwrap().remove("Signature");
    assert_eq!(
        h.post(Some("Notification"), &missing).await,
        StatusCode::BAD_REQUEST
    );
    // Over 256 KiB.
    let huge = "x".repeat(300 * 1024);
    assert_eq!(
        h.post_raw(Some("Notification"), huge).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(h.sns.certificate_fetches.load(Ordering::SeqCst), 0);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn an_unreachable_certificate_answers_503_so_sns_retries(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness_with(opts, conn, None, true).await;
    let body = h.notification(&bounce("Permanent", "0102-iiii", BOUNCED));
    assert_eq!(
        h.post(Some("Notification"), &body).await,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[sqlx::test(migrations = "../db/migrations")]
async fn a_subscription_confirmation_is_followed_only_when_signed_and_for_this_topic(
    opts: PgPoolOptions,
    conn: PgConnectOptions,
) {
    let h = harness(opts, conn).await;
    let good = h.signed(
        "SubscriptionConfirmation",
        "You have chosen to subscribe",
        TOPIC,
        CERT_URL,
        "2",
    );
    assert_eq!(
        h.post(Some("SubscriptionConfirmation"), &good).await,
        StatusCode::OK
    );
    assert_eq!(h.sns.confirmations.load(Ordering::SeqCst), 1);

    // A forged one is not followed.
    let mut forged = good.clone();
    forged["Token"] = "other".into();
    assert_eq!(
        h.post(Some("SubscriptionConfirmation"), &forged).await,
        StatusCode::UNAUTHORIZED
    );
    // A correctly signed one whose SubscribeURL points elsewhere, or at another topic, is not
    // followed.
    for url in [
        format!("https://evil.example/?Action=ConfirmSubscription&TopicArn={TOPIC}"),
        "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:eu-west-1:123456789012:other".to_owned(),
        format!("https://sns.eu-west-1.amazonaws.com/?Action=Unsubscribe&TopicArn={TOPIC}"),
        format!("http://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn={TOPIC}"),
    ] {
        let body = h.signed_to("SubscriptionConfirmation", "m", TOPIC, CERT_URL, "2", Some(&url));
        assert_eq!(
            h.post(Some("SubscriptionConfirmation"), &body).await,
            StatusCode::BAD_REQUEST,
            "{url}"
        );
    }
    assert_eq!(h.sns.confirmations.load(Ordering::SeqCst), 1);
}
