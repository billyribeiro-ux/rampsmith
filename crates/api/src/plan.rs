//! Confirming a shop's plan with Shopify's Partner API, fairly (ADR-084, audit M3).
//!
//! The Partner API allows 4 requests per second per client (ADR-132). The rules here keep the
//! app well under it and keep a request from anyone but Shopify out of the decision:
//!
//! - **No `plan_handle` input.** No route reads the redirect parameter, so nothing a visitor
//!   types can start a call or grant a plan. The stored plan changes only from a Partner API
//!   answer, through `billing::reconcile`.
//! - **Per-shop decision.** `billing::sweep::on_app_load` says whether the stored state is
//!   fresh enough (5 minutes) or a boundary passed; a shop that needs no check costs nothing.
//! - **Single flight.** One call per shop at a time; a second app load meanwhile uses the
//!   stored plan.
//! - **Global pacing.** Calls are spaced at least 334 ms apart across all shops (3 a second),
//!   and a caller that would wait over 2 seconds uses the stored plan instead of queueing.
//! - **Failures back off** through the stored `consecutive_failures` and `last_attempt_at`
//!   (`billing::sweep::retry_delay`), and the stored plan stays in force meanwhile.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use billing::partner_api::{
    ACCESS_TOKEN_HEADER, PartnerApiClient, PartnerCredentials, PartnerRequest, PartnerResponse,
    PartnerTransport, TransportError,
};
use billing::reconcile::{ApiAnswer, RedirectParam, reconcile};
use billing::stored::{state_of, stored_of};
use billing::sweep::{Decision, on_app_load};
use billing::{AppGid, ShopGid};
use db::repo::{audit, shop_billing, shopify as shops};
use db::{Db, DbError};
use domain::{ActorKind, ShopId, TenantId};
use secrecy::ExposeSecret;
use serde_json::json;
use time::OffsetDateTime;
use tokio::time::Instant;

/// Calls are at least this far apart: 3 a second, under the 4 a second limit.
const SPACING: Duration = Duration::from_millis(334);
/// A caller that would wait longer than this uses the stored plan.
const MAX_WAIT: Duration = Duration::from_secs(2);
/// One Partner API call may take this long.
const CALL_TIMEOUT: Duration = Duration::from_secs(5);

/// Sends Partner API requests over HTTPS. Tests may point it at another host.
#[derive(Debug, Clone)]
pub struct HttpTransport {
    http: reqwest::Client,
    base: Option<url::Url>,
}

impl PartnerTransport for HttpTransport {
    async fn send(&self, request: PartnerRequest) -> Result<PartnerResponse, TransportError> {
        let mut target = url::Url::parse(&request.url).map_err(|e| TransportError(Box::new(e)))?;
        if let Some(base) = &self.base {
            // Keep the path (it names the organization); use the test host.
            let _ = target.set_scheme(base.scheme());
            let _ = target.set_host(base.host_str());
            let _ = target.set_port(base.port());
        }
        let response = self
            .http
            .post(target)
            .header(ACCESS_TOKEN_HEADER, request.access_token.expose_secret())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(request.body)
            .send()
            .await
            .map_err(|e| TransportError(Box::new(e.without_url())))?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .map_err(|e| TransportError(Box::new(e.without_url())))?;
        Ok(PartnerResponse { status, body })
    }
}

/// Spaces calls across all shops.
#[derive(Debug)]
struct Pacer {
    next: tokio::sync::Mutex<Instant>,
}

impl Pacer {
    /// Waits for a slot. `false` when the wait would pass [`MAX_WAIT`].
    async fn slot(&self) -> bool {
        let at = {
            let mut next = self.next.lock().await;
            let now = Instant::now();
            let at = (*next).max(now);
            if at - now > MAX_WAIT {
                return false;
            }
            *next = at + SPACING;
            at
        };
        tokio::time::sleep_until(at).await;
        true
    }
}

#[derive(Debug)]
struct Inner {
    client: PartnerApiClient<HttpTransport>,
    pacer: Pacer,
    in_flight: Mutex<HashSet<ShopId>>,
}

/// Holds a shop's single-flight place until dropped.
struct Flight<'a> {
    set: &'a Mutex<HashSet<ShopId>>,
    shop: ShopId,
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.shop);
        }
    }
}

/// Confirms plans with the Partner API. Without it the app serves the stored plan (Free until
/// one is stored).
#[derive(Debug, Clone)]
pub struct PartnerPlans {
    inner: Arc<Inner>,
}

impl PartnerPlans {
    /// A client for `app` using `credentials`. `base` replaces the Partner API's scheme, host
    /// and port, for tests.
    ///
    /// # Panics
    ///
    /// Never in practice: building the HTTP client with a timeout cannot fail.
    #[must_use]
    pub fn new(credentials: PartnerCredentials, app: AppGid, base: Option<url::Url>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(CALL_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            inner: Arc::new(Inner {
                client: PartnerApiClient::new(HttpTransport { http, base }, credentials, app),
                pacer: Pacer {
                    next: tokio::sync::Mutex::new(Instant::now()),
                },
                in_flight: Mutex::new(HashSet::new()),
            }),
        }
    }

    /// The shop's active subscription, straight from the Partner API (no pacing, no storage).
    /// For the live check of LAUNCH.md section E; the routes go through [`Self::refresh`].
    pub async fn active_subscription(
        &self,
        shop: ShopGid,
    ) -> Result<
        Option<billing::partner_api::ActiveSubscription>,
        billing::partner_api::PartnerApiError,
    > {
        self.inner.client.active_subscription(shop).await
    }

    fn enter(&self, shop: ShopId) -> Option<Flight<'_>> {
        let mut set = self.inner.in_flight.lock().ok()?;
        // Built only when the shop was not already in flight: a `Flight` that is built and
        // dropped removes the shop again.
        set.insert(shop).then(|| Flight {
            set: &self.inner.in_flight,
            shop,
        })
    }

    /// Asks Shopify about the shop's plan when the stored state needs it, and stores the
    /// reconciled answer. A refusal to ask (fresh state, a call in flight, pacing) and a
    /// failed call both leave the stored plan in force.
    pub async fn refresh(
        &self,
        db: &Db,
        tenant: TenantId,
        shop: ShopId,
        now: OffsetDateTime,
    ) -> Result<(), DbError> {
        let (stored, gid) = {
            let mut tx = db.tenant(tenant).await?;
            let stored = shop_billing::get(&mut tx, shop).await?;
            let gid = shops::shop_gid(&mut tx, shop).await?;
            (stored, gid)
        };
        let state = state_of(stored.as_ref());
        if matches!(
            on_app_load(&state, &RedirectParam::Absent, now),
            Decision::UseStored { .. }
        ) {
            return Ok(());
        }
        let Some(gid) = gid.and_then(|text| ShopGid::parse(&text).ok()) else {
            // The first store read has not recorded Shopify's id for the shop yet.
            return Ok(());
        };
        let Some(_flight) = self.enter(shop) else {
            return Ok(());
        };
        if !self.inner.pacer.slot().await {
            tracing::warn!("plan check skipped: the Partner API pacing queue is full");
            return Ok(());
        }
        let result = self.inner.client.active_subscription(gid).await;
        if let Err(error) = &result {
            tracing::warn!(%error, "Partner API plan check failed; the stored plan stays");
        }
        let mut tx = db.tenant(tenant).await?;
        let latest = state_of(shop_billing::get(&mut tx, shop).await?.as_ref());
        let outcome = reconcile(
            &latest,
            &RedirectParam::Absent,
            ApiAnswer::from_result(&result),
            now,
        );
        shop_billing::put(&mut tx, shop, &stored_of(&outcome.state)).await?;
        for event in &outcome.events {
            audit::append(
                &mut tx,
                &audit::NewEntry {
                    actor_kind: ActorKind::System,
                    actor_id: None,
                    action: "billing.event".to_owned(),
                    subject_type: "shop".to_owned(),
                    subject_id: shop.as_uuid(),
                    data: json!({"event": format!("{event:?}")}),
                },
            )
            .await?;
        }
        tx.commit().await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use secrecy::SecretString;

    use super::*;

    fn plans() -> PartnerPlans {
        PartnerPlans::new(
            PartnerCredentials {
                organization: billing::PartnerOrganizationId::parse("1")
                    .unwrap_or_else(|_| unreachable!("1 is an organization id")),
                access_token: SecretString::from("t"),
            },
            AppGid::parse("gid://shopify/App/1").unwrap_or_else(|_| unreachable!("an app gid")),
            None,
        )
    }

    #[test]
    fn one_shop_has_one_call_in_flight() {
        let plans = plans();
        let shop = ShopId::new();
        let first = plans.enter(shop);
        assert!(first.is_some());
        assert!(
            plans.enter(shop).is_none(),
            "a second load uses the stored plan"
        );
        assert!(
            plans.enter(ShopId::new()).is_some(),
            "another shop is independent"
        );
        drop(first);
        assert!(plans.enter(shop).is_some(), "the place is free again");
    }

    /// Twelve shops load at once: calls are spaced 334 ms apart, which is 3 a second, and the
    /// ones that would wait over 2 seconds use their stored plan instead of queueing.
    #[tokio::test(start_paused = true)]
    async fn calls_are_paced_under_the_partner_limit_and_a_long_queue_is_refused() {
        let pacer = Arc::new(Pacer {
            next: tokio::sync::Mutex::new(Instant::now()),
        });
        let tasks: Vec<_> = (0..12)
            .map(|_| {
                let pacer = Arc::clone(&pacer);
                tokio::spawn(async move { pacer.slot().await.then(Instant::now) })
            })
            .collect();
        let mut times = Vec::new();
        let mut refused = 0;
        for task in tasks {
            match task.await.unwrap_or(None) {
                Some(at) => times.push(at),
                None => refused += 1,
            }
        }
        times.sort();
        assert_eq!(
            times.len(),
            6,
            "slots at 0, 334, ... 1670 ms; the rest would wait over 2 s"
        );
        assert_eq!(refused, 6);
        for pair in times.windows(2) {
            assert!(pair[1] - pair[0] >= SPACING);
        }
        let per_second = times
            .iter()
            .filter(|at| **at - times[0] < Duration::from_secs(1))
            .count();
        assert!(
            per_second <= 3,
            "at most 3 calls in any second, saw {per_second}"
        );
        assert!(per_second < billing::partner_api::MAX_REQUESTS_PER_SECOND as usize);
    }
}
