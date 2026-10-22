//! C row 16: the inputs of the nightly backup service and the weekly restore drill that no
//! vendor can confirm, checked for shape (ADR-091, ADR-093). No network: the backup service runs
//! on Railway's private network, so only the service itself can try the database password, and
//! only the first nightly run (LAUNCH.md section E) proves the recipients and the drill's key
//! fit together.
//!
//! The R2 tokens of this row have their own checks in [`super::r2`].
//!
//! The drill's private key is optional here: the weekly live drill restores *staging* backups
//! with a staging-only key, and production's private key stays offline (ADR-173), so a run
//! against production's inputs has none to check.

use std::collections::BTreeSet;

use super::common::{Step, gather};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[
    Var::BackupDbPassword,
    Var::BackupAgeRecipients,
    Var::BackupDrillAgeKey,
];

/// The shortest database password accepted: `openssl rand -base64 24` makes 32 characters.
const MIN_PASSWORD: usize = 20;

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).unwrap_or_else(|outcome| outcome) })
}

/// `age1` followed by lower-case letters and digits, as `backup.sh` accepts.
fn recipient_ok(entry: &str) -> bool {
    entry.strip_prefix("age1").is_some_and(|rest| {
        rest.len() >= 50
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    })
}

/// The recipients of `BACKUP_AGE_RECIPIENTS`: one per line, `#` starts a comment.
fn recipients(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| {
            line.split('#')
                .next()
                .unwrap_or_default()
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
        })
        .filter(|line| !line.is_empty())
        .collect()
}

/// An age identity: one line of `AGE-SECRET-KEY-1` and 58 upper-case Bech32 characters. The
/// comment lines `age-keygen` writes around it (`# created: ...`) are allowed.
fn identity_ok(text: &str) -> bool {
    let mut lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'));
    let (Some(key), None) = (lines.next(), lines.next()) else {
        return false;
    };
    key.strip_prefix("AGE-SECRET-KEY-1").is_some_and(|rest| {
        rest.len() == 58
            && rest
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    })
}

fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(ctx, 16, &[Var::BackupDbPassword, Var::BackupAgeRecipients])?;

    let password = inputs.text(Var::BackupDbPassword);
    if password.chars().count() < MIN_PASSWORD || password.chars().any(char::is_whitespace) {
        return Ok(Outcome::fail(format!(
            "BACKUP_DB_PASSWORD must be at least {MIN_PASSWORD} characters with no spaces (make one with `openssl rand -base64 24`)"
        )));
    }

    let text = inputs.text(Var::BackupAgeRecipients);
    if text.contains("AGE-SECRET-KEY-") || text.contains("AGE-PLUGIN-") {
        return Ok(Outcome::fail(
            "BACKUP_AGE_RECIPIENTS holds a private key; it must hold only public recipients (age1...)",
        ));
    }
    let list = recipients(text);
    if let Some(position) = list.iter().position(|entry| !recipient_ok(entry)) {
        return Ok(Outcome::fail(format!(
            "BACKUP_AGE_RECIPIENTS entry {} is not an age public key (age1 and lower-case letters and digits)",
            position + 1
        )));
    }
    let distinct: BTreeSet<&String> = list.iter().collect();
    let post_quantum = list
        .iter()
        .filter(|entry| entry.starts_with("age1pq1"))
        .count();
    if post_quantum != 0 && post_quantum != list.len() {
        return Ok(Outcome::fail(
            "BACKUP_AGE_RECIPIENTS mixes post-quantum (age1pq1...) and classic (age1...) recipients; age refuses both in one file",
        ));
    }
    if distinct.len() < 2 {
        return Ok(Outcome::fail(
            "BACKUP_AGE_RECIPIENTS holds fewer than two different recipients: losing the one key loses every backup, so add a second, offline recipient (ADR-173)",
        ));
    }

    let drill_key = ctx.vars.get(Var::BackupDrillAgeKey);
    if let Some(key) = &drill_key
        && !identity_ok(key)
    {
        return Ok(Outcome::fail(
            "BACKUP_DRILL_AGE_KEY is not an age private key (AGE-SECRET-KEY-1 and 58 characters)",
        ));
    }
    let drill = if drill_key.is_some() {
        "a drill key"
    } else {
        "no drill key (staging only)"
    };
    Ok(Outcome::pass(format!(
        "{} age recipients and a database password, {drill}, all well formed (the first nightly run and the live restore drill prove they fit)",
        distinct.len()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC: &str = "age17prg4nysv8q4w5m3tl4dr49m7m4s98vt38pjd68xykpugw8qa3dqfqxq5n";

    #[test]
    fn recipients_are_one_per_line_and_comments_are_dropped() {
        let text = format!(
            "# primary\n{PUBLIC}  # laptop\n\n  age1other0000000000000000000000000000000000000000000000000\n"
        );
        let list = recipients(&text);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], PUBLIC);
        assert!(list.iter().all(|entry| recipient_ok(entry)));
    }

    #[test]
    fn recipient_and_identity_shapes() {
        assert!(recipient_ok(PUBLIC));
        assert!(!recipient_ok("age1short"));
        assert!(!recipient_ok(&PUBLIC.to_uppercase()));
        assert!(!recipient_ok("ssh-ed25519 AAAA"));
        let key = format!("AGE-SECRET-KEY-1{}", "Q".repeat(58));
        assert!(identity_ok(&key));
        assert!(identity_ok(&format!(
            "# created: 2026-10-19\n# public key: {PUBLIC}\n{key}\n"
        )));
        assert!(
            !identity_ok(&format!("{key}\n{key}")),
            "one identity, not two"
        );
        assert!(!identity_ok("# only comments"));
        assert!(!identity_ok(&key[..70]));
        assert!(!identity_ok(&PUBLIC.to_uppercase()));
    }
}
