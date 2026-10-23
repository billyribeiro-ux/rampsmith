//! The sealed vector the TypeScript engine also opens (ADR-264). If this test and
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
