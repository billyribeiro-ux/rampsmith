//! Envelope encryption behaviour (ADR-021). Written before the implementation.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use crypto::{CryptoError, KeyRing};
use proptest::prelude::*;
use secrecy::ExposeSecret;

const K1: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // 0..=31, unpadded base64
const K2: &str = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"; // 32..=63

fn ring(spec: &str) -> KeyRing {
    KeyRing::parse(spec).unwrap()
}

#[test]
fn a_sealed_value_opens_with_the_same_context() {
    let ring = ring(&format!("k1:{K1}"));
    let sealed = ring
        .seal(b"shpat_secret", b"shopify_tokens/access/1")
        .unwrap();
    assert_eq!(sealed.key_id().as_str(), "k1");
    let opened = ring
        .open(
            sealed.key_id().as_str(),
            sealed.bytes(),
            b"shopify_tokens/access/1",
        )
        .unwrap();
    assert_eq!(opened.as_slice(), b"shpat_secret");
}

#[test]
fn the_plaintext_never_appears_in_the_ciphertext() {
    let ring = ring(&format!("k1:{K1}"));
    let secret = b"shpat_0123456789abcdef";
    let sealed = ring.seal(secret, b"ctx").unwrap();
    assert!(!sealed.bytes().windows(secret.len()).any(|w| w == secret));
}

#[test]
fn sealing_twice_gives_different_ciphertexts() {
    let ring = ring(&format!("k1:{K1}"));
    let a = ring.seal(b"same", b"ctx").unwrap();
    let b = ring.seal(b"same", b"ctx").unwrap();
    assert_ne!(a.bytes(), b.bytes());
}

#[test]
fn a_different_context_fails_authentication() {
    let ring = ring(&format!("k1:{K1}"));
    let sealed = ring.seal(b"value", b"shopify_tokens/access/1").unwrap();
    for other in [
        &b"shopify_tokens/access/2"[..],
        b"shopify_tokens/refresh/1",
        b"",
    ] {
        assert_eq!(
            ring.open("k1", sealed.bytes(), other).unwrap_err(),
            CryptoError::Authentication
        );
    }
}

#[test]
fn every_tampered_byte_fails_authentication() {
    let ring = ring(&format!("k1:{K1}"));
    let sealed = ring.seal(b"value", b"ctx").unwrap();
    for i in 1..sealed.bytes().len() {
        let mut bytes = sealed.bytes().to_vec();
        bytes[i] ^= 0x01;
        assert_eq!(
            ring.open("k1", &bytes, b"ctx").unwrap_err(),
            CryptoError::Authentication,
            "byte {i}"
        );
    }
}

#[test]
fn an_unknown_format_version_or_truncation_is_malformed() {
    let ring = ring(&format!("k1:{K1}"));
    let sealed = ring.seal(b"value", b"ctx").unwrap();
    let mut bytes = sealed.bytes().to_vec();
    bytes[0] = 0x7f;
    assert_eq!(
        ring.open("k1", &bytes, b"ctx").unwrap_err(),
        CryptoError::Malformed
    );
    for len in [0, 1, 12, 60, 72, 88] {
        let cut = &sealed.bytes()[..len.min(sealed.bytes().len() - 1)];
        assert_eq!(
            ring.open("k1", cut, b"ctx").unwrap_err(),
            CryptoError::Malformed,
            "len {len}"
        );
    }
}

#[test]
fn the_key_id_is_authenticated() {
    // The same key material under another id must not open the value: the id stored next
    // to the ciphertext cannot be swapped.
    let ring = ring(&format!("k1:{K1},k1b:{K1}"));
    let sealed = ring.seal(b"value", b"ctx").unwrap();
    assert_eq!(
        ring.open("k1b", sealed.bytes(), b"ctx").unwrap_err(),
        CryptoError::Authentication
    );
}

#[test]
fn an_unknown_key_id_is_reported() {
    let sealed = ring(&format!("k1:{K1}")).seal(b"value", b"ctx").unwrap();
    let other = ring(&format!("k2:{K2}"));
    assert_eq!(
        other.open("k1", sealed.bytes(), b"ctx").unwrap_err(),
        CryptoError::UnknownKey("k1".to_owned())
    );
}

#[test]
fn the_first_key_is_active_and_older_keys_still_open() {
    let old = ring(&format!("k1:{K1}"));
    let sealed = old.seal(b"value", b"ctx").unwrap();

    let rotated = ring(&format!("k2:{K2},k1:{K1}"));
    assert_eq!(rotated.active().as_str(), "k2");
    assert!(rotated.needs_rewrap("k1"));
    assert!(!rotated.needs_rewrap("k2"));
    let opened = rotated.open("k1", sealed.bytes(), b"ctx").unwrap();
    assert_eq!(opened.as_slice(), b"value");

    let rewrapped = rotated.rewrap("k1", sealed.bytes(), b"ctx").unwrap();
    assert_eq!(rewrapped.key_id().as_str(), "k2");
    let only_new = ring(&format!("k2:{K2}"));
    let opened = only_new.open("k2", rewrapped.bytes(), b"ctx").unwrap();
    assert_eq!(opened.as_slice(), b"value");
}

#[test]
fn rewrap_keeps_the_context_binding() {
    let rotated = ring(&format!("k2:{K2},k1:{K1}"));
    let sealed = ring(&format!("k1:{K1}")).seal(b"value", b"ctx").unwrap();
    assert_eq!(
        rotated.rewrap("k1", sealed.bytes(), b"other").unwrap_err(),
        CryptoError::Authentication
    );
}

/// Audit L6: `rewrap` keeps the value's ciphertext byte for byte, and still decrypts it once to
/// check it, which is what its documentation now says.
#[test]
fn rewrap_carries_the_data_over_and_refuses_tampered_data() {
    let rotated = ring(&format!("k2:{K2},k1:{K1}"));
    let sealed = ring(&format!("k1:{K1}")).seal(b"value", b"ctx").unwrap();
    let rewrapped = rotated.rewrap("k1", sealed.bytes(), b"ctx").unwrap();

    // Format: version (1), wrap nonce (12), wrapped data key (32 + 16 tag), then the value's own
    // nonce and ciphertext. Only the first three are rewritten.
    let wrapped_end = 1 + 12 + 48;
    assert_eq!(
        rewrapped.bytes()[wrapped_end..],
        sealed.bytes()[wrapped_end..]
    );
    assert_ne!(
        rewrapped.bytes()[..wrapped_end],
        sealed.bytes()[..wrapped_end]
    );

    // The value is checked on the way: one flipped bit in its ciphertext is refused, although
    // only the wrapping would have been rewritten.
    let mut tampered = sealed.bytes().to_vec();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    assert_eq!(
        rotated.rewrap("k1", &tampered, b"ctx").unwrap_err(),
        CryptoError::Authentication
    );
}

#[test]
fn open_string_returns_a_secret_string() {
    let ring = ring(&format!("k1:{K1}"));
    let sealed = ring.seal("shprt_ünïcode".as_bytes(), b"ctx").unwrap();
    let opened = ring.open_string("k1", sealed.bytes(), b"ctx").unwrap();
    assert_eq!(opened.expose_secret(), "shprt_ünïcode");

    let binary = ring.seal(&[0xff, 0xfe], b"ctx").unwrap();
    assert_eq!(
        ring.open_string("k1", binary.bytes(), b"ctx").unwrap_err(),
        CryptoError::NotText
    );
}

#[test]
fn key_ring_parsing_rejects_bad_configuration() {
    let cases = [
        ("", "empty"),
        ("   ", "blank"),
        ("k1", "no colon"),
        (&format!(":{K1}") as &str, "empty id"),
        (&format!("K1:{K1}"), "uppercase id"),
        (&format!("k 1:{K1}"), "space in id"),
        (&format!("{}:{K1}", "k".repeat(33)), "id too long"),
        ("k1:not base64!", "bad base64"),
        ("k1:AAECAw", "short key"),
        (&format!("k1:{K1}AAAA"), "long key"),
        (&format!("k1:{K1},k1:{K2}"), "duplicate id"),
        (&format!("k1:{K1},"), "trailing comma"),
    ];
    for (spec, why) in cases {
        assert!(
            matches!(KeyRing::parse(spec), Err(CryptoError::Config(_))),
            "{why}: {spec:?}"
        );
    }
}

#[test]
fn key_ring_parsing_accepts_padded_base64_and_whitespace() {
    let padded = format!(" k1 : {K1}= , k2:{K2}= ");
    let ring = KeyRing::parse(&padded).unwrap();
    assert_eq!(ring.active().as_str(), "k1");
}

#[test]
fn the_key_ring_debug_output_hides_keys() {
    let ring = ring(&format!("k2:{K2},k1:{K1}"));
    let debug = format!("{ring:?}");
    assert!(debug.contains("k2") && debug.contains("k1"));
    assert!(!debug.contains(K1) && !debug.contains(K2));
}

#[test]
fn a_generated_master_key_parses() {
    let key = KeyRing::generate_master_key().unwrap();
    let ring = KeyRing::parse(&format!("fresh:{key}")).unwrap();
    let sealed = ring.seal(b"value", b"ctx").unwrap();
    assert_eq!(
        ring.open("fresh", sealed.bytes(), b"ctx")
            .unwrap()
            .as_slice(),
        b"value"
    );
    assert_ne!(KeyRing::generate_master_key().unwrap(), key);
}

proptest! {
    #[test]
    fn any_value_round_trips(
        plaintext in proptest::collection::vec(any::<u8>(), 0..2048),
        context in proptest::collection::vec(any::<u8>(), 0..128),
    ) {
        let ring = ring(&format!("k2:{K2},k1:{K1}"));
        let sealed = ring.seal(&plaintext, &context).unwrap();
        prop_assert_eq!(sealed.bytes().len(), plaintext.len() + crypto::Sealed::OVERHEAD);
        let opened = ring.open(sealed.key_id().as_str(), sealed.bytes(), &context).unwrap();
        prop_assert_eq!(opened.as_slice(), plaintext.as_slice());
    }
}
