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
//! - **A plan checked recently is not asked again.** A "no plan" answer is cached for two
//!   minutes and a `plan_handle` redirect (which no route reads today) could only check sooner,
//!   never more often than every 15 seconds, so one shop reloading in a loop cannot spend the
//!   organization's budget (lane A audit M3, ADR-087).
//! - **A share per shop.** One shop gets at most 3 calls a minute, whatever its stored state
//!   says; the rest of the pacer belongs to the other shops.
//! - **Single flight.** One call per shop at a time; a second app load meanwhile uses the
//!   stored plan.
//! - **Global pacing.** Calls are spaced at least 334 ms apart across all shops (3 a second),
//!   and a caller that would wait over 2 seconds uses the stored plan instead of queueing.
//! - **Failures back off** through the stored `consecutive_failures` and `last_attempt_at`
//!   (`billing::sweep::retry_delay`), and the stored plan stays in force meanwhile.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use billing::entitlements::Entitlements;
use billing::partner_api::{
    ACCESS_TOKEN_HEADER, PartnerApiClient, PartnerCredentials, PartnerRequest, PartnerResponse,
    PartnerTransport, TransportError,
};
use billing::reconcile::{ApiAnswer, RedirectParam, reconcile};
use billing::stored::{entitlements_of, state_of, stored_of};
use billing::sweep::{Decision, on_app_load};
use billing::{AppGid, ShopGid};
use db::TenantTx;
use db::repo::{app_views, audit, shop_billing, shopify as shops};
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
/// One shop may start at most [`SHOP_CALLS`] calls in any window of this length.
const SHOP_WINDOW: Duration = Duration::from_secs(60);
/// The calls one shop may start per [`SHOP_WINDOW`]: with 180 pacer slots a minute, no shop can
/// hold more than a fiftieth of them.
const SHOP_CALLS: usize = 3;

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

/// Caps each shop's share of the pacer.
#[derive(Debug, Default)]
struct ShopShare {
    calls: Mutex<HashMap<ShopId, VecDeque<Instant>>>,
}

impl ShopShare {
    /// Records a call for `shop` and returns `true`, or returns `false` when the shop already
    /// started [`SHOP_CALLS`] within [`SHOP_WINDOW`].
    fn take(&self, shop: ShopId) -> bool {
        let Ok(mut calls) = self.calls.lock() else {
            return false;
        };
        let now = Instant::now();
        // Forget shops whose calls have all aged out, so the map stays as small as the number
        // of shops active in the last minute.
        calls.retain(|_, started| {
            while started
                .front()
                .is_some_and(|at| now.duration_since(*at) >= SHOP_WINDOW)
            {
                started.pop_front();
            }
            !started.is_empty()
        });
        let started = calls.entry(shop).or_default();
        if started.len() >= SHOP_CALLS {
            return false;
        }
        started.push_back(now);
        true
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
    share: ShopShare,
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
    /// The client follows no redirect, speaks HTTPS only (unless `base` points a test at a
    /// plain-HTTP host) and carries a timeout. Building it can fail, and then the app must not
    /// start with a default client that has none of those (lane A audit L9).
    ///
    /// # Errors
    ///
    /// When the HTTP client cannot be built (for example no usable TLS backend).
    pub fn new(
        credentials: PartnerCredentials,
        app: AppGid,
        base: Option<url::Url>,
    ) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .timeout(CALL_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .https_only(base.is_none())
            .build()?;
        Ok(Self {
            inner: Arc::new(Inner {
                client: PartnerApiClient::new(HttpTransport { http, base }, credentials, app),
                pacer: Pacer {
                    next: tokio::sync::Mutex::new(Instant::now()),
                },
                share: ShopShare::default(),
                in_flight: Mutex::new(HashSet::new()),
            }),
        })
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
        if !self.inner.share.take(shop) {
            tracing::warn!("plan check skipped: the shop used its share of Partner API calls");
            return Ok(());
        }
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
        // A plan that changed takes the merchant's own AI budget down to the new ceiling in the
        // same transaction, so a downgrade cannot leave a budget the new plan never granted
        // (lane A audit M4, ADR-087). A raise leaves the merchant's choice alone.
        let (before, after) = (entitlements_of(&latest), entitlements_of(&outcome.state));
        if before.plan() != after.plan() {
            lower_ai_budget(&mut tx, shop, &after).await?;
        }
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

/// Lowers the site's stored AI budget to `granted`'s ceiling when it is above it.
async fn lower_ai_budget(
    tx: &mut TenantTx,
    shop: ShopId,
    granted: &Entitlements,
) -> Result<(), DbError> {
    let Some(site) = app_views::site_of_shop(tx, shop).await? else {
        return Ok(());
    };
    let ceiling = i64::try_from(granted.ai_budget_micro_usd()).unwrap_or(i64::MAX);
    let stored = app_views::settings(tx, site)
        .await?
        .and_then(|(document, _)| {
            document
                .get("ai_budget_micro_usd")
                .and_then(serde_json::Value::as_i64)
        });
    if stored.is_some_and(|budget| budget > ceiling) {
        app_views::merge_settings(tx, site, &json!({"ai_budget_micro_usd": ceiling})).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use secrecy::SecretString;

    use super::*;

    fn plans() -> PartnerPlans {
        let built = PartnerPlans::new(
            PartnerCredentials {
                organization: billing::PartnerOrganizationId::parse("1")
                    .unwrap_or_else(|_| unreachable!("1 is an organization id")),
                access_token: SecretString::from("t"),
            },
            AppGid::parse("gid://shopify/App/1").unwrap_or_else(|_| unreachable!("an app gid")),
            None,
        );
        built.unwrap_or_else(|_| unreachable!("the client builds"))
    }

    #[tokio::test(start_paused = true)]
    async fn one_shop_gets_three_calls_a_minute_and_the_others_are_unaffected() {
        let share = ShopShare::default();
        let looping = ShopId::new();
        let neighbour = ShopId::new();
        let granted = (0..1000).filter(|_| share.take(looping)).count();
        assert_eq!(granted, 3, "a looping shop is held to its share");
        assert!(share.take(neighbour), "another shop still gets its calls");
        tokio::time::advance(Duration::from_secs(61)).await;
        assert!(share.take(looping), "the window moves on");
        assert_eq!(
            share.calls.lock().map(|c| c.len()).unwrap_or(0),
            1,
            "the idle neighbour was forgotten"
        );
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
