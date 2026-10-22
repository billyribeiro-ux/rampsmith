//! C row 16: the backup service's database password, the age recipients, and the restore
//! drill's private key, checked for shape (ADR-254). No network.

use crate::support::{Rig, fail, pass, skip_missing};

const PASSWORD: &str = "ECHOME-database-password-0123456789";
const PRIMARY: &str = "age17prg4nysv8q4w5m3tl4dr49m7m4s98vt38pjd68xykpugw8qa3dqfqxq5n";
const OFFLINE: &str = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
// Shaped like an age private key (a synthetic value, not a real key).
const IDENTITY: &str = "AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE";

fn recipients() -> String {
    format!("# primary, in the password manager\n{PRIMARY}\n# offline, in the safe\n{OFFLINE}\n")
}

fn env_with<'a>(
    recipients: &'a str,
    password: &'a str,
    identity: &'a str,
) -> Vec<(&'a str, &'a str)> {
    vec![
        ("BACKUP_DB_PASSWORD", password),
        ("BACKUP_AGE_RECIPIENTS", recipients),
        ("BACKUP_DRILL_AGE_KEY", identity),
    ]
}

pub fn vars() -> Vec<(&'static str, String)> {
    vec![
        ("BACKUP_DB_PASSWORD", PASSWORD.to_owned()),
        ("BACKUP_AGE_RECIPIENTS", recipients()),
        ("BACKUP_DRILL_AGE_KEY", IDENTITY.to_owned()),
    ]
}

#[tokio::test]
async fn well_formed_inputs_pass_without_a_request() {
    let text = recipients();
    let rig = Rig::new(&env_with(&text, PASSWORD, IDENTITY)).await;
    let outcome = rig.run("backup.inputs").await;
    let detail = pass(&outcome);
    assert!(detail.contains("2 age recipients"), "{detail}");
    for secret in [PASSWORD, IDENTITY] {
        assert!(!detail.contains(secret), "{detail}");
    }
    assert!(rig.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_short_or_spaced_password_fails_without_printing_it() {
    let text = recipients();
    for password in ["short", "has a space in it 0123456789"] {
        let rig = Rig::new(&env_with(&text, password, IDENTITY)).await;
        let outcome = rig.run("backup.inputs").await;
        let detail = fail(&outcome);
        assert!(detail.contains("BACKUP_DB_PASSWORD"), "{detail}");
        assert!(!detail.contains(password), "{detail}");
    }
}

#[tokio::test]
async fn a_private_key_among_the_recipients_is_refused() {
    let text = format!("{PRIMARY}\n{IDENTITY}\n");
    let rig = Rig::new(&env_with(&text, PASSWORD, IDENTITY)).await;
    let outcome = rig.run("backup.inputs").await;
    let detail = fail(&outcome);
    assert!(detail.contains("holds a private key"), "{detail}");
    assert!(!detail.contains("QPZRY9X8"), "{detail}");
}

#[tokio::test]
async fn one_recipient_is_not_enough_and_a_malformed_one_is_named_by_position() {
    let one = format!("{PRIMARY}\n{PRIMARY}\n");
    let rig = Rig::new(&env_with(&one, PASSWORD, IDENTITY)).await;
    let outcome = rig.run("backup.inputs").await;
    assert!(fail(&outcome).contains("fewer than two different recipients"));

    let bad = format!("{PRIMARY}\nnot-a-recipient\n");
    let rig = Rig::new(&env_with(&bad, PASSWORD, IDENTITY)).await;
    let outcome = rig.run("backup.inputs").await;
    assert!(fail(&outcome).contains("entry 2 is not an age public key"));
}

#[tokio::test]
async fn post_quantum_and_classic_recipients_do_not_mix() {
    let pq = format!("age1pq1{}", "q".repeat(60));
    let text = format!("{PRIMARY}\n{pq}\n");
    let rig = Rig::new(&env_with(&text, PASSWORD, IDENTITY)).await;
    let outcome = rig.run("backup.inputs").await;
    assert!(fail(&outcome).contains("mixes post-quantum"));
}

#[tokio::test]
async fn a_malformed_drill_key_fails_without_printing_it() {
    let text = recipients();
    let rig = Rig::new(&env_with(&text, PASSWORD, "AGE-SECRET-KEY-1TOOSHORT")).await;
    let outcome = rig.run("backup.inputs").await;
    let detail = fail(&outcome);
    assert!(detail.contains("BACKUP_DRILL_AGE_KEY"), "{detail}");
    assert!(!detail.contains("TOOSHORT"), "{detail}");
}

#[tokio::test]
async fn the_drill_key_is_optional_because_production_keeps_its_private_key_offline() {
    let text = recipients();
    let rig = Rig::new(&[
        ("BACKUP_DB_PASSWORD", PASSWORD),
        ("BACKUP_AGE_RECIPIENTS", text.as_str()),
    ])
    .await;
    let outcome = rig.run("backup.inputs").await;
    let detail = pass(&outcome);
    assert!(detail.contains("no drill key (staging only)"), "{detail}");
}

#[tokio::test]
async fn nothing_set_skips_and_half_set_names_the_rest() {
    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("backup.inputs").await).contains("C row 16"));

    let rig = Rig::new(&[("BACKUP_DB_PASSWORD", PASSWORD)]).await;
    let outcome = rig.run("backup.inputs").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("incomplete") && detail.contains("BACKUP_AGE_RECIPIENTS"),
        "{detail}"
    );
}

const SIGNING: &str = "MC4CAQAwBQYDK2VwBCIEIECHOSIGNINGKEYSYNTHETICVALUE0123456789abcde";

#[tokio::test]
async fn a_well_formed_signing_key_passes_and_is_never_printed() {
    assert_eq!(SIGNING.len(), 64);
    let text = recipients();
    let rig = Rig::new(&[
        ("BACKUP_DB_PASSWORD", PASSWORD),
        ("BACKUP_AGE_RECIPIENTS", text.as_str()),
        ("BACKUP_SIGNING_KEY", SIGNING),
    ])
    .await;
    let outcome = rig.run("backup.inputs").await;
    let detail = pass(&outcome);
    assert!(detail.contains("a signing key"), "{detail}");
    assert!(!detail.contains(SIGNING), "{detail}");
}

#[tokio::test]
async fn a_malformed_signing_key_fails_without_printing_it() {
    let text = recipients();
    for key in ["MC4CAQAwBQYDK2VwBCIEIshort", "-----BEGIN PRIVATE KEY-----"] {
        let rig = Rig::new(&[
            ("BACKUP_DB_PASSWORD", PASSWORD),
            ("BACKUP_AGE_RECIPIENTS", text.as_str()),
            ("BACKUP_SIGNING_KEY", key),
        ])
        .await;
        let outcome = rig.run("backup.inputs").await;
        let detail = fail(&outcome);
        assert!(detail.contains("BACKUP_SIGNING_KEY"), "{detail}");
        assert!(!detail.contains(key), "{detail}");
    }
}
