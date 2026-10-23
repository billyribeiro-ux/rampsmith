//! The sealed vector the TypeScript engine also opens (ADR-266). If this test and
//! `packages/engine/test/scan-secret.test.ts` ever disagree, the format changed on one side.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use crypto::KeyRing;
use secrecy::ExposeSecret;

fn field(text: &str, name: &str) -> String {
    text.lines()
        .find_map(|line| line.strip_prefix(&format!("{name}=")))
        .unwrap_or_else(|| panic!("vector has no {name}"))
        .to_owned()
}

#[test]
fn opens_the_vector_the_engine_opens() {
    let text = include_str!("vectors/scan-secret.txt");
    let ring = KeyRing::parse(&field(text, "ring")).expect("ring");
    let sealed = STANDARD.decode(field(text, "sealed")).expect("sealed");
    let context = field(text, "context");
    let opened = ring
        .open_string(&field(text, "key_id"), &sealed, context.as_bytes())
        .expect("opens");
    assert_eq!(opened.expose_secret(), field(text, "plaintext"));
    // Another scan's context must not open it.
    assert!(
        ring.open(
            &field(text, "key_id"),
            &sealed,
            b"scans/storefront_password/0199c0de-0000-7000-8000-000000000002"
        )
        .is_err(),
        "a value sealed for one scan opened for another"
    );
}

/// The rotation order of `docs/runbooks/rotate-scan-secret-keys.md`: the engine's ring gets the new
/// key before `ctl` seals with it, and the old key stays until the last old copy is gone.
#[test]
fn a_rotated_scan_ring_seals_under_the_new_key_and_opens_both() {
    let text = include_str!("vectors/scan-secret.txt");
    let context = field(text, "context");
    let old_only = KeyRing::parse(&field(text, "ring")).expect("old ring");
    let rotated = KeyRing::parse(&field(text, "ring_rotated")).expect("rotated ring");
    assert_eq!(rotated.active().as_str(), field(text, "key_id_new"));

    // What was sealed before the rotation still opens, and one sealed after opens with the
    // same ring, whose bytes are the ones the engine's test pins.
    let before = STANDARD.decode(field(text, "sealed")).expect("sealed");
    let after = STANDARD
        .decode(field(text, "sealed_new"))
        .expect("sealed_new");
    let plaintext = field(text, "plaintext");
    for (id, bytes) in [("scan1", &before), ("scan2", &after)] {
        let opened = rotated
            .open_string(id, bytes, context.as_bytes())
            .expect("opens");
        assert_eq!(opened.expose_secret(), plaintext, "{id}");
    }
    let fresh = rotated
        .seal(plaintext.as_bytes(), context.as_bytes())
        .expect("seals");
    assert_eq!(fresh.key_id().as_str(), "scan2");

    // The wrong order: sealing under the new key before the engine has it. The old-only ring
    // cannot open the copy, which is why the engine gets the new key first.
    assert!(
        old_only
            .open(fresh.key_id().as_str(), fresh.bytes(), context.as_bytes())
            .is_err()
    );
}
