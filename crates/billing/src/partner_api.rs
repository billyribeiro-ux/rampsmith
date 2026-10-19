//! The Shopify Partner API's `activeSubscription` query: how Rampsmith learns a shop's
//! Shopify App Pricing plan (ADR-131).
//!
//! Sources, read on 2026-10-17:
//! - <https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing> (query and redirect parameters)
//! - <https://shopify.dev/docs/api/partner/latest/active-subscription> (fields, nulls, errors)
//! - <https://shopify.dev/docs/api/partner/2026-10> (endpoint, header, rate limit, status codes)
//!
//! This module builds the request and parses the response; it performs no I/O. The binary
//! that wires billing in implements [`PartnerTransport`] with its HTTP client.

use std::future::Future;

use secrecy::SecretString;
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::money::{Currency, Money};
use crate::plan::BillingInterval;
use crate::shopify::{AppGid, PartnerOrganizationId, ShopGid};

/// The Partner API version Rampsmith pins: the latest stable version on 2026-10-17.
pub const PARTNER_API_VERSION: &str = "2026-10";

/// The header that carries the Partner API client's access token.
pub const ACCESS_TOKEN_HEADER: &str = "X-Shopify-Access-Token";

/// Requests per second allowed per Partner API client, across every shop in the
/// organization. The caller's rate limiter must stay under it.
pub const MAX_REQUESTS_PER_SECOND: u32 = 4;

/// The operation document. Field names are exactly those in Shopify's documented query; it
/// selects only what plan state needs (no discounts, usage or legacy IDs).
pub const ACTIVE_SUBSCRIPTION_QUERY: &str = "\
query ActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    shop {
      id
    }
    billingPeriod
    cancelAtEndOfCycle
    trialEndsAt
    currentBillingCycle {
      startTime
      endTime
    }
    items {
      handle
      price {
        __typename
        active
        currency
        ... on FlatRatePrice {
          amount
        }
      }
    }
    pendingUpdate {
      billingPeriod
      items {
        handle
      }
    }
  }
}
";

/// The GraphQL endpoint for an organization:
/// `https://partners.shopify.com/{org_id}/api/2026-10/graphql.json`.
#[must_use]
pub fn endpoint(organization: PartnerOrganizationId) -> String {
    format!("https://partners.shopify.com/{organization}/api/{PARTNER_API_VERSION}/graphql.json")
}

/// A Partner API client's credentials: the organization and its access token
/// (`SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN`). The token is a [`SecretString`],
/// so `Debug` prints `[REDACTED]` and it never reaches an error or a log line.
#[derive(Debug, Clone)]
pub struct PartnerCredentials {
    /// The organization that owns the app.
    pub organization: PartnerOrganizationId,
    /// The API client's access token; needs the "Manage apps" permission.
    pub access_token: SecretString,
}

/// One HTTP request for the transport to send: `POST url` with
/// `Content-Type: application/json`, the [`ACCESS_TOKEN_HEADER`] set from `access_token`, and
/// `body`.
#[derive(Debug, Clone)]
pub struct PartnerRequest {
    /// The endpoint URL.
    pub url: String,
    /// The token for [`ACCESS_TOKEN_HEADER`]. Expose it only when setting the header.
    pub access_token: SecretString,
    /// The JSON body: the query document and its variables.
    pub body: String,
}

/// What the transport got back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartnerResponse {
    /// The HTTP status code.
    pub status: u16,
    /// The response body.
    pub body: String,
}

/// The transport failed before an HTTP response arrived (timeout, DNS, TLS, connection).
/// Implementations must not put the request's token in it.
#[derive(Debug, thiserror::Error)]
#[error("the Partner API could not be reached")]
pub struct TransportError(#[source] pub Box<dyn std::error::Error + Send + Sync>);

/// Sends Partner API requests. The `api` and `ctl` binaries implement it with their HTTP
/// client; tests use a fake.
pub trait PartnerTransport {
    /// Sends one request.
    fn send(
        &self,
        request: PartnerRequest,
    ) -> impl Future<Output = Result<PartnerResponse, TransportError>> + Send;
}

/// The Partner API did not produce a usable answer. None of these carry the access token.
#[derive(Debug, thiserror::Error)]
pub enum PartnerApiError {
    /// No HTTP response arrived.
    #[error(transparent)]
    Transport(#[from] TransportError),
    /// HTTP 401: the API client is invalid or the organization is disabled.
    #[error("the Partner API rejected the client credentials")]
    Unauthorized,
    /// HTTP 429, or a `Too many requests` error: over four requests per second.
    #[error("the Partner API rate limit was exceeded")]
    Throttled,
    /// HTTP 5xx.
    #[error("the Partner API failed with HTTP {0}")]
    Unavailable(u16),
    /// Any other non-success HTTP status.
    #[error("the Partner API answered with unexpected HTTP status {0}")]
    UnexpectedStatus(u16),
    /// The app is not a public app, so it has no App Pricing subscriptions to read.
    #[error("only public apps can access active subscriptions")]
    NotPublicApp,
    /// The Partner API does not know the shop ID.
    #[error("the Partner API does not know this shop")]
    ShopNotFound,
    /// Other GraphQL errors, by message.
    #[error("the Partner API returned errors: {0:?}")]
    Graphql(Vec<String>),
    /// The body is not the documented shape.
    #[error("the Partner API response is malformed: {0}")]
    Malformed(String),
    /// The subscription belongs to a different shop than the one asked about.
    #[error("asked about {asked} but the Partner API answered for {answered}")]
    ShopMismatch {
        /// The shop in the request.
        asked: ShopGid,
        /// The shop ID in the response.
        answered: String,
    },
}

impl PartnerApiError {
    /// Whether retrying later may succeed without anyone changing configuration.
    #[must_use]
    pub const fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::Transport(_) | Self::Throttled | Self::Unavailable(_)
        )
    }
}

/// A shop's active App Pricing subscription, as typed values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveSubscription {
    /// How often the shop is billed.
    pub billing_period: BillingInterval,
    /// Whether the subscription ends at the end of the current cycle (for example, a
    /// downgrade to a free plan).
    pub cancel_at_end_of_cycle: bool,
    /// When the trial ends; `None` when no trial is active.
    pub trial_ends_at: Option<OffsetDateTime>,
    /// The current billing cycle; `None` during a trial.
    pub current_billing_cycle: Option<BillingCycle>,
    /// The subscription's items; the plan item's `handle` is the plan handle.
    pub items: Vec<SubscriptionItem>,
    /// What applies from the next cycle, if a change is scheduled.
    pub pending_update: Option<PendingUpdate>,
}

impl ActiveSubscription {
    /// The handles of every item.
    pub fn item_handles(&self) -> impl Iterator<Item = &str> {
        self.items.iter().map(|item| item.handle.as_str())
    }
}

/// A billing cycle, `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BillingCycle {
    /// When the cycle started.
    pub start: OffsetDateTime,
    /// When the cycle ends.
    pub end: OffsetDateTime,
}

/// One subscription item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionItem {
    /// The item's handle: for a plan, the plan handle set in the Partner Dashboard.
    pub handle: String,
    /// The item's price, when Shopify returned one.
    pub price: Option<ItemPrice>,
}

/// An item's price.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemPrice {
    /// A fixed recurring price (`FlatRatePrice`).
    FlatRate {
        /// The amount billed each cycle.
        amount: Money,
        /// Whether this price is still in effect.
        active: bool,
    },
    /// Any other price type, such as `TieredPrice` for usage, kept without its tiers.
    Other {
        /// The GraphQL type name.
        typename: String,
        /// The price's currency.
        currency: Currency,
        /// Whether this price is still in effect.
        active: bool,
    },
}

/// A scheduled change that applies from the next billing cycle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingUpdate {
    /// The billing period from the next cycle.
    pub billing_period: BillingInterval,
    /// The item handles from the next cycle.
    pub item_handles: Vec<String>,
}

/// Builds the `activeSubscription` request for one shop.
#[must_use]
pub fn active_subscription_request(
    credentials: &PartnerCredentials,
    app: AppGid,
    shop: ShopGid,
) -> PartnerRequest {
    let body = serde_json::json!({
        "query": ACTIVE_SUBSCRIPTION_QUERY,
        "variables": { "appId": app.to_string(), "shopId": shop.to_string() },
    });
    PartnerRequest {
        url: endpoint(credentials.organization),
        access_token: credentials.access_token.clone(),
        body: body.to_string(),
    }
}

#[derive(Deserialize)]
struct Envelope {
    data: Option<Data>,
    errors: Option<Vec<GraphqlError>>,
}

#[derive(Deserialize)]
struct GraphqlError {
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    active_subscription: Option<RawSubscription>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSubscription {
    shop: Option<RawShop>,
    billing_period: String,
    cancel_at_end_of_cycle: bool,
    trial_ends_at: Option<String>,
    current_billing_cycle: Option<RawCycle>,
    items: Vec<RawItem>,
    pending_update: Option<RawPending>,
}

#[derive(Deserialize)]
struct RawShop {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCycle {
    start_time: String,
    end_time: String,
}

#[derive(Deserialize)]
struct RawItem {
    handle: String,
    price: Option<RawPrice>,
}

#[derive(Deserialize)]
struct RawPrice {
    #[serde(rename = "__typename")]
    typename: String,
    active: bool,
    currency: String,
    amount: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPending {
    billing_period: String,
    items: Vec<RawHandle>,
}

#[derive(Deserialize)]
struct RawHandle {
    handle: String,
}

const NOT_PUBLIC_APP: &str = "Only public apps can access active subscription";
const SHOP_NOT_FOUND: &str = "Shop not found";
const TOO_MANY_REQUESTS: &str = "Too many requests";

/// Parses the response to [`active_subscription_request`] for `asked`. `Ok(None)` means the
/// shop has no active App Pricing subscription.
pub fn parse_active_subscription(
    response: &PartnerResponse,
    asked: ShopGid,
) -> Result<Option<ActiveSubscription>, PartnerApiError> {
    match response.status {
        200..=299 => {}
        401 => return Err(PartnerApiError::Unauthorized),
        429 => return Err(PartnerApiError::Throttled),
        500..=599 => return Err(PartnerApiError::Unavailable(response.status)),
        other => return Err(PartnerApiError::UnexpectedStatus(other)),
    }
    let envelope: Envelope = serde_json::from_str(&response.body)
        .map_err(|error| PartnerApiError::Malformed(error.to_string()))?;

    if let Some(errors) = envelope.errors.filter(|errors| !errors.is_empty()) {
        let messages: Vec<String> = errors.into_iter().map(|error| error.message).collect();
        let has = |text: &str| messages.iter().any(|message| message.starts_with(text));
        return Err(if has(TOO_MANY_REQUESTS) {
            PartnerApiError::Throttled
        } else if has(NOT_PUBLIC_APP) {
            PartnerApiError::NotPublicApp
        } else if has(SHOP_NOT_FOUND) {
            PartnerApiError::ShopNotFound
        } else {
            PartnerApiError::Graphql(messages)
        });
    }

    let data = envelope
        .data
        .ok_or_else(|| PartnerApiError::Malformed("neither data nor errors".to_owned()))?;
    data.active_subscription
        .map(|raw| convert(raw, asked))
        .transpose()
}

fn malformed(what: impl std::fmt::Display) -> PartnerApiError {
    PartnerApiError::Malformed(what.to_string())
}

fn interval(value: &str) -> Result<BillingInterval, PartnerApiError> {
    BillingInterval::from_partner_api_value(value)
        .ok_or_else(|| malformed(format!("unknown billingPeriod {value:?}")))
}

fn instant(field: &str, value: &str) -> Result<OffsetDateTime, PartnerApiError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|error| malformed(format!("{field} {value:?}: {error}")))
}

fn convert(raw: RawSubscription, asked: ShopGid) -> Result<ActiveSubscription, PartnerApiError> {
    if let Some(shop) = raw.shop
        && ShopGid::parse(&shop.id).ok() != Some(asked)
    {
        return Err(PartnerApiError::ShopMismatch {
            asked,
            answered: shop.id,
        });
    }
    let current_billing_cycle = raw
        .current_billing_cycle
        .map(|cycle| {
            Ok::<_, PartnerApiError>(BillingCycle {
                start: instant("currentBillingCycle.startTime", &cycle.start_time)?,
                end: instant("currentBillingCycle.endTime", &cycle.end_time)?,
            })
        })
        .transpose()?;
    let items = raw
        .items
        .into_iter()
        .map(|item| {
            Ok(SubscriptionItem {
                handle: item.handle,
                price: item.price.map(convert_price).transpose()?,
            })
        })
        .collect::<Result<Vec<_>, PartnerApiError>>()?;
    let pending_update = raw
        .pending_update
        .map(|pending| {
            Ok::<_, PartnerApiError>(PendingUpdate {
                billing_period: interval(&pending.billing_period)?,
                item_handles: pending.items.into_iter().map(|item| item.handle).collect(),
            })
        })
        .transpose()?;
    Ok(ActiveSubscription {
        billing_period: interval(&raw.billing_period)?,
        cancel_at_end_of_cycle: raw.cancel_at_end_of_cycle,
        trial_ends_at: raw
            .trial_ends_at
            .map(|value| instant("trialEndsAt", &value))
            .transpose()?,
        current_billing_cycle,
        items,
        pending_update,
    })
}

fn convert_price(raw: RawPrice) -> Result<ItemPrice, PartnerApiError> {
    let currency = Currency::new(&raw.currency).map_err(malformed)?;
    if raw.typename != "FlatRatePrice" {
        return Ok(ItemPrice::Other {
            typename: raw.typename,
            currency,
            active: raw.active,
        });
    }
    // Shopify serializes `Decimal` as a string; accept a JSON number too.
    let text = match raw.amount {
        Some(serde_json::Value::String(text)) => text,
        Some(serde_json::Value::Number(number)) => number.to_string(),
        other => return Err(malformed(format!("FlatRatePrice.amount {other:?}"))),
    };
    Ok(ItemPrice::FlatRate {
        amount: Money::parse_decimal(&text, currency).map_err(malformed)?,
        active: raw.active,
    })
}

/// A Partner API client for plan state: credentials, the app's ID and a transport.
#[derive(Debug)]
pub struct PartnerApiClient<T> {
    transport: T,
    credentials: PartnerCredentials,
    app: AppGid,
}

impl<T: PartnerTransport> PartnerApiClient<T> {
    /// A client for `app` (`SHOPIFY_APP_GID`) using `credentials` over `transport`.
    #[must_use]
    pub const fn new(transport: T, credentials: PartnerCredentials, app: AppGid) -> Self {
        Self {
            transport,
            credentials,
            app,
        }
    }

    /// The shop's active App Pricing subscription, or `None` when it has none.
    pub async fn active_subscription(
        &self,
        shop: ShopGid,
    ) -> Result<Option<ActiveSubscription>, PartnerApiError> {
        let request = active_subscription_request(&self.credentials, self.app, shop);
        let response = self.transport.send(request).await?;
        parse_active_subscription(&response, shop)
    }
}
