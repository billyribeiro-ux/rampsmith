//! The storefront password, handed to the engine for one scan (ADR-266).
//!
//! The engine never holds a master key (ADR-035), so it cannot open `sites.storefront_password_ct`.
//! When a scan starts, `ctl` opens the site's password with the master keys and seals it again
//! under the scan key ring (`RAMPSMITH_SCAN_SECRET_KEYS`), which only `ctl` and the engine
//! hold. The sealed copy is bound to the scan by its context, lives on the scan row, and is
//! cleared when the scan ends. The plaintext exists in this process for the length of one
//! call and is never logged, stored or returned.

use crypto::KeyRing;
use db::TenantTx;
use db::repo::scan_secrets::{self, SealedSecret};
use domain::{ScanId, SiteId};
use secrecy::ExposeSecret;
use tracing::warn;

use super::{Jobs, database};
use queue::Failure;

/// The two key rings the hand-off needs.
#[derive(Debug, Clone)]
pub struct ScanSecrets {
    master: KeyRing,
    scan: KeyRing,
}

impl ScanSecrets {
    /// `master` opens what the merchant saved; `scan` seals what the engine reads.
    #[must_use]
    pub const fn new(master: KeyRing, scan: KeyRing) -> Self {
        Self { master, scan }
    }
}

/// The context the api sealed the site's password under (`crates/api/src/r1.rs`).
fn site_context(site: SiteId) -> Vec<u8> {
    format!("sites/storefront_password/{}", site.as_uuid()).into_bytes()
}

/// The context of the copy sealed for the engine. The engine builds the same string.
#[must_use]
pub fn scan_context(scan: ScanId) -> Vec<u8> {
    format!("scans/storefront_password/{}", scan.as_uuid()).into_bytes()
}

impl Jobs {
    /// Gives the engine this scan's storefront password, when the site has one and the scan key
    /// ring is configured. Without either, nothing is stored and a protected store is reported
    /// as blocked (ADR-071). A saved password that cannot be opened (its master key was
    /// removed) is skipped the same way, with a warning that carries no value.
    pub(super) async fn hand_storefront_password(
        &self,
        tx: &mut TenantTx,
        scan: ScanId,
        site: SiteId,
    ) -> Result<(), Failure> {
        let Some(keys) = &self.scan_secrets else {
            return Ok(());
        };
        let Some(saved) = scan_secrets::site_password(tx, site)
            .await
            .map_err(|e| database(&e))?
        else {
            return Ok(());
        };
        let opened = keys
            .master
            .open_string(&saved.key_id, &saved.bytes, &site_context(site));
        let password = match opened {
            Ok(password) => password,
            Err(error) => {
                warn!(%error, "the saved storefront password cannot be opened; scanning without it");
                return Ok(());
            }
        };
        let sealed = match keys
            .scan
            .seal(password.expose_secret().as_bytes(), &scan_context(scan))
        {
            Ok(sealed) => sealed,
            Err(error) => {
                warn!(%error, "the storefront password could not be sealed for the engine");
                return Ok(());
            }
        };
        let (key_id, bytes) = sealed.into_parts();
        scan_secrets::set_scan_password(
            tx,
            scan,
            Some(&SealedSecret {
                key_id: key_id.to_string(),
                bytes,
            }),
        )
        .await
        .map_err(|e| database(&e))?;
        Ok(())
    }
}
