//! `rsctl shops redact`: completes a shop's redaction on an operator's say-so (re-audit M-2,
//! ADR-269).
//!
//! `shop/redact` redacts a shop only after Shopify has confirmed the grant is gone. A store
//! that Shopify answers with 402 or 423 for weeks, or that no longer exists, can leave that
//! check undecided past the 45 days the sweep keeps trying, and PLAN §19 gives 30 days. A
//! person confirms in the Partner Dashboard that the app is uninstalled, then runs this from
//! inside `ctl`'s private network (`railway ssh --service ctl`; docs/runbooks/webhook-backlog.md)
//! as ctl's own database login, because only that login may delete AI call records.
//!
//! It reads `DATABASE_URL` and nothing else, refuses any login that is not ctl's (the same
//! check `ctl` makes at startup), shows what it would do unless `--execute` is given, and
//! records `compliance.shop_redacted_by_operator` with who confirmed what. It never asks
//! Shopify anything and never prints the URL.

use db::repo::redact::{self, OperatorRedactError};
use db::{Db, RoleError, RuntimeRole};

use crate::app::{EXIT_FAILED, EXIT_OK, EXIT_UNUSABLE, Io, Runtime};
use crate::cli::ShopRedactArgs;
use crate::secret::{Redactor, Secret};

/// The longest `--confirmed-by` or `--evidence` text. They are kept in the audit log.
const MAX_NOTE: usize = 200;

/// Runs `rsctl shops redact`.
pub async fn redact_command(args: &ShopRedactArgs, runtime: &Runtime, io: &mut Io<'_>) -> u8 {
    let redactor = Redactor::new();
    let Some(url) = runtime.env.get("DATABASE_URL").filter(|u| !u.is_empty()) else {
        return unusable(
            io,
            &redactor,
            "DATABASE_URL is not set: run this inside ctl's service (`railway ssh --service ctl`), \
             where it is ctl's own login",
        );
    };
    redactor.register(&Secret::new(url.as_str()));
    if let Some(password) = url
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('@'))
        .and_then(|(credentials, _)| credentials.split_once(':'))
        .map(|(_, password)| password)
    {
        redactor.register(&Secret::new(password));
    }
    let db = match Db::connect_lazy(&url, 2) {
        Ok(db) => db,
        Err(error) => {
            return unusable(io, &redactor, &format!("cannot use DATABASE_URL: {error}"));
        }
    };
    run(args, &db, &redactor, io).await
}

/// The command over an open [`Db`], so tests can drive it with a role they made.
pub async fn run(args: &ShopRedactArgs, db: &Db, redactor: &Redactor, io: &mut Io<'_>) -> u8 {
    let Ok(shop) = shopify::ShopDomain::parse(args.shop.trim()) else {
        return unusable(
            io,
            redactor,
            "--shop must be the shop's `*.myshopify.com` domain",
        );
    };
    for (flag, text) in [
        ("--confirmed-by", &args.confirmed_by),
        ("--evidence", &args.evidence),
    ] {
        let text = text.trim();
        if text.is_empty() || text.chars().count() > MAX_NOTE || text.chars().any(char::is_control)
        {
            return unusable(
                io,
                redactor,
                &format!("{flag} must be 1 to {MAX_NOTE} printable characters"),
            );
        }
    }
    match db.verify_runtime_role(RuntimeRole::Ctl).await {
        Ok(()) => {}
        Err(RoleError::Refused { role, violations }) => {
            let reasons = violations
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("; ");
            return unusable(
                io,
                redactor,
                &format!(
                    "refusing to run as database role `{role}`: {reasons}. Use ctl's own login \
                     (rampsmith_ctl)"
                ),
            );
        }
        Err(RoleError::Unreachable(error)) => {
            return unusable(io, redactor, &format!("cannot reach the database: {error}"));
        }
    }
    let found = match db.shop_by_domain(shop.as_str()).await {
        Ok(Some(found)) => found,
        Ok(None) => {
            return failed(io, redactor, "no shop has this domain; nothing was changed");
        }
        Err(error) => return unusable(io, redactor, &format!("database error: {error}")),
    };
    if !args.execute {
        let _ = writeln!(
            io.stdout,
            "{}: status `{}`. Would end the installation if needed, delete the shop's data and \
             record the confirmation by `{}`. Nothing was changed; add --execute to do it.",
            shop.as_str(),
            found.status.as_str(),
            args.confirmed_by.trim(),
        );
        return EXIT_OK;
    }
    match redact::complete_by_operator(
        db,
        shop.as_str(),
        args.confirmed_by.trim(),
        args.evidence.trim(),
    )
    .await
    {
        Ok(done) => {
            let _ = writeln!(
                io.stdout,
                "{}: redacted (was `{}`). Removed: {}",
                shop.as_str(),
                done.was,
                serde_json::to_string(&done.removed).unwrap_or_default(),
            );
            EXIT_OK
        }
        Err(OperatorRedactError::AlreadyRedacted) => {
            failed(io, redactor, "the shop is already redacted; nothing to do")
        }
        Err(OperatorRedactError::UnknownShop) => {
            failed(io, redactor, "no shop has this domain; nothing was changed")
        }
        Err(OperatorRedactError::Database(error)) => {
            unusable(io, redactor, &format!("database error: {error}"))
        }
    }
}

fn say(io: &mut Io<'_>, redactor: &Redactor, text: &str) {
    // A closed standard error leaves nowhere to report to.
    let _ = writeln!(io.stderr, "rsctl: {}", redactor.scrub(text));
}

fn unusable(io: &mut Io<'_>, redactor: &Redactor, text: &str) -> u8 {
    say(io, redactor, text);
    EXIT_UNUSABLE
}

fn failed(io: &mut Io<'_>, redactor: &Redactor, text: &str) -> u8 {
    say(io, redactor, text);
    EXIT_FAILED
}
