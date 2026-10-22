//! Cost-aware pacing for one shop (shopify.dev, "GraphQL Admin API rate limits").
//!
//! Shopify gives each app and shop a bucket of query-cost points that refills at a fixed rate.
//! Every response reports it as `extensions.cost.throttleStatus` (`maximumAvailable`,
//! `currentlyAvailable`, `restoreRate`). [`Throttle`] keeps that picture, waits before a call
//! that would overdraw the bucket, and is shared by every call for the shop in the process, so
//! two jobs for one shop cannot both spend the same points. It starts from a standard-plan
//! bucket and corrects itself from the first response.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use shopify::ShopDomain;
use tokio::time::Instant;

/// The bucket before the first response: a standard plan's 1,000 points restoring 50 a second.
const DEFAULT_MAXIMUM: f64 = 1000.0;
const DEFAULT_RESTORE: f64 = 50.0;
/// The single-query ceiling (shopify.dev: "A single query may not exceed a cost of 1,000
/// points").
pub const MAX_QUERY_COST: f64 = 1000.0;
/// Never wait longer than this for the bucket in one pause; the next loop re-checks.
const LONGEST_PAUSE: Duration = Duration::from_secs(30);
/// Shops remembered at once. A process serves few shops at a time; this bounds the map.
const MAX_SHOPS: usize = 4096;

/// `extensions.cost.throttleStatus` as Shopify sends it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleStatus {
    /// The bucket size.
    pub maximum_available: f64,
    /// Points left now.
    pub currently_available: f64,
    /// Points restored per second.
    pub restore_rate: f64,
}

/// `extensions.cost` as Shopify sends it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryCost {
    /// The cost computed before execution, which is what the rate limit charges first.
    pub requested_query_cost: f64,
    /// The cost computed from the results, which Shopify refunds the difference to.
    #[serde(default)]
    pub actual_query_cost: Option<f64>,
    /// The bucket after the call.
    pub throttle_status: ThrottleStatus,
}

#[derive(Debug)]
struct State {
    maximum: f64,
    available: f64,
    restore: f64,
    at: Instant,
    /// The requested cost last reported for each operation, so the next call reserves what the
    /// operation really costs instead of a guess.
    learned: HashMap<&'static str, f64>,
}

impl State {
    fn refilled(&self, now: Instant) -> f64 {
        let seconds = now.saturating_duration_since(self.at).as_secs_f64();
        self.restore
            .mul_add(seconds, self.available)
            .min(self.maximum)
    }
}

/// The bucket of one shop.
#[derive(Debug)]
pub struct Throttle {
    state: Mutex<State>,
}

impl Default for Throttle {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                maximum: DEFAULT_MAXIMUM,
                available: DEFAULT_MAXIMUM,
                restore: DEFAULT_RESTORE,
                at: Instant::now(),
                learned: HashMap::new(),
            }),
        }
    }
}

impl Throttle {
    fn lock(&self) -> MutexGuard<'_, State> {
        // The state is plain numbers; a panic elsewhere leaves it usable.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Waits until the bucket holds the cost of `operation` (`hint` until the operation has
    /// been seen), then spends it. Returns how long it waited in total.
    pub async fn acquire(&self, operation: &'static str, hint: f64) -> Duration {
        let mut waited = Duration::ZERO;
        loop {
            let pause = {
                let mut state = self.lock();
                let cost = state
                    .learned
                    .get(operation)
                    .copied()
                    .unwrap_or(hint)
                    .clamp(1.0, state.maximum.min(MAX_QUERY_COST));
                let now = Instant::now();
                let available = state.refilled(now);
                if available >= cost {
                    state.available = available - cost;
                    state.at = now;
                    return waited;
                }
                let seconds = (cost - available) / state.restore.max(1.0);
                Duration::from_secs_f64(seconds).min(LONGEST_PAUSE)
            };
            tokio::time::sleep(pause).await;
            waited += pause;
        }
    }

    /// Takes in what a response reported about the bucket and the operation's cost.
    pub fn observe(&self, operation: &'static str, cost: &QueryCost) {
        let mut state = self.lock();
        let status = cost.throttle_status;
        if status.maximum_available > 0.0 && status.restore_rate > 0.0 {
            state.maximum = status.maximum_available;
            state.restore = status.restore_rate;
            state.available = status
                .currently_available
                .clamp(0.0, status.maximum_available);
            state.at = Instant::now();
        }
        if cost.requested_query_cost > 0.0 {
            state.learned.insert(operation, cost.requested_query_cost);
        }
    }

    /// Marks the bucket empty after Shopify answered `THROTTLED`, and returns how long to wait
    /// until `operation` fits again.
    pub fn throttled(&self, operation: &'static str, hint: f64) -> Duration {
        let mut state = self.lock();
        let cost = state
            .learned
            .get(operation)
            .copied()
            .unwrap_or(hint)
            .clamp(1.0, state.maximum.min(MAX_QUERY_COST));
        state.available = 0.0;
        state.at = Instant::now();
        Duration::from_secs_f64(cost / state.restore.max(1.0)).min(LONGEST_PAUSE)
    }

    /// Points in the bucket now, for tests and metrics.
    #[must_use]
    pub fn available(&self) -> f64 {
        let state = self.lock();
        state.refilled(Instant::now())
    }
}

/// The buckets of the shops this process talks to.
#[derive(Debug, Clone, Default)]
pub struct Throttles {
    shops: Arc<Mutex<HashMap<ShopDomain, Arc<Throttle>>>>,
}

impl Throttles {
    /// The shared bucket of `shop`, created on first use.
    #[must_use]
    pub fn for_shop(&self, shop: &ShopDomain) -> Arc<Throttle> {
        let mut shops = self.shops.lock().unwrap_or_else(PoisonError::into_inner);
        if shops.len() >= MAX_SHOPS && !shops.contains_key(shop) {
            // Forget the buckets nobody else holds; a forgotten shop starts from the default
            // bucket and corrects itself on its first response.
            shops.retain(|_, bucket| Arc::strong_count(bucket) > 1);
        }
        Arc::clone(shops.entry(shop.clone()).or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cost(requested: f64, available: f64) -> QueryCost {
        QueryCost {
            requested_query_cost: requested,
            actual_query_cost: Some(requested / 2.0),
            throttle_status: ThrottleStatus {
                maximum_available: 1000.0,
                currently_available: available,
                restore_rate: 50.0,
            },
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_bucket_does_not_wait() {
        let throttle = Throttle::default();
        assert_eq!(throttle.acquire("Products", 200.0).await, Duration::ZERO);
        assert!((throttle.available() - 800.0).abs() < 1e-6);
    }

    #[tokio::test(start_paused = true)]
    async fn an_empty_bucket_waits_for_the_points_to_restore() {
        let throttle = Throttle::default();
        throttle.observe("Products", &cost(200.0, 0.0));
        // 200 points at 50 a second: four seconds.
        let waited = throttle.acquire("Products", 1.0).await;
        assert_eq!(waited, Duration::from_secs(4));
    }

    #[tokio::test(start_paused = true)]
    async fn the_bucket_never_refills_past_its_maximum() {
        let throttle = Throttle::default();
        throttle.observe("Shop", &cost(5.0, 900.0));
        tokio::time::sleep(Duration::from_mins(10)).await;
        assert!((throttle.available() - 1000.0).abs() < 1e-6);
    }

    #[tokio::test(start_paused = true)]
    async fn a_learned_cost_replaces_the_hint() {
        let throttle = Throttle::default();
        throttle.observe("Products", &cost(300.0, 1000.0));
        // The hint says 10; the operation really costs 300.
        throttle.acquire("Products", 10.0).await;
        assert!((throttle.available() - 700.0).abs() < 1e-6);
    }

    #[tokio::test(start_paused = true)]
    async fn throttled_empties_the_bucket_and_says_how_long() {
        let throttle = Throttle::default();
        throttle.observe("Products", &cost(100.0, 1000.0));
        let wait = throttle.throttled("Products", 1.0);
        assert_eq!(wait, Duration::from_secs(2));
        assert!(throttle.available() < 1e-6);
    }

    #[tokio::test(start_paused = true)]
    async fn a_cost_above_the_single_query_ceiling_is_clamped_not_waited_on_forever() {
        let throttle = Throttle::default();
        let waited = throttle.acquire("Huge", 5000.0).await;
        assert_eq!(waited, Duration::ZERO);
    }

    #[tokio::test]
    async fn one_bucket_per_shop_and_shared_between_callers() {
        let throttles = Throttles::default();
        let a = ShopDomain::parse("a-store.myshopify.com").unwrap();
        let b = ShopDomain::parse("b-store.myshopify.com").unwrap();
        assert!(Arc::ptr_eq(
            &throttles.for_shop(&a),
            &throttles.for_shop(&a)
        ));
        assert!(!Arc::ptr_eq(
            &throttles.for_shop(&a),
            &throttles.for_shop(&b)
        ));
    }
}
