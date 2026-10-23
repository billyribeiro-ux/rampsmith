//! Bounces and complaints from Amazon SES, through Amazon SNS, into the suppression list
//! (ADR-278). The route is `POST /webhooks/ses` on the public webhook listener.
//!
//! SES publishes an event to an SNS topic (through a configuration set); SNS posts it to this
//! endpoint as a JSON document with a signature. Nothing here is trusted until the signature
//! has been verified, in this order, cheapest first:
//!
//! 1. the `x-amz-sns-message-type` header must be present and equal the body's `Type`;
//! 2. the body's `TopicArn` must be the one configured (`SES_SNS_TOPIC_ARN`), so a message from
//!    another topic, even a genuine SNS message, is refused before any certificate is fetched;
//! 3. `SignatureVersion` must be `2` (SHA-256). Version `1` signs with SHA-1 and is refused;
//! 4. `SigningCertURL` must be `https://sns.<region>.amazonaws.com/<path>.pem`, with the region
//!    of the topic and no port, user, query or fragment. The certificate is fetched only then;
//! 5. the signature is RSA PKCS#1 v1.5 over SHA-256 of the string to sign, verified with the
//!    public key of that certificate.
//!
//! Sources, read on 23 Oct 2026: AWS's "Verifying the signatures of Amazon SNS messages"
//! (docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html:
//! the string-to-sign fields and their order, `SignatureVersion` 1 is SHA-1 and 2 is SHA-256,
//! reject certificate URLs outside AWS domains) and the reference implementation in
//! `aws/aws-php-sns-message-validator` (`MessageValidator.php`: `https`, a host matching
//! `sns.<region>.amazonaws.com`, a `.pem` path, the `Key\nValue\n` string over the keys Message,
//! `MessageId`, `Subject`, `SubscribeURL`, `Timestamp`, `Token`, `TopicArn`, `Type` that are
//! present).
//! The certificate chain is not validated: AWS's own validators do not, and the trust comes from
//! fetching it over TLS from a host only `amazonaws.com` can serve.
//!
//! What a verified message does:
//!
//! - `SubscriptionConfirmation`: fetches the `SubscribeURL` after checking it names the same
//!   host and topic, so the founder confirms the subscription by creating it;
//! - `Notification` carrying an SES event: a permanent bounce or any complaint puts each
//!   recipient on the suppression list of the tenant that sent the message, found by the SES
//!   message id the mailer stored (`email_deliveries.message_id`). Every other event kind
//!   (delivery, send, reject, a transient bounce) is acknowledged and dropped.
//!
//! Recipient addresses are personal data. They are read, hashed by the database and never
//! logged; a log line holds counts and the event kind.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use db::Db;
use db::repo::audit::{self, NewEntry};
use db::repo::email::{self, SuppressionReason};
use domain::ActorKind;
use http_kit::{ApiError, Limits, ProblemCode, with_middleware};
use rustls_pki_types::CertificateDer;
use serde::Deserialize;
use serde_json::json;
use thiserror::Error;
use tracing::{info, warn};
use url::Url;
use webpki::EndEntityCert;

/// The largest SNS body read. SNS limits a message to 256 KiB.
const MAX_BODY_BYTES: usize = 256 * 1024;
/// Recipients taken from one event; SES lists the recipients of one message, at most 50.
const MAX_RECIPIENTS: usize = 100;
/// The largest certificate or confirmation answer read.
const MAX_FETCH_BYTES: usize = 64 * 1024;
/// How long a fetched signing certificate is reused.
const CERT_TTL: Duration = Duration::from_hours(6);
/// Certificates kept: SNS has used a handful of certificates per region.
const CERT_CACHE_ENTRIES: usize = 8;

/// The configured topic could not be used.
#[derive(Debug, Error, PartialEq, Eq)]
#[error("SES_SNS_TOPIC_ARN must look like arn:aws:sns:<region>:<12-digit account>:<topic name>")]
pub struct TopicError;

/// The SNS topic whose messages are accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnsTopic {
    arn: String,
    region: String,
}

impl SnsTopic {
    /// Parses `arn:aws:sns:<region>:<account>:<name>`.
    ///
    /// # Errors
    ///
    /// [`TopicError`] for any other shape, which includes another partition or service.
    pub fn parse(arn: &str) -> Result<Self, TopicError> {
        let parts: Vec<&str> = arn.split(':').collect();
        let [prefix, partition, service, region, account, name] = parts.as_slice() else {
            return Err(TopicError);
        };
        let region_ok = !region.is_empty()
            && region.len() <= 25
            && region
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        let name_ok = !name.is_empty()
            && name.len() <= 256
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if *prefix != "arn"
            || *partition != "aws"
            || *service != "sns"
            || !region_ok
            || account.len() != 12
            || !account.bytes().all(|b| b.is_ascii_digit())
            || !name_ok
        {
            return Err(TopicError);
        }
        Ok(Self {
            arn: arn.to_owned(),
            region: (*region).to_owned(),
        })
    }

    /// The topic's ARN.
    #[must_use]
    pub fn arn(&self) -> &str {
        &self.arn
    }

    fn host(&self) -> String {
        format!("sns.{}.amazonaws.com", self.region)
    }
}

/// Why a fetch failed. Nothing about the answer is kept.
#[derive(Debug, Error, PartialEq, Eq)]
#[error("the fetch failed")]
pub struct FetchError;

/// A boxed future, so the fetcher can be a trait object.
pub type Fetching<'a> = Pin<Box<dyn Future<Output = Result<Vec<u8>, FetchError>> + Send + 'a>>;

/// How the endpoint reads the two things it fetches: the signing certificate and the
/// subscription confirmation. A test replaces it with a fake SNS.
pub trait Fetch: Send + Sync + std::fmt::Debug {
    /// `GET url` and return the body, or fail. The caller has already checked the URL.
    fn get<'a>(&'a self, url: &'a Url) -> Fetching<'a>;
}

/// The production fetcher: HTTPS only, no redirects, a short timeout and a size cap.
#[derive(Debug, Clone)]
pub struct HttpsFetch {
    client: reqwest::Client,
}

impl HttpsFetch {
    /// A fetcher with its own client.
    ///
    /// # Errors
    ///
    /// The client could not be built.
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .https_only(true)
                .build()?,
        })
    }
}

impl Fetch for HttpsFetch {
    fn get<'a>(&'a self, url: &'a Url) -> Fetching<'a> {
        Box::pin(async move {
            let mut response = self
                .client
                .get(url.as_str())
                .send()
                .await
                .map_err(|_| FetchError)?;
            if !response.status().is_success() {
                return Err(FetchError);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| FetchError)? {
                if body.len() + chunk.len() > MAX_FETCH_BYTES {
                    return Err(FetchError);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(body)
        })
    }
}

/// A fetched certificate, by its URL, with the time it was fetched.
type CertCache = HashMap<String, (Instant, Vec<u8>)>;

/// What the route needs.
#[derive(Clone, Debug)]
pub struct SesEventsState {
    db: Db,
    topic: SnsTopic,
    fetch: Arc<dyn Fetch>,
    certs: Arc<Mutex<CertCache>>,
}

impl SesEventsState {
    /// State for the listener.
    #[must_use]
    pub fn new(db: Db, topic: SnsTopic, fetch: Arc<dyn Fetch>) -> Self {
        Self {
            db,
            topic,
            fetch,
            certs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn certificate(&self, url: &Url) -> Result<Vec<u8>, Reject> {
        let key = url.as_str().to_owned();
        if let Ok(cache) = self.certs.lock()
            && let Some((at, pem)) = cache.get(&key)
            && at.elapsed() < CERT_TTL
        {
            return Ok(pem.clone());
        }
        let pem = self
            .fetch
            .get(url)
            .await
            .map_err(|FetchError| Reject::CertificateUnavailable)?;
        if let Ok(mut cache) = self.certs.lock() {
            if cache.len() >= CERT_CACHE_ENTRIES {
                cache.clear();
            }
            cache.insert(key, (Instant::now(), pem.clone()));
        }
        Ok(pem)
    }

    /// Forgets a certificate whose signature did not verify, so the next message fetches it
    /// again (AWS rotates the signing certificate).
    fn forget(&self, url: &Url) {
        if let Ok(mut cache) = self.certs.lock() {
            cache.remove(url.as_str());
        }
    }
}

/// An SNS message as it arrives. Only the members used for the signature and the dispatch are
/// read; SNS adds others (`UnsubscribeURL`, `MessageAttributes`) that the signature does not
/// cover.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct SnsMessage {
    /// `Notification`, `SubscriptionConfirmation` or `UnsubscribeConfirmation`.
    pub r#type: String,
    /// SNS's id for the message.
    pub message_id: String,
    /// The topic.
    pub topic_arn: String,
    /// The payload: for a notification, the SES event as JSON text.
    pub message: String,
    /// Optional on a notification.
    pub subject: Option<String>,
    /// An ISO 8601 time.
    pub timestamp: String,
    /// Base64 of the signature.
    pub signature: String,
    /// `1` or `2`.
    pub signature_version: String,
    /// Where the signing certificate is.
    #[serde(rename = "SigningCertURL")]
    pub signing_cert_url: String,
    /// On a confirmation: where to confirm.
    #[serde(rename = "SubscribeURL")]
    pub subscribe_url: Option<String>,
    /// On a confirmation.
    pub token: Option<String>,
}

/// Why a message was refused. The code is logged; the caller sees only a status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum Reject {
    /// The body is not an SNS message, or the header and the body disagree.
    #[error("malformed")]
    Malformed,
    /// A genuine message from another topic.
    #[error("wrong_topic")]
    WrongTopic,
    /// Signature version 1 (SHA-1) or anything but 2.
    #[error("unsupported_signature_version")]
    UnsupportedVersion,
    /// The certificate URL is not an SNS certificate address.
    #[error("bad_certificate_url")]
    BadCertificateUrl,
    /// The certificate could not be fetched (retry).
    #[error("certificate_unavailable")]
    CertificateUnavailable,
    /// The certificate could not be read.
    #[error("bad_certificate")]
    BadCertificate,
    /// The signature does not match the message.
    #[error("bad_signature")]
    BadSignature,
}

impl From<Reject> for ApiError {
    fn from(reject: Reject) -> Self {
        warn!(reason = %reject, "ses event refused");
        match reject {
            Reject::Malformed => ApiError::new(ProblemCode::BadRequest),
            Reject::WrongTopic => ApiError::new(ProblemCode::Forbidden),
            Reject::CertificateUnavailable => ApiError::new(ProblemCode::Unavailable),
            Reject::UnsupportedVersion
            | Reject::BadCertificateUrl
            | Reject::BadCertificate
            | Reject::BadSignature => ApiError::new(ProblemCode::Unauthenticated),
        }
    }
}

/// The text SNS signed: each present field as `Key\nValue\n`, in byte order of the key, over
/// the fields the message type covers. `None` for a type that is signed but needs a member the
/// message lacks.
#[must_use]
pub fn string_to_sign(message: &SnsMessage) -> Option<String> {
    let confirmation = matches!(
        message.r#type.as_str(),
        "SubscriptionConfirmation" | "UnsubscribeConfirmation"
    );
    let mut fields: Vec<(&str, &str)> = vec![
        ("Message", &message.message),
        ("MessageId", &message.message_id),
        ("Timestamp", &message.timestamp),
        ("TopicArn", &message.topic_arn),
        ("Type", &message.r#type),
    ];
    if confirmation {
        fields.push(("SubscribeURL", message.subscribe_url.as_deref()?));
        fields.push(("Token", message.token.as_deref()?));
    } else if let Some(subject) = &message.subject {
        fields.push(("Subject", subject));
    }
    fields.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut text = String::new();
    for (key, value) in fields {
        text.push_str(key);
        text.push('\n');
        text.push_str(value);
        text.push('\n');
    }
    Some(text)
}

/// The signing certificate's URL, if it is one SNS serves for `topic`'s region.
#[must_use]
pub fn certificate_url(topic: &SnsTopic, text: &str) -> Option<Url> {
    let url = Url::parse(text).ok()?;
    let ok = url.scheme() == "https"
        && url.host_str() == Some(topic.host().as_str())
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().len() <= 200
        && url.path().starts_with('/')
        && std::path::Path::new(url.path())
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pem"));
    ok.then_some(url)
}

fn der_of(pem: &[u8]) -> Option<Vec<u8>> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let text = std::str::from_utf8(pem).ok()?;
    let start = text.find(BEGIN)? + BEGIN.len();
    let stop = text[start..].find(END)? + start;
    let body: String = text[start..stop]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    STANDARD.decode(body).ok()
}

/// Whether `message.signature` is the signature of its string to sign under the key of the
/// certificate in `pem`. RSA PKCS#1 v1.5 with SHA-256 (`SignatureVersion` 2).
///
/// # Errors
///
/// [`Reject::BadCertificate`] when the certificate cannot be read, [`Reject::BadSignature`]
/// when the signature is not valid base64 or does not verify.
pub fn verify(message: &SnsMessage, pem: &[u8]) -> Result<(), Reject> {
    let der = der_of(pem).ok_or(Reject::BadCertificate)?;
    let der = CertificateDer::from(der);
    let certificate = EndEntityCert::try_from(&der).map_err(|_| Reject::BadCertificate)?;
    let signed = string_to_sign(message).ok_or(Reject::Malformed)?;
    let signature = STANDARD
        .decode(message.signature.trim())
        .map_err(|_| Reject::BadSignature)?;
    certificate
        .verify_signature(
            webpki::aws_lc_rs::RSA_PKCS1_2048_8192_SHA256,
            signed.as_bytes(),
            &signature,
        )
        .map_err(|_| Reject::BadSignature)
}

/// The listener's route: `POST /webhooks/ses`.
pub fn ses_events_router(state: SesEventsState) -> Router {
    let router = Router::new()
        .route("/webhooks/ses", post(receive))
        .with_state(state);
    with_middleware(
        router,
        Limits {
            request_timeout: Duration::from_secs(10),
            body_bytes: MAX_BODY_BYTES,
        },
    )
}

async fn receive(
    State(state): State<SesEventsState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let message: SnsMessage = serde_json::from_slice(&body).map_err(|_| Reject::Malformed)?;
    let declared = headers
        .get("x-amz-sns-message-type")
        .and_then(|value| value.to_str().ok());
    if declared != Some(message.r#type.as_str()) {
        return Err(Reject::Malformed.into());
    }
    if message.topic_arn != state.topic.arn() {
        return Err(Reject::WrongTopic.into());
    }
    if message.signature_version != "2" {
        return Err(Reject::UnsupportedVersion.into());
    }
    let url = certificate_url(&state.topic, &message.signing_cert_url)
        .ok_or(Reject::BadCertificateUrl)?;
    let pem = state.certificate(&url).await?;
    if let Err(reject) = verify(&message, &pem) {
        if reject == Reject::BadSignature {
            // The certificate may have been rotated since it was cached.
            state.forget(&url);
        }
        return Err(reject.into());
    }

    match message.r#type.as_str() {
        "SubscriptionConfirmation" => confirm(&state, &message).await,
        "Notification" => notification(&state, &message).await,
        _ => {
            info!(kind = %message.r#type, "sns message acknowledged and dropped");
            Ok(StatusCode::OK)
        }
    }
}

/// Confirms a subscription after checking the address is SNS's, for this topic.
async fn confirm(state: &SesEventsState, message: &SnsMessage) -> Result<StatusCode, ApiError> {
    let url = message
        .subscribe_url
        .as_deref()
        .and_then(|text| Url::parse(text).ok())
        .filter(|url| {
            let pairs: HashMap<_, _> = url.query_pairs().collect();
            url.scheme() == "https"
                && url.host_str() == Some(state.topic.host().as_str())
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && pairs.get("Action").map(AsRef::as_ref) == Some("ConfirmSubscription")
                && pairs.get("TopicArn").map(AsRef::as_ref) == Some(state.topic.arn())
        })
        .ok_or(Reject::Malformed)?;
    state
        .fetch
        .get(&url)
        .await
        .map_err(|FetchError| Reject::CertificateUnavailable)?;
    info!("sns subscription confirmed");
    Ok(StatusCode::OK)
}

/// The members of an SES event this endpoint reads. SES calls the discriminator `eventType`
/// when event publishing sends it (a configuration set) and `notificationType` in the older
/// identity notifications; both are read. Unknown members are ignored, as AWS asks.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SesEvent {
    event_type: Option<String>,
    notification_type: Option<String>,
    mail: Option<Mail>,
    bounce: Option<Bounce>,
    complaint: Option<Complaint>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mail {
    message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bounce {
    bounce_type: Option<String>,
    #[serde(default)]
    bounced_recipients: Vec<Recipient>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Complaint {
    #[serde(default)]
    complained_recipients: Vec<Recipient>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recipient {
    email_address: Option<String>,
}

/// What an event asks for.
#[derive(Debug, PartialEq, Eq)]
struct Suppress {
    message_id: String,
    reason: SuppressionReason,
    addresses: Vec<String>,
}

fn plain_address(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let inner = match (trimmed.rfind('<'), trimmed.ends_with('>')) {
        (Some(open), true) => &trimmed[open + 1..trimmed.len() - 1],
        _ => trimmed,
    };
    let ok = !inner.is_empty()
        && inner.len() <= 254
        && inner.contains('@')
        && !inner.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then(|| inner.to_owned())
}

fn recipients(list: &[Recipient]) -> Vec<String> {
    let mut out: Vec<String> = list
        .iter()
        .take(MAX_RECIPIENTS)
        .filter_map(|r| r.email_address.as_deref())
        .filter_map(plain_address)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// What the SES event in `text` asks for, or `None` when it is not a permanent bounce or a
/// complaint (or names no message or no recipient).
fn suppression_of(text: &str) -> Option<Suppress> {
    let event: SesEvent = serde_json::from_str(text).ok()?;
    let kind = event.event_type.or(event.notification_type)?;
    let message_id = event.mail?.message_id?;
    let (reason, addresses) = match kind.as_str() {
        "Bounce" => {
            let bounce = event.bounce?;
            if bounce.bounce_type.as_deref() != Some("Permanent") {
                return None;
            }
            (
                SuppressionReason::Bounced,
                recipients(&bounce.bounced_recipients),
            )
        }
        "Complaint" => (
            SuppressionReason::Complained,
            recipients(&event.complaint?.complained_recipients),
        ),
        _ => return None,
    };
    (!addresses.is_empty() && !message_id.is_empty() && message_id.len() <= 200).then_some(
        Suppress {
            message_id,
            reason,
            addresses,
        },
    )
}

async fn notification(
    state: &SesEventsState,
    message: &SnsMessage,
) -> Result<StatusCode, ApiError> {
    let Some(request) = suppression_of(&message.message) else {
        info!("ses event acknowledged and dropped");
        return Ok(StatusCode::OK);
    };
    let mut lookup = state.db.public().await?;
    let tenant = email::delivery_tenant(&mut lookup, &request.message_id).await?;
    lookup.rollback().await?;
    let Some(tenant) = tenant else {
        // Not a message this system recorded: another application on the account, or one swept.
        info!("ses event names an unknown message");
        return Ok(StatusCode::OK);
    };
    let mut tx = state.db.tenant(tenant).await?;
    for address in &request.addresses {
        email::suppress(&mut tx, address, request.reason).await?;
    }
    audit::append(
        &mut tx,
        &NewEntry {
            actor_kind: ActorKind::System,
            actor_id: Some("ses-event".to_owned()),
            action: "email.suppressed".to_owned(),
            subject_type: "tenant".to_owned(),
            subject_id: tenant.as_uuid(),
            data: json!({
                "reason": match request.reason {
                    SuppressionReason::Bounced => "bounced",
                    _ => "complained",
                },
                "recipients": request.addresses.len(),
            }),
        },
    )
    .await?;
    tx.commit().await?;
    info!(
        recipients = request.addresses.len(),
        "ses event recorded on the suppression list"
    );
    Ok(StatusCode::OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_topic_arn_names_a_region_and_nothing_odd() {
        let topic = SnsTopic::parse("arn:aws:sns:eu-west-1:123456789012:rampsmith-ses-events");
        assert_eq!(topic.as_ref().map(|t| t.region.as_str()), Ok("eu-west-1"));
        for bad in [
            "",
            "arn:aws:sqs:eu-west-1:123456789012:q",
            "arn:aws-cn:sns:cn-north-1:123456789012:t",
            "arn:aws:sns:eu-west-1:12345:t",
            "arn:aws:sns:EU:123456789012:t",
            "arn:aws:sns:eu-west-1:123456789012:t:extra",
            "arn:aws:sns:eu-west-1:123456789012:",
            "arn:aws:sns::123456789012:t",
        ] {
            assert_eq!(SnsTopic::parse(bad), Err(TopicError), "{bad:?}");
        }
    }

    #[test]
    fn only_a_certificate_on_the_topics_regional_sns_host_is_fetched() {
        let topic = SnsTopic::parse("arn:aws:sns:eu-west-1:123456789012:t").unwrap_or_else(|_| {
            unreachable!("the topic is valid");
        });
        let ok =
            "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0000000000000000.pem";
        assert!(certificate_url(&topic, ok).is_some());
        for bad in [
            "http://sns.eu-west-1.amazonaws.com/a.pem",
            "https://sns.us-east-1.amazonaws.com/a.pem",
            "https://sns.eu-west-1.amazonaws.com.evil.example/a.pem",
            "https://evil.example/sns.eu-west-1.amazonaws.com/a.pem",
            "https://sns.eu-west-1.amazonaws.com:8443/a.pem",
            "https://user@sns.eu-west-1.amazonaws.com/a.pem",
            "https://sns.eu-west-1.amazonaws.com/a.pem?x=1",
            "https://sns.eu-west-1.amazonaws.com/a.pem#x",
            "https://sns.eu-west-1.amazonaws.com/a.crt",
            "https://s3.eu-west-1.amazonaws.com/bucket/a.pem",
            "not a url",
            "",
        ] {
            assert!(certificate_url(&topic, bad).is_none(), "{bad:?}");
        }
    }

    fn sample(kind: &str) -> SnsMessage {
        SnsMessage {
            r#type: kind.to_owned(),
            message_id: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324".to_owned(),
            topic_arn: "arn:aws:sns:eu-west-1:123456789012:t".to_owned(),
            message: "hello".to_owned(),
            subject: None,
            timestamp: "2012-05-02T00:54:06.655Z".to_owned(),
            signature: String::new(),
            signature_version: "2".to_owned(),
            signing_cert_url: String::new(),
            subscribe_url: Some(
                "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription".to_owned(),
            ),
            token: Some("2336412f37".to_owned()),
        }
    }

    #[test]
    fn the_string_to_sign_follows_the_documented_fields_and_order() {
        assert_eq!(
            string_to_sign(&sample("Notification")).as_deref(),
            Some(
                "Message\nhello\nMessageId\n22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324\n\
                 Timestamp\n2012-05-02T00:54:06.655Z\n\
                 TopicArn\narn:aws:sns:eu-west-1:123456789012:t\nType\nNotification\n"
            )
        );
        let mut with_subject = sample("Notification");
        with_subject.subject = Some("Hi".to_owned());
        let text = string_to_sign(&with_subject).unwrap_or_default();
        assert!(
            text.contains(
                "MessageId\n22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324\nSubject\nHi\nTimestamp"
            ),
            "{text:?}"
        );
        let text = string_to_sign(&sample("SubscriptionConfirmation")).unwrap_or_default();
        assert_eq!(
            text.lines().step_by(2).collect::<Vec<_>>(),
            [
                "Message",
                "MessageId",
                "SubscribeURL",
                "Timestamp",
                "Token",
                "TopicArn",
                "Type"
            ]
        );
        let mut missing = sample("SubscriptionConfirmation");
        missing.token = None;
        assert!(string_to_sign(&missing).is_none());
    }

    #[test]
    fn a_permanent_bounce_and_a_complaint_ask_for_suppression_in_either_event_shape() {
        let bounce = |key: &str, kind: &str| {
            format!(
                r#"{{"{key}":"Bounce","bounce":{{"bounceType":"{kind}","bounceSubType":"General",
                "bouncedRecipients":[{{"emailAddress":"A@Shop.example","action":"failed"}},
                {{"emailAddress":"Name <b@shop.example>"}}]}},"mail":{{"messageId":"0102-abc"}}}}"#
            )
        };
        for key in ["eventType", "notificationType"] {
            let got = suppression_of(&bounce(key, "Permanent"));
            assert_eq!(
                got,
                Some(Suppress {
                    message_id: "0102-abc".to_owned(),
                    reason: SuppressionReason::Bounced,
                    addresses: vec!["A@Shop.example".to_owned(), "b@shop.example".to_owned()],
                })
            );
            assert_eq!(suppression_of(&bounce(key, "Transient")), None, "{key}");
            assert_eq!(suppression_of(&bounce(key, "Undetermined")), None, "{key}");
        }
        let complaint = r#"{"eventType":"Complaint","complaint":{"complainedRecipients":
            [{"emailAddress":"c@shop.example"}],"complaintFeedbackType":"abuse"},
            "mail":{"messageId":"0102-def"}}"#;
        assert_eq!(
            suppression_of(complaint).map(|s| (s.reason, s.addresses)),
            Some((
                SuppressionReason::Complained,
                vec!["c@shop.example".to_owned()]
            ))
        );
    }

    #[test]
    fn other_events_and_unusable_ones_ask_for_nothing() {
        for text in [
            r#"{"eventType":"Delivery","delivery":{"recipients":["a@b.example"]},"mail":{"messageId":"x"}}"#,
            r#"{"eventType":"Send","mail":{"messageId":"x"}}"#,
            r#"{"eventType":"Reject","reject":{"reason":"Bad content"},"mail":{"messageId":"x"}}"#,
            r#"{"eventType":"Bounce","bounce":{"bounceType":"Permanent","bouncedRecipients":[]},"mail":{"messageId":"x"}}"#,
            r#"{"eventType":"Bounce","bounce":{"bounceType":"Permanent","bouncedRecipients":[{"emailAddress":"not an address"}]},"mail":{"messageId":"x"}}"#,
            r#"{"eventType":"Bounce","bounce":{"bounceType":"Permanent","bouncedRecipients":[{"emailAddress":"a@b.example"}]},"mail":{}}"#,
            r#"{"Bounce":true}"#,
            "not json",
            "",
        ] {
            assert_eq!(suppression_of(text), None, "{text}");
        }
    }
}
