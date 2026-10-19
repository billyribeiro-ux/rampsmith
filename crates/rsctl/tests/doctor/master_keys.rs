//! C row 12: `RAMPSMITH_MASTER_KEYS` decodes and round-trips through `crates/crypto`.

use rsctl::keys;

use crate::support::{Rig, fail, master_ring, now, pass, skip_missing};

#[tokio::test]
async fn a_generated_ring_round_trips() {
    let spec = master_ring();
    let rig = Rig::new(&[("RAMPSMITH_MASTER_KEYS", spec.as_str())]).await;
    let outcome = rig.run("master-keys.round-trip").await;
    let detail = pass(&outcome);
    assert!(
        detail.contains("1 key(s) parse") && detail.contains("`k1`"),
        "{detail}"
    );
    assert!(!detail.contains(spec.split(':').nth(1).unwrap()));
    assert!(
        rig.server.received_requests().await.unwrap().is_empty(),
        "no network"
    );
}

#[tokio::test]
async fn a_rotated_ring_checks_every_key() {
    let first = keys::generate(now(), Some("k1")).unwrap();
    let rotated = keys::rotate(first.ring.expose(), now(), Some("k2")).unwrap();
    let rig = Rig::new(&[("RAMPSMITH_MASTER_KEYS", rotated.ring.expose())]).await;
    let outcome = rig.run("master-keys.round-trip").await;
    let detail = pass(&outcome);
    assert!(
        detail.contains("2 key(s)")
            && detail.contains("active key `k2`")
            && detail.contains("1 older"),
        "{detail}"
    );
}

#[tokio::test]
async fn malformed_rings_fail_with_crypto_s_reason_and_never_the_key() {
    for (bad, reason) in [
        ("justakey", "id:base64key"),
        ("k1:not-base64-!!!", "base64"),
        ("k1:AAAA", "32"),
        ("K1:AAAA", "key ids"),
    ] {
        let rig = Rig::new(&[("RAMPSMITH_MASTER_KEYS", bad)]).await;
        let outcome = rig.run("master-keys.round-trip").await;
        let detail = fail(&outcome);
        assert!(detail.contains("does not parse"), "{bad}: {detail}");
        assert!(
            detail.to_lowercase().contains(&reason.to_lowercase()),
            "{bad}: {detail}"
        );
        assert!(
            !detail.contains("AAAA") && !detail.contains("not-base64"),
            "{detail}"
        );
    }
}

#[tokio::test]
async fn a_duplicate_id_fails() {
    let key = crypto::KeyRing::generate_master_key().unwrap();
    let spec = format!("k1:{key},k1:{key}");
    let rig = Rig::new(&[("RAMPSMITH_MASTER_KEYS", spec.as_str())]).await;
    let outcome = rig.run("master-keys.round-trip").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("duplicate key id") && !detail.contains(&key),
        "{detail}"
    );
}

#[tokio::test]
async fn unset_skips_naming_row_12() {
    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("master-keys.round-trip").await).contains("C row 12"));
}
