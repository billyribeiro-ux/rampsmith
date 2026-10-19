//! C row 3: the two development stores (ADR-152).
//!
//! `GET https://<shop>/password` is the storefront password page. A 200 means the store exists
//! and has a storefront password. Shopify documents no way to check the password itself
//! without submitting the storefront login form, so the probe says so and does not guess; the
//! dev-store end-to-end suite uses the password.

use reqwest::Method;

use super::common::{Step, gather, request, send, shop_base, status_text};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::util::safe_token;
use crate::vars::Var;

pub(super) const READS_A: &[Var] = &[Var::ShopifyDevStoreDomain, Var::ShopifyDevStorePassword];
pub(super) const READS_B: &[Var] = &[Var::ShopifyDevStoreBDomain, Var::ShopifyDevStoreBPassword];

pub(super) fn run_a(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move {
        probe(ctx, "A", READS_A)
            .await
            .unwrap_or_else(|outcome| outcome)
    })
}

pub(super) fn run_b(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move {
        probe(ctx, "B", READS_B)
            .await
            .unwrap_or_else(|outcome| outcome)
    })
}

async fn probe(ctx: &Ctx, label: &str, vars: &[Var]) -> Step<Outcome> {
    let inputs = gather(ctx, 3, vars)?;
    let (domain_var, password_var) = match vars {
        [domain, password] => (*domain, *password),
        _ => return Err(Outcome::fail("internal error: a store takes two inputs")),
    };
    let domain = inputs.text(domain_var);
    let base = shop_base(ctx, domain, domain_var.name())?;
    let builder = request(ctx, Method::GET, &format!("{base}/password"))?;
    let reply = send(ctx, "the store", builder).await?;
    let domain = safe_token(domain);
    match reply.status {
        200 => Ok(Outcome::pass(format!(
            "store {label} ({domain}) exists and shows the storefront password page; {} is set but Shopify documents no way to check it, so only the end-to-end suite proves it",
            password_var.name()
        ))),
        301..=399 => Ok(Outcome::fail(format!(
            "store {label} ({domain}) redirects from /password ({}): it has no storefront password, or the domain is not its permanent myshopify.com one",
            status_text(reply.status, None)
        ))),
        403 | 429 => Ok(Outcome::fail(format!(
            "store {label} ({domain}) answered {}: Shopify may be showing a bot check, which the doctor never tries to pass",
            status_text(reply.status, None)
        ))),
        status => Ok(Outcome::fail(format!(
            "store {label} ({domain}) answered {} to /password",
            status_text(status, None)
        ))),
    }
}
