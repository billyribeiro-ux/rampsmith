//! C row 12: `RAMPSMITH_MASTER_KEYS` decodes and round-trips through `crates/crypto`
//! (ADR-021, ADR-152). No network: the ring is parsed, every key is used to seal and open a
//! probe value, and the ring as a whole is checked to open what its active key sealed.

use crypto::KeyRing;

use super::common::{Step, gather};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[Var::RampsmithMasterKeys];

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
    let inputs = gather(ctx, 12, READS)?;
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
