//! `rsctl keys generate | rotate | drop | ids`: the output format `crates/crypto` reads, the
//! stdout/stderr split, where the current ring may come from, and the output file rules.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    unreachable_pub
)]

use std::io::Cursor;
use std::process::{Command, Stdio};
use std::sync::Arc;

use clap::Parser as _;
use crypto::KeyRing;
use rsctl::app::{self, Io, Runtime};
use rsctl::cli::Cli;
use rsctl::doctor::Endpoints;
use rsctl::vars::MapEnv;
use time::{Date, Month, OffsetDateTime, Time};

fn day(month: Month, day: u8) -> OffsetDateTime {
    Date::from_calendar_date(2026, month, day)
        .unwrap()
        .with_time(Time::from_hms(9, 0, 0).unwrap())
        .assume_utc()
}

struct Run {
    code: u8,
    out: String,
    err: String,
}

/// Runs `rsctl <args>` in-process with `stdin` and the given environment.
async fn rsctl(args: &[&str], stdin: &str, env: &[(&str, &str)], at: OffsetDateTime) -> Run {
    let cli = Cli::try_parse_from(std::iter::once("rsctl").chain(args.iter().copied())).unwrap();
    let runtime = Runtime {
        env: Arc::new(MapEnv::from_pairs(env)),
        endpoints: Endpoints::default(),
        clock: Arc::new(move || at),
    };
    let mut stdin = Cursor::new(stdin.as_bytes().to_vec());
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = app::run(
        cli,
        runtime,
        &mut Io {
            stdin: &mut stdin,
            stdout: &mut out,
            stderr: &mut err,
        },
    )
    .await;
    Run {
        code,
        out: String::from_utf8(out).unwrap(),
        err: String::from_utf8(err).unwrap(),
    }
}

fn key_text(ring: &str) -> Vec<&str> {
    ring.trim()
        .split(',')
        .map(|entry| entry.split_once(':').unwrap().1)
        .collect()
}

#[tokio::test]
async fn generate_prints_one_ring_line_to_stdout_and_notes_only_to_stderr() {
    let run = rsctl(&["keys", "generate"], "", &[], day(Month::October, 19)).await;
    assert_eq!(run.code, 0, "{}", run.err);
    assert_eq!(run.out.lines().count(), 1, "{:?}", run.out);
    let ring = run.out.trim();
    assert!(ring.starts_with("k20261019:"), "{ring}");
    // The format and the key size are crates/crypto's own: it parses and uses the ring.
    let parsed = KeyRing::parse(ring).unwrap();
    assert_eq!(parsed.active().as_str(), "k20261019");
    let sealed = parsed.seal(b"token", b"ctx").unwrap();
    assert_eq!(
        parsed
            .open("k20261019", sealed.bytes(), b"ctx")
            .unwrap()
            .as_slice(),
        b"token"
    );
    // The note names the key id and never the key.
    assert!(
        run.err.contains("`k20261019`") && run.err.contains("RAMPSMITH_MASTER_KEYS"),
        "{}",
        run.err
    );
    for key in key_text(ring) {
        assert!(!run.err.contains(key), "{}", run.err);
    }
}

#[tokio::test]
async fn generate_makes_a_different_key_every_time_and_honours_an_id() {
    let one = rsctl(
        &["keys", "generate", "--id", "first"],
        "",
        &[],
        day(Month::October, 19),
    )
    .await;
    let two = rsctl(
        &["keys", "generate", "--id", "first"],
        "",
        &[],
        day(Month::October, 19),
    )
    .await;
    assert!(one.out.starts_with("first:") && two.out.starts_with("first:"));
    assert_ne!(one.out, two.out);
    let bad = rsctl(
        &["keys", "generate", "--id", "Not Valid"],
        "",
        &[],
        day(Month::October, 19),
    )
    .await;
    assert_eq!(bad.code, 1);
    assert!(
        bad.out.is_empty() && bad.err.contains("not a valid key id"),
        "{}",
        bad.err
    );
}

#[tokio::test]
async fn rotate_puts_a_fresh_key_first_and_keeps_the_old_ones_from_the_environment() {
    let old = rsctl(
        &["keys", "generate", "--id", "k1"],
        "",
        &[],
        day(Month::October, 19),
    )
    .await;
    let old_ring = old.out.trim().to_owned();
    let run = rsctl(
        &["keys", "rotate"],
        "",
        &[("RAMPSMITH_MASTER_KEYS", old_ring.as_str())],
        day(Month::November, 2),
    )
    .await;
    assert_eq!(run.code, 0, "{}", run.err);
    let new_ring = run.out.trim();
    assert_eq!(run.out.lines().count(), 1);
    assert!(new_ring.starts_with("k20261102:"), "{new_ring}");
    assert!(
        new_ring.ends_with(&format!(",{old_ring}")),
        "the old entry is kept verbatim: {new_ring}"
    );
    let parsed = KeyRing::parse(new_ring).unwrap();
    assert_eq!(parsed.active().as_str(), "k20261102");
    assert!(
        run.err.contains("`k20261102`") && run.err.contains("k1"),
        "{}",
        run.err
    );
    for key in key_text(new_ring) {
        assert!(!run.err.contains(key), "{}", run.err);
    }
}

#[tokio::test]
async fn rotate_reads_the_ring_from_stdin_when_asked() {
    let old = rsctl(
        &["keys", "generate", "--id", "k1"],
        "",
        &[],
        day(Month::October, 19),
    )
    .await;
    // `--stdin` wins over the environment, takes the first non-empty line and ignores the rest.
    let run = rsctl(
        &["keys", "rotate", "--stdin", "--id", "k2"],
        &format!("\n  {}  \nignored line\n", old.out.trim()),
        &[("RAMPSMITH_MASTER_KEYS", "k9:ignored")],
        day(Month::November, 2),
    )
    .await;
    assert_eq!(run.code, 0, "{}", run.err);
    assert!(
        run.out.starts_with("k2:") && run.out.contains(",k1:"),
        "{}",
        run.out
    );
}

#[tokio::test]
async fn rotating_twice_in_a_day_does_not_reuse_the_id() {
    let one = rsctl(&["keys", "generate"], "", &[], day(Month::October, 19)).await;
    let two = rsctl(
        &["keys", "rotate", "--stdin"],
        &one.out,
        &[],
        day(Month::October, 19),
    )
    .await;
    assert_eq!(two.code, 0, "{}", two.err);
    assert!(two.out.starts_with("k20261019-2:"), "{}", two.out);
    let clash = rsctl(
        &["keys", "rotate", "--stdin", "--id", "k20261019"],
        &one.out,
        &[],
        day(Month::October, 19),
    )
    .await;
    assert_eq!(clash.code, 1);
    assert!(
        clash.err.contains("already in the ring") && clash.out.is_empty(),
        "{}",
        clash.err
    );
}

#[tokio::test]
async fn a_value_sealed_under_the_old_ring_survives_rotation_rewrap_and_drop() {
    let old = rsctl(
        &["keys", "generate", "--id", "k1"],
        "",
        &[],
        day(Month::October, 19),
    )
    .await;
    let old_ring = KeyRing::parse(old.out.trim()).unwrap();
    let sealed = old_ring
        .seal(b"shpat_token", b"shopify_tokens/access/1")
        .unwrap();

    let rotated = rsctl(
        &["keys", "rotate", "--stdin", "--id", "k2"],
        &old.out,
        &[],
        day(Month::November, 2),
    )
    .await;
    let ring = KeyRing::parse(rotated.out.trim()).unwrap();
    // The rotated ring still opens the old value, and says it needs re-wrapping.
    assert_eq!(
        ring.open("k1", sealed.bytes(), b"shopify_tokens/access/1")
            .unwrap()
            .as_slice(),
        b"shpat_token"
    );
    assert!(ring.needs_rewrap("k1"));
    let rewrapped = ring
        .rewrap("k1", sealed.bytes(), b"shopify_tokens/access/1")
        .unwrap();
    assert_eq!(rewrapped.key_id().as_str(), "k2");

    // Dropping the old key afterwards: the re-wrapped value opens, the original does not.
    let dropped = rsctl(
        &["keys", "drop", "--id", "k1", "--stdin"],
        &rotated.out,
        &[],
        day(Month::November, 30),
    )
    .await;
    assert_eq!(dropped.code, 0, "{}", dropped.err);
    let after = KeyRing::parse(dropped.out.trim()).unwrap();
    assert_eq!(
        after
            .open("k2", rewrapped.bytes(), b"shopify_tokens/access/1")
            .unwrap()
            .as_slice(),
        b"shpat_token"
    );
    assert!(
        after
            .open("k1", sealed.bytes(), b"shopify_tokens/access/1")
            .is_err()
    );
}

#[tokio::test]
async fn drop_refuses_the_active_key_and_unknown_ids() {
    let ring = rsctl(
        &["keys", "generate", "--id", "k1"],
        "",
        &[],
        day(Month::October, 19),
    )
    .await;
    let active = rsctl(
        &["keys", "drop", "--id", "k1", "--stdin"],
        &ring.out,
        &[],
        day(Month::October, 19),
    )
    .await;
    assert_eq!(active.code, 1);
    assert!(
        active.err.contains("active key") && active.out.is_empty(),
        "{}",
        active.err
    );
    let unknown = rsctl(
        &["keys", "drop", "--id", "nope", "--stdin"],
        &ring.out,
        &[],
        day(Month::October, 19),
    )
    .await;
    assert_eq!(unknown.code, 1);
    assert!(unknown.err.contains("not in the ring"), "{}", unknown.err);
}

#[tokio::test]
async fn ids_lists_newest_first_and_prints_no_key() {
    let one = rsctl(
        &["keys", "generate", "--id", "k1"],
        "",
        &[],
        day(Month::October, 19),
    )
    .await;
    let two = rsctl(
        &["keys", "rotate", "--stdin", "--id", "k2"],
        &one.out,
        &[],
        day(Month::October, 20),
    )
    .await;
    let ids = rsctl(
        &["keys", "ids"],
        "",
        &[("RAMPSMITH_MASTER_KEYS", two.out.trim())],
        day(Month::October, 21),
    )
    .await;
    assert_eq!(ids.code, 0);
    assert_eq!(ids.out, "k2\nk1\n");
    for key in key_text(&two.out) {
        assert!(!ids.out.contains(key) && !ids.err.contains(key));
    }
}

#[tokio::test]
async fn no_ring_to_read_is_a_usage_failure_with_a_pointer() {
    let none = rsctl(&["keys", "rotate"], "", &[], day(Month::October, 19)).await;
    assert_eq!(none.code, 2);
    assert!(
        none.err.contains("RAMPSMITH_MASTER_KEYS") && none.err.contains("--stdin"),
        "{}",
        none.err
    );
    assert_eq!(none.out, "");

    let empty = rsctl(
        &["keys", "rotate", "--stdin"],
        "  \n\n",
        &[],
        day(Month::October, 19),
    )
    .await;
    assert_eq!(empty.code, 2);
    assert!(empty.err.contains("held no key ring"), "{}", empty.err);
}

#[tokio::test]
async fn a_broken_ring_is_refused_without_echoing_the_key() {
    let key = KeyRing::generate_master_key().unwrap();
    for bad in [
        format!("k1:{key},k1:{key}"),
        format!("K1:{key}"),
        format!("k1:{key}zz"),
    ] {
        let run = rsctl(
            &["keys", "rotate", "--stdin"],
            &bad,
            &[],
            day(Month::October, 19),
        )
        .await;
        assert_eq!(run.code, 1, "{bad}");
        assert_eq!(run.out, "", "no ring is printed for a broken one");
        assert!(run.err.contains("rsctl:"), "{}", run.err);
        assert!(!run.err.contains(&key), "{}", run.err);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn output_files_are_owner_only_and_never_overwritten() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = std::env::temp_dir().join(format!("rsctl-keys-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("ring.txt");
    let path = file.to_str().unwrap();

    let run = rsctl(
        &["keys", "generate", "--output", path],
        "",
        &[],
        day(Month::October, 19),
    )
    .await;
    assert_eq!(run.code, 0, "{}", run.err);
    assert!(
        run.out.is_empty(),
        "nothing on stdout when a file is written"
    );
    let written = std::fs::read_to_string(&file).unwrap();
    assert!(KeyRing::parse(written.trim()).is_ok());
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    for key in key_text(&written) {
        assert!(!run.err.contains(key), "{}", run.err);
    }

    let again = rsctl(
        &["keys", "generate", "--output", path],
        "",
        &[],
        day(Month::October, 19),
    )
    .await;
    assert_eq!(again.code, 2);
    assert!(again.err.contains("never overwrites"), "{}", again.err);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        written,
        "the file is untouched"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

// ---- The real binary ----------------------------------------------------------------------

fn binary() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rsctl"));
    command.env_clear();
    command
}

#[test]
fn the_binary_prints_the_ring_on_stdout_only() {
    let output = binary().args(["keys", "generate"]).output().unwrap();
    assert!(output.status.success());
    let out = String::from_utf8(output.stdout).unwrap();
    let err = String::from_utf8(output.stderr).unwrap();
    assert_eq!(out.lines().count(), 1);
    assert!(KeyRing::parse(out.trim()).is_ok());
    for key in key_text(&out) {
        assert!(!err.contains(key));
    }
}

#[test]
fn the_binary_rotates_from_stdin_and_from_the_environment() {
    let generated = binary()
        .args(["keys", "generate", "--id", "k1"])
        .output()
        .unwrap();
    let old = String::from_utf8(generated.stdout).unwrap();

    let mut child = binary()
        .args(["keys", "rotate", "--stdin", "--id", "k2"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write as _;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(old.as_bytes())
            .unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let via_stdin = String::from_utf8(output.stdout).unwrap();
    assert!(via_stdin.starts_with("k2:") && via_stdin.trim().ends_with(old.trim()));

    let output = binary()
        .args(["keys", "rotate", "--id", "k3"])
        .env("RAMPSMITH_MASTER_KEYS", old.trim())
        .output()
        .unwrap();
    assert!(output.status.success());
    let via_env = String::from_utf8(output.stdout).unwrap();
    assert!(via_env.starts_with("k3:") && via_env.trim().ends_with(old.trim()));
}

#[test]
fn the_binary_reports_usage_errors_with_exit_code_2() {
    for args in [
        vec!["nope"],
        vec!["keys"],
        vec!["doctor", "--row", "99"],
        vec!["doctor", "--environment", "moon"],
        vec![],
    ] {
        let output = binary().args(&args).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert_eq!(output.stdout, Vec::<u8>::new(), "{args:?}");
    }
    let help = binary().arg("--help").output().unwrap();
    assert!(help.status.success());
    let text = String::from_utf8(help.stdout).unwrap();
    assert!(text.contains("doctor") && text.contains("keys"), "{text}");
}

#[test]
fn the_binary_doctor_with_no_inputs_skips_every_row_and_exits_0_or_1_under_strict() {
    let output = binary().arg("doctor").output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let text = String::from_utf8(output.stdout).unwrap();
    assert_eq!(
        text.lines().filter(|l| l.starts_with("SKIP")).count(),
        20,
        "{text}"
    );
    assert!(text.contains("0 passed, 0 failed, 20 skipped"), "{text}");
    for row in (1..=12).chain([16]) {
        assert!(
            text.contains(&format!("(C row {row})")),
            "no line names row {row}:\n{text}"
        );
    }

    let strict = binary().args(["doctor", "--strict"]).output().unwrap();
    assert_eq!(strict.status.code(), Some(1));

    let json = binary().args(["doctor", "--json"]).output().unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(parsed["summary"]["skip"], 20);
    assert_eq!(parsed["ok"], true);
}

#[test]
fn the_binary_doctor_fails_a_present_input_that_does_not_work_without_printing_it() {
    // A master key ring that is present but wrong: no network needed.
    let output = binary()
        .args(["doctor", "--row", "12"])
        .env("RAMPSMITH_MASTER_KEYS", "k1:SECRETNEEDLE-not-a-key")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("FAIL  C12  master-keys.round-trip"), "{text}");
    assert!(
        !text.contains("SECRETNEEDLE")
            && !String::from_utf8_lossy(&output.stderr).contains("SECRETNEEDLE")
    );

    let ring = KeyRing::generate_master_key().unwrap();
    let output = binary()
        .args(["doctor", "--row", "12"])
        .env("RAMPSMITH_MASTER_KEYS", format!("k1:{ring}"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("PASS  C12  master-keys.round-trip")
    );
}

#[test]
fn the_panic_hook_prints_the_place_and_never_the_payload() {
    // The child is this test binary again, running only `panic_child` with the variable set.
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "panic_child", "--nocapture"])
        .env("RSCTL_PANIC_CHILD", "1")
        .output()
        .unwrap();
    assert!(!output.status.success(), "the child panics");
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(err.contains("rsctl: internal error at"), "{err}");
    assert!(err.contains("withheld"), "{err}");
    assert!(!err.contains("PAYLOAD-WITH-A-SECRET"), "{err}");
}

/// Run on its own it checks the notice's wording; as the child of the test above (with
/// `RSCTL_PANIC_CHILD` set) it installs the hook and panics with a payload that must not appear.
#[test]
fn panic_child() {
    if std::env::var_os("RSCTL_PANIC_CHILD").is_some() {
        app::install_panic_hook();
        panic!("PAYLOAD-WITH-A-SECRET");
    }
    assert_eq!(
        app::panic_notice(Some(("src/x.rs", 7))),
        "rsctl: internal error at src/x.rs:7; the details are withheld because they could contain a secret"
    );
    assert!(app::panic_notice(None).starts_with("rsctl: internal error;"));
}
