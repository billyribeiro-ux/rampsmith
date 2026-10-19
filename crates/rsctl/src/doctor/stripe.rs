//! C row 11: the Stripe secret key retrieves the account (ADR-152).
//!
//! `GET /v1/account` with the secret key as a bearer token. The publishable key and webhook
//! secret have no read endpoint, so only their documented shapes are checked: the publishable
//! key must be in the same mode as the secret key, and the signing secret starts `whsec_`.

use reqwest::Method;
use serde::Deserialize;

use super::common::{
    Step, bad_header, error_code, gather, header_safe, request, send, status_text,
};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::util::safe_token;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[
    Var::StripeSecretKey,
    Var::StripePublishableKey,
    Var::StripeWebhookSecret,
];

#[derive(Deserialize)]
struct Account {
    id: String,
}

/// `test` or `live` from a key prefix such as `sk_test_`, `rk_live_` or `pk_test_`.
fn mode(key: &str, kinds: &[&str]) -> Option<&'static str> {
    kinds.iter().find_map(|kind| {
        if key.starts_with(&format!("{kind}_test_")) {
            Some("test")
        } else if key.starts_with(&format!("{kind}_live_")) {
            Some("live")
        } else {
            None
        }
    })
}

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).await.unwrap_or_else(|outcome| outcome) })
}

async fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(ctx, 11, READS)?;
    let secret = inputs.text(Var::StripeSecretKey);
    if !header_safe(secret) {
        return Err(bad_header("STRIPE_SECRET_KEY"));
    }
    let Some(secret_mode) = mode(secret, &["sk", "rk"]) else {
        return Ok(Outcome::fail(
            "STRIPE_SECRET_KEY is not a Stripe secret or restricted key (it should start sk_test_, sk_live_, rk_test_ or rk_live_)",
        ));
    };
    let Some(publishable_mode) = mode(inputs.text(Var::StripePublishableKey), &["pk"]) else {
        return Ok(Outcome::fail(
            "STRIPE_PUBLISHABLE_KEY is not a Stripe publishable key (it should start pk_test_ or pk_live_)",
        ));
    };
    if publishable_mode != secret_mode {
        return Ok(Outcome::fail(format!(
            "STRIPE_SECRET_KEY is a {secret_mode}-mode key but STRIPE_PUBLISHABLE_KEY is {publishable_mode}-mode"
        )));
    }
    if !inputs.text(Var::StripeWebhookSecret).starts_with("whsec_") {
        return Ok(Outcome::fail(
            "STRIPE_WEBHOOK_SECRET is not a webhook signing secret (it should start whsec_)",
        ));
    }

    let url = format!(
        "{}/v1/account",
        ctx.endpoints.stripe_api.trim_end_matches('/')
    );
    let builder = request(ctx, Method::GET, &url)?.bearer_auth(secret);
    let reply = send(ctx, "Stripe", builder).await?;
    if !reply.is_success() {
        let code = error_code(&reply.body);
        let meaning = if reply.status == 401 {
            " (the secret key was rejected)"
        } else {
            ""
        };
        return Ok(Outcome::fail(format!(
            "GET /v1/account failed: {}{meaning}",
            status_text(reply.status, code.as_deref())
        )));
    }
    let Some(account) = reply.json::<Account>() else {
        return Ok(Outcome::fail(
            "GET /v1/account answered 200 but not with an account object",
        ));
    };
    Ok(Outcome::pass(format!(
        "the secret key retrieves account {} ({secret_mode} mode); the publishable key and webhook secret have the right shape (Stripe offers no read call for them)",
        safe_token(&account.id)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_come_from_prefixes() {
        assert_eq!(mode("sk_test_abc", &["sk", "rk"]), Some("test"));
        assert_eq!(mode("rk_live_abc", &["sk", "rk"]), Some("live"));
        assert_eq!(mode("pk_test_abc", &["sk", "rk"]), None);
        assert_eq!(mode("pk_live_abc", &["pk"]), Some("live"));
        assert_eq!(mode("sk_abc", &["sk"]), None);
    }
}
