//! C row 12: `RAMPSMITH_MASTER_KEYS` decodes and round-trips through `crates/crypto`
//! (ADR-021, ADR-152). No network: the ring is parsed, every key is used to seal and open a
//! probe value, and the ring as a whole is checked to open what its active key sealed. The scan
//! ring and the free-scan service token (ADR-266, ADR-267) are checked when they are set: the
//! ring parses, round-trips and shares no key with the master ring, and the token is long enough.

use crypto::KeyRing;

use super::common::{Step, gather};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::vars::Var;

/// The master ring is required; the other two are read when set.
pub(super) const READS: &[Var] = &[
    Var::RampsmithMasterKeys,
    Var::RampsmithScanSecretKeys,
    Var::FreeScanServiceToken,
    Var::EmailLinkKeys,
];

const PLAINTEXT: &[u8] = b"rsctl doctor round trip";
const CONTEXT: &[u8] = b"rsctl/doctor/master-keys";

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).unwrap_or_else(|outcome| outcome) })
}

/// Seals under `ring`'s active key and opens it again.
fn round_trip(ring: &KeyRing) -> Result<(), String> {
    let sealed = ring
        .seal(PLAINTEXT, CONTEXT)
        .map_err(|e| format!("sealing failed: {e}"))?;
    let opened = ring
        .open(sealed.key_id().as_str(), sealed.bytes(), CONTEXT)
        .map_err(|e| format!("opening failed: {e}"))?;
    if opened.as_slice() == PLAINTEXT {
        Ok(())
    } else {
        Err("the opened value differs from the sealed one".to_owned())
    }
}

fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(ctx, 12, &[Var::RampsmithMasterKeys])?;
    let spec = inputs.text(Var::RampsmithMasterKeys);
    // `CryptoError` messages never contain key material (crates/crypto), so they may be shown.
    let ring = match KeyRing::parse(spec) {
        Ok(ring) => ring,
        Err(e) => {
            return Ok(Outcome::fail(format!(
                "RAMPSMITH_MASTER_KEYS does not parse: {e} (expected id:base64key[,id:base64key...], newest first; make one with `rsctl keys generate`)"
            )));
        }
    };
    if let Err(reason) = round_trip(&ring) {
        return Ok(Outcome::fail(format!(
            "the ring's active key `{}` failed the round trip: {reason}",
            ring.active()
        )));
    }
    // Each older key must work on its own too: a rotation relies on them to open old data.
    let entries: Vec<&str> = spec.split(',').map(str::trim).collect();
    for entry in &entries {
        let id = entry.split_once(':').map_or("?", |(id, _)| id.trim());
        let result = KeyRing::parse(entry)
            .map_err(|e| e.to_string())
            .and_then(|single| round_trip(&single));
        if let Err(reason) = result {
            return Ok(Outcome::fail(format!(
                "key `{id}` failed the round trip: {reason}"
            )));
        }
    }
    if let Some(reason) = scan_inputs_problem(ctx, spec) {
        return Ok(Outcome::fail(reason));
    }
    let older = entries.len().saturating_sub(1);
    Ok(Outcome::pass(format!(
        "{} key(s) parse; the active key `{}` seals and opens a probe value{}",
        entries.len(),
        ring.active(),
        if older > 0 {
            format!(", and each of the {older} older key(s) does too")
        } else {
            String::new()
        }
    )))
}

/// Shortest `FREE_SCAN_SERVICE_TOKEN` the api accepts (`crates/api`, ADR-267).
const MIN_SERVICE_TOKEN: usize = 32;

/// What is wrong with `RAMPSMITH_SCAN_SECRET_KEYS` or `FREE_SCAN_SERVICE_TOKEN`, when either is
/// set. Unset is not a fault here: the free scanner stays closed and a protected store is
/// reported as blocked until they are.
fn scan_inputs_problem(ctx: &Ctx, master_spec: &str) -> Option<String> {
    if let Ok(found) = ctx.vars.gather(12, &[Var::RampsmithScanSecretKeys]) {
        let spec = found.text(Var::RampsmithScanSecretKeys);
        let ring = match KeyRing::parse(spec) {
            Ok(ring) => ring,
            Err(e) => {
                return Some(format!(
                    "RAMPSMITH_SCAN_SECRET_KEYS does not parse: {e} (expected id:base64key[,id:base64key...], newest first; make one with `rsctl keys generate`)"
                ));
            }
        };
        if let Err(reason) = round_trip(&ring) {
            return Some(format!(
                "the scan ring's active key `{}` failed the round trip: {reason}",
                ring.active()
            ));
        }
        let master: Vec<&str> = master_spec.split(',').map(str::trim).collect();
        if spec
            .split(',')
            .map(str::trim)
            .any(|entry| master.contains(&entry))
        {
            return Some(
                "RAMPSMITH_SCAN_SECRET_KEYS shares a key with RAMPSMITH_MASTER_KEYS; the engine holds the scan ring and must never hold a master key (ADR-266): generate a separate ring".to_owned(),
            );
        }
    }
    if let Ok(found) = ctx.vars.gather(12, &[Var::EmailLinkKeys]) {
        let spec = found.text(Var::EmailLinkKeys);
        if let Err(e) = KeyRing::parse(spec) {
            return Some(format!(
                "EMAIL_LINK_KEYS does not parse: {e} (expected id:base64key[,id:base64key...], newest first; make one with `rsctl keys generate`)"
            ));
        }
        let scan_spec = ctx
            .vars
            .gather(12, &[Var::RampsmithScanSecretKeys])
            .map(|found| found.text(Var::RampsmithScanSecretKeys).to_owned())
            .unwrap_or_default();
        let others: Vec<&str> = master_spec
            .split(',')
            .chain(scan_spec.split(','))
            .map(str::trim)
            .collect();
        if spec
            .split(',')
            .map(str::trim)
            .any(|entry| others.contains(&entry))
        {
            return Some(
                "EMAIL_LINK_KEYS shares a key with another ring; the unsubscribe-link key signs only that (ADR-274): generate a separate ring".to_owned(),
            );
        }
    }
    if let Ok(found) = ctx.vars.gather(12, &[Var::FreeScanServiceToken])
        && found.text(Var::FreeScanServiceToken).len() < MIN_SERVICE_TOKEN
    {
        return Some(format!(
            "FREE_SCAN_SERVICE_TOKEN is shorter than {MIN_SERVICE_TOKEN} characters; the api refuses it (ADR-267). Make one with `openssl rand -base64 36`"
        ));
    }
    None
}
