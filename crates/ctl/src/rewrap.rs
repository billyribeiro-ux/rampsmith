//! Re-wrapping stored secrets under the active master key (audit L6, ADR-045; amends ADR-021).
//!
//! Rotating the master key is: prepend the new key to `RAMPSMITH_MASTER_KEYS` and redeploy
//! (new values now seal under it, old ones still open under theirs), run a pass of [`Rewrap`],
//! check that [`Rewrap::remaining`] no longer lists the old key, then remove the old key.
//!
//! A pass finds the token rows whose key id is not the active one, and for each row, inside
//! that tenant's own transaction, re-wraps the data key of the access and the refresh token and
//! writes them back with a compare-and-swap on the row as it was read
//! ([`db::repo::shopify::replace_wrapping`]). It neither bumps the row's version nor holds the
//! shop's token lock: it stores the same tokens under another wrapping, so whichever writer
//! gets to the row first leaves tokens that are valid. A row someone else changed in between is
//! skipped, and the next pass sees it again. A pass can be run any number of times, by any
//! number of processes, and stopped at any point.
//!
//! The operator command that calls this (`rsctl keys rewrap`) is not here. It needs a database
//! connection as `rampsmith_worker` and the key ring, and calls `Rewrap::new(db, keys).run()`.

use crypto::{CryptoError, KeyRing};
use db::repo::shopify::{self, Rewrapped, SealedTokens};
use db::{Db, DbError, KeyCount, RewrapCandidate};
use domain::ShopId;
use shopify_auth::{access_context, refresh_context};
use tracing::{info, warn};

/// How many rows a pass lists at a time unless told otherwise.
pub const DEFAULT_BATCH: u16 = 100;
/// The most rows the database lists at a time, whatever is asked for.
pub const MAX_BATCH: u16 = 1000;

/// What a pass did. All four counts are rows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Report {
    /// Rows found under a key other than the active one.
    pub examined: u64,
    /// Rows now wrapped under the active key.
    pub rewrapped: u64,
    /// Rows left for the next pass because they changed, or were already done by another
    /// process, between being listed and being written.
    pub skipped: u64,
    /// Rows that could not be re-wrapped: the key ring lacks their key, or their ciphertext
    /// does not open with its context. A pass reports them and carries on; they stay under
    /// their old key, which therefore must not be removed.
    pub failed: u64,
}

/// Re-wraps stored Shopify tokens under the active master key.
#[derive(Debug, Clone)]
pub struct Rewrap {
    db: Db,
    keys: KeyRing,
    batch: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Rewrapped,
    Skipped,
    Failed,
}

impl Rewrap {
    /// A pass over `db` (connected as `rampsmith_worker`) with `keys`, whose first key is the
    /// one to re-wrap under and which must still hold every key the rows carry.
    #[must_use]
    pub const fn new(db: Db, keys: KeyRing) -> Self {
        Self {
            db,
            keys,
            batch: DEFAULT_BATCH,
        }
    }

    /// This pass with `batch` rows listed at a time (1 to [`MAX_BATCH`]).
    #[must_use]
    pub fn with_batch(mut self, batch: u16) -> Self {
        self.batch = batch.clamp(1, MAX_BATCH);
        self
    }

    /// Re-wraps every token row that is not under the active key, batch by batch, and reports
    /// what it did. A database error ends the pass; run it again to continue.
    pub async fn run(&self) -> Result<Report, DbError> {
        let active = self.keys.active().as_str();
        let mut report = Report::default();
        let mut after: Option<ShopId> = None;
        loop {
            let rows = self
                .db
                .tokens_to_rewrap(active, after, i32::from(self.batch))
                .await?;
            let Some(last) = rows.last() else { break };
            after = Some(last.shop);
            let listed = rows.len();
            for row in &rows {
                report.examined += 1;
                match self.rewrap_one(row).await? {
                    Outcome::Rewrapped => report.rewrapped += 1,
                    Outcome::Skipped => report.skipped += 1,
                    Outcome::Failed => report.failed += 1,
                }
            }
            info!(
                examined = report.examined,
                rewrapped = report.rewrapped,
                "token re-wrap progress"
            );
            if listed < usize::from(self.batch) {
                break;
            }
        }
        info!(
            examined = report.examined,
            rewrapped = report.rewrapped,
            skipped = report.skipped,
            failed = report.failed,
            "token re-wrap pass finished"
        );
        Ok(report)
    }

    /// How many token rows each master key id wraps. A key is safe to remove from the key ring
    /// when it is not listed.
    pub async fn remaining(&self) -> Result<Vec<KeyCount>, DbError> {
        self.db.token_key_counts().await
    }

    async fn rewrap_one(&self, row: &RewrapCandidate) -> Result<Outcome, DbError> {
        let mut tx = self.db.tenant(row.tenant).await?;
        // Read again inside the tenant's transaction: the listing is only a pointer.
        let Some(stored) = shopify::get_tokens(&mut tx, row.shop).await? else {
            return Ok(Outcome::Skipped);
        };
        if !self.keys.needs_rewrap(&stored.tokens.key_id) {
            return Ok(Outcome::Skipped);
        }
        let rewrapped = match self.rewrap(row.shop, &stored.tokens) {
            Ok(rewrapped) => rewrapped,
            Err(error) => {
                // Ids and the reason only: never the ciphertext, a token or a shop domain.
                warn!(tenant = %row.tenant, shop = %row.shop, key = %stored.tokens.key_id, %error,
                    "could not re-wrap a stored token");
                return Ok(Outcome::Failed);
            }
        };
        let swapped = shopify::replace_wrapping(&mut tx, row.shop, &stored, &rewrapped).await?;
        tx.commit().await?;
        Ok(if swapped {
            Outcome::Rewrapped
        } else {
            Outcome::Skipped
        })
    }

    fn rewrap(&self, shop: ShopId, tokens: &SealedTokens) -> Result<Rewrapped, CryptoError> {
        let access = self.keys.rewrap(
            &tokens.key_id,
            &tokens.access_ct,
            access_context(shop).as_bytes(),
        )?;
        let refresh = self.keys.rewrap(
            &tokens.key_id,
            &tokens.refresh_ct,
            refresh_context(shop).as_bytes(),
        )?;
        let (key_id, access_ct) = access.into_parts();
        let (_, refresh_ct) = refresh.into_parts();
        Ok(Rewrapped {
            access_ct,
            refresh_ct,
            key_id: key_id.as_str().to_owned(),
        })
    }
}
