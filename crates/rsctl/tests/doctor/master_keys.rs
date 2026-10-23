//! C row 12: `RAMPSMITH_MASTER_KEYS` decodes and round-trips through `crates/crypto`.

use rsctl::keys;

use crate::support::{Rig, fail, master_ring, now, pass, scan_ring, skip_missing};

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

#[tokio::test]
async fn a_separate_scan_ring_and_a_long_service_token_pass() {
    let master = master_ring();
    let scan = scan_ring();
    let token = "t".repeat(40);
    let rig = Rig::new(&[
        ("RAMPSMITH_MASTER_KEYS", master.as_str()),
        ("RAMPSMITH_SCAN_SECRET_KEYS", scan.as_str()),
        ("FREE_SCAN_SERVICE_TOKEN", token.as_str()),
    ])
    .await;
    let outcome = rig.run("master-keys.round-trip").await;
    pass(&outcome);
}

#[tokio::test]
async fn a_scan_ring_that_is_malformed_or_shares_a_master_key_fails() {
    let master = master_ring();
    let rig = Rig::new(&[
        ("RAMPSMITH_MASTER_KEYS", master.as_str()),
        ("RAMPSMITH_SCAN_SECRET_KEYS", "s1:short"),
    ])
    .await;
    let outcome = rig.run("master-keys.round-trip").await;
    assert!(fail(&outcome).contains("RAMPSMITH_SCAN_SECRET_KEYS does not parse"));

    let rig = Rig::new(&[
        ("RAMPSMITH_MASTER_KEYS", master.as_str()),
        ("RAMPSMITH_SCAN_SECRET_KEYS", master.as_str()),
    ])
    .await;
    let outcome = rig.run("master-keys.round-trip").await;
    assert!(fail(&outcome).contains("shares a key with RAMPSMITH_MASTER_KEYS"));
}

#[tokio::test]
async fn a_short_service_token_fails() {
    let master = master_ring();
    let rig = Rig::new(&[
        ("RAMPSMITH_MASTER_KEYS", master.as_str()),
        ("FREE_SCAN_SERVICE_TOKEN", "too-short"),
    ])
    .await;
    let outcome = rig.run("master-keys.round-trip").await;
    assert!(fail(&outcome).contains("shorter than 32 characters"));
}

#[tokio::test]
async fn an_unsubscribe_link_ring_must_parse_and_be_separate_from_the_other_rings() {
    let master = master_ring();
    let scan = scan_ring();
    let link = scan_ring();
    let rig = Rig::new(&[
        ("RAMPSMITH_MASTER_KEYS", master.as_str()),
        ("RAMPSMITH_SCAN_SECRET_KEYS", scan.as_str()),
        ("EMAIL_LINK_KEYS", link.as_str()),
    ])
    .await;
    pass(&rig.run("master-keys.round-trip").await);

    let rig = Rig::new(&[
        ("RAMPSMITH_MASTER_KEYS", master.as_str()),
        ("EMAIL_LINK_KEYS", "e1:short"),
    ])
    .await;
    assert!(
        fail(&rig.run("master-keys.round-trip").await).contains("EMAIL_LINK_KEYS does not parse")
    );

    for shared in [master.as_str(), scan.as_str()] {
        let rig = Rig::new(&[
            ("RAMPSMITH_MASTER_KEYS", master.as_str()),
            ("RAMPSMITH_SCAN_SECRET_KEYS", scan.as_str()),
            ("EMAIL_LINK_KEYS", shared),
        ])
        .await;
        let outcome = rig.run("master-keys.round-trip").await;
        let detail = fail(&outcome);
        assert!(
            detail.contains("EMAIL_LINK_KEYS shares a key") && !detail.contains(shared),
            "{detail}"
        );
    }
}
