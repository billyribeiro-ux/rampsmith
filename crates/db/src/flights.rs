//! In-process single flight for the per-shop token lock (audit M5, ADR-041).
//!
//! The advisory lock serialises token acquisition across processes, but a request waiting for
//! it holds a pool connection, and its holder used to need a second one. A burst of cold app
//! opens could therefore take every connection and starve every tenant. Requests for one shop
//! now queue here first, in memory and holding no connection, so at most one request per shop
//! per process ever reaches the database; and the number of shops holding a connection for a
//! lock is capped at half the pool, so everyone else keeps a share.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::{OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

type Slot = Arc<tokio::sync::Mutex<()>>;

#[derive(Debug)]
pub(crate) struct Flights {
    slots: Mutex<HashMap<String, Slot>>,
    permits: Arc<Semaphore>,
}

impl Flights {
    /// For a pool of `connections`: at most half of them (and at least one) may be held by
    /// shop locks at the same time.
    pub(crate) fn new(connections: u32) -> Self {
        let holders = usize::try_from((connections / 2).max(1)).unwrap_or(1);
        Self {
            slots: Mutex::new(HashMap::new()),
            permits: Arc::new(Semaphore::new(holders)),
        }
    }

    /// Waits for this process's turn on `key`, then for a share of the pool.
    pub(crate) async fn enter(self: &Arc<Self>, key: &str) -> Flight {
        let slot = self
            .slots
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key.to_owned())
            .or_default()
            .clone();
        // Built before the first await, so a cancelled request still tidies the map.
        let mut flight = Flight {
            flights: Arc::clone(self),
            key: key.to_owned(),
            slot,
            guard: None,
            permit: None,
        };
        flight.guard = Some(Arc::clone(&flight.slot).lock_owned().await);
        // The semaphore is never closed, so a permit is always granted in the end.
        flight.permit = Arc::clone(&self.permits).acquire_owned().await.ok();
        flight
    }
}

/// A request's place at the head of the queue for one shop. Dropping it lets the next
/// request for the shop go.
#[derive(Debug)]
pub(crate) struct Flight {
    flights: Arc<Flights>,
    key: String,
    slot: Slot,
    guard: Option<OwnedMutexGuard<()>>,
    permit: Option<OwnedSemaphorePermit>,
}

impl Drop for Flight {
    fn drop(&mut self) {
        let mut slots = self
            .flights
            .slots
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Give back the share of the pool, then release our hold on the queue's mutex, then
        // forget the shop if nobody else has cloned its slot: the map's copy and ours are the
        // only two. Requests clone the slot under this same lock, so none can slip in between
        // the count and the removal.
        drop(self.permit.take());
        self.guard = None;
        if Arc::strong_count(&self.slot) == 2 {
            slots.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn one_request_per_shop_runs_at_a_time_and_the_map_empties() {
        let flights = Arc::new(Flights::new(10));
        let first = flights.enter("a.myshopify.com").await;
        let other = flights.enter("b.myshopify.com").await;

        let queued = {
            let flights = Arc::clone(&flights);
            tokio::spawn(async move { flights.enter("a.myshopify.com").await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!queued.is_finished(), "the second request must wait");

        drop(first);
        let second = queued.await.unwrap();
        drop(second);
        drop(other);
        assert!(flights.slots.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn at_most_half_the_pool_holds_locks_but_always_one() {
        for (connections, holders) in [(1, 1), (2, 1), (3, 1), (4, 2), (10, 5)] {
            let flights = Arc::new(Flights::new(connections));
            let mut held = Vec::new();
            for n in 0..holders {
                held.push(flights.enter(&format!("{n}.myshopify.com")).await);
            }
            let extra = tokio::time::timeout(
                Duration::from_millis(50),
                flights.enter("extra.myshopify.com"),
            )
            .await;
            assert!(extra.is_err(), "{connections} connections allow {holders}");
        }
    }

    #[tokio::test]
    async fn a_cancelled_request_leaves_nothing_behind() {
        let flights = Arc::new(Flights::new(4));
        let holder = flights.enter("a.myshopify.com").await;
        let cancelled =
            tokio::time::timeout(Duration::from_millis(50), flights.enter("a.myshopify.com")).await;
        assert!(cancelled.is_err());
        drop(holder);
        assert!(flights.slots.lock().unwrap().is_empty());
    }
}
