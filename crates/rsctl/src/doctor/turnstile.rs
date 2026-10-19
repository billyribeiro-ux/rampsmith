//! C row 6, Turnstile: the secret key verifies tokens (ADR-152).
//!
//! `POST /turnstile/v0/siteverify` with the secret and a response token that cannot be valid.
//! Cloudflare documents `invalid-input-secret` for a wrong secret and `invalid-input-response`
//! for a bad token, so a real secret answers the second and a wrong one the first, with no
//! widget and no human.

use reqwest::Method;
use serde::Deserialize;

use super::common::{Step, gather, request, send, status_text};
use super::{Ctx, ProbeFuture};
use crate::report::{Outcome, Target};
use crate::util::safe_token;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[Var::TurnstileSiteKey, Var::TurnstileSecretKey];

/// A response token no widget produced.
const BOGUS_RESPONSE: &str = "rsctl-doctor-not-a-real-token";

#[derive(Deserialize)]
struct Verdict {
    success: bool,
    #[serde(default, rename = "error-codes")]
    error_codes: Vec<String>,
}

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).await.unwrap_or_else(|outcome| outcome) })
}

/// Cloudflare's documented dummy secrets (`1x`, `2x`, `3x` followed by zeros and `AA`): they
/// accept, reject or replay every token whatever the widget is.
fn is_testing_secret(secret: &str) -> bool {
    let mut chars = secret.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some('1' | '2' | '3'), Some('x'))
    ) && secret.len() >= 20
        && secret.ends_with("AA")
        && secret
            .get(2..secret.len() - 2)
            .is_some_and(|middle| middle.chars().all(|c| c == '0'))
}

async fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(ctx, 6, READS)?;
    let secret = inputs.text(Var::TurnstileSecretKey);
    if is_testing_secret(secret) && ctx.options.target == Target::Production {
        return Ok(Outcome::fail(
            "TURNSTILE_SECRET_KEY is one of Cloudflare's documented testing secrets, which verifies nothing real; create the production widget's secret",
        ));
    }
    let url = format!(
        "{}/turnstile/v0/siteverify",
        ctx.endpoints.turnstile.trim_end_matches('/')
    );
    let builder =
        request(ctx, Method::POST, &url)?.form(&[("secret", secret), ("response", BOGUS_RESPONSE)]);
    let reply = send(ctx, "Turnstile", builder).await?;
    let Some(verdict) = reply.json::<Verdict>() else {
        return Ok(Outcome::fail(format!(
            "siteverify answered {} without the documented JSON body",
            status_text(reply.status, None)
        )));
    };
    let has = |code: &str| verdict.error_codes.iter().any(|c| c == code);
    if verdict.success {
        return Ok(Outcome::fail(
            "siteverify accepted a token no widget produced: the secret is a testing secret, not a real widget's",
        ));
    }
    if has("invalid-input-secret") || has("missing-input-secret") {
        return Ok(Outcome::fail(
            "Turnstile rejected the secret key (invalid-input-secret)",
        ));
    }
    if has("invalid-input-response") {
        return Ok(Outcome::pass(
            "the secret key is accepted: siteverify rejected a made-up token as invalid-input-response, as documented",
        ));
    }
    let codes = verdict
        .error_codes
        .iter()
        .map(|code| safe_token(code))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(Outcome::fail(format!(
        "siteverify gave no verdict on the secret ({}; codes: {})",
        status_text(reply.status, None),
        if codes.is_empty() { "none" } else { &codes }
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn testing_secrets_are_recognised() {
        assert!(is_testing_secret("1x0000000000000000000000000000000AA"));
        assert!(is_testing_secret("2x0000000000000000000000000000000AA"));
        assert!(is_testing_secret("3x0000000000000000000000000000000AA"));
        assert!(!is_testing_secret(
            "0x4AAAAAAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        ));
        assert!(!is_testing_secret("1x"));
        assert!(!is_testing_secret("1x0000000000000000000000000001000AA"));
    }
}
