//! Retry delays: exponential with equal jitter, capped at one hour (PLAN §10).
//!
//! The TypeScript engine implements the same function; both are tested against
//! `testdata/backoff.json`, so a job retried by either language waits the same time.

use std::time::Duration;

const BASE_MS: u64 = 5_000;
const CAP_MS: u64 = 3_600_000;

/// How long to wait before retrying after failed attempt number `attempt` (1-based).
///
/// `e = min(1 h, 5 s × 2^(attempt − 1))`; the delay is `e/2 + ⌊jitter × e/2⌋`, so retries
/// of many failed jobs spread out instead of arriving together. `jitter` is a uniform
/// sample in `[0, 1)`; values outside that range are clamped.
#[must_use]
pub fn retry_delay(attempt: u32, jitter: f64) -> Duration {
    let exponent = attempt.saturating_sub(1).min(30);
    let exponential = BASE_MS.saturating_mul(1 << exponent).min(CAP_MS);
    let half = exponential / 2;
    let jitter = if jitter.is_nan() {
        0.0
    } else {
        jitter.clamp(0.0, 0.999_999_999)
    };
    // `half` is at most 1_800_000, exactly representable as f64; the product stays below it.
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    let spread = (jitter * half as f64).floor() as u64;
    Duration::from_millis(half + spread)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vectors {
        cases: Vec<Case>,
    }

    #[derive(serde::Deserialize)]
    struct Case {
        attempt: u32,
        jitter: f64,
        delay_ms: u64,
    }

    #[test]
    fn matches_the_shared_vectors() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../testdata/backoff.json")).unwrap();
        assert!(!vectors.cases.is_empty());
        for case in vectors.cases {
            assert_eq!(
                retry_delay(case.attempt, case.jitter).as_millis(),
                u128::from(case.delay_ms),
                "attempt {} jitter {}",
                case.attempt,
                case.jitter
            );
        }
    }

    #[test]
    fn never_exceeds_one_hour() {
        for attempt in 0..100 {
            assert!(retry_delay(attempt, 0.999_999_9) < Duration::from_hours(1));
        }
    }

    #[test]
    fn grows_with_each_attempt_until_the_cap() {
        let delays: Vec<Duration> = (1..=11).map(|a| retry_delay(a, 0.0)).collect();
        assert!(delays.windows(2).all(|w| w[0] < w[1]), "{delays:?}");
    }

    #[test]
    fn clamps_out_of_range_jitter() {
        assert_eq!(retry_delay(1, -3.0), retry_delay(1, 0.0));
        assert_eq!(retry_delay(1, f64::NAN), retry_delay(1, 0.0));
        assert!(retry_delay(1, 7.0) < Duration::from_secs(5));
    }

    #[test]
    fn treats_attempt_zero_like_the_first() {
        assert_eq!(retry_delay(0, 0.5), retry_delay(1, 0.5));
    }
}
