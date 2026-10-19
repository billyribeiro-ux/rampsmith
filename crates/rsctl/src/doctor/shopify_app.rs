//! C row 1: the Shopify app's client id and secret (ADR-152).
//!
//! The client credentials grant (`POST /admin/oauth/access_token`, `grant_type=client_credentials`)
//! exchanges the id and secret for a 24-hour Admin API token, and
//! `currentAppInstallation { accessScopes { handle } }` is the smallest Admin GraphQL read that
//! needs one. The grant works only on a store in the app's own organization with the app
//! installed, so the probe uses development store A (C row 3) as the exchange target.

use reqwest::Method;
use serde_json::{Value, json};

use super::common::{
    Step, bad_header, error_code, gather, graphql_codes, has_graphql_errors, header_safe, register,
    request, send, shop_base, status_text,
};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::secret::Secret;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[
    Var::ShopifyApiKey,
    Var::ShopifyApiSecret,
    Var::ShopifyDevStoreDomain,
];

/// The one Admin GraphQL read the probe makes.
const QUERY: &str = "{ currentAppInstallation { accessScopes { handle } } }";

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).await.unwrap_or_else(|outcome| outcome) })
}

async fn probe(ctx: &Ctx) -> Step<Outcome> {
    let credentials = gather(ctx, 1, &[Var::ShopifyApiKey, Var::ShopifyApiSecret])?;
    let Some(domain) = ctx.vars.get(Var::ShopifyDevStoreDomain) else {
        return Ok(Outcome::needs_row(
            3,
            &[Var::ShopifyDevStoreDomain],
            "as the store to exchange the client credentials on (the grant needs a store with the app installed)",
        ));
    };
    let base = shop_base(ctx, &domain, "SHOPIFY_DEV_STORE_DOMAIN")?;

    // 1. The client credentials grant.
    let builder = request(
        ctx,
        Method::POST,
        &format!("{base}/admin/oauth/access_token"),
    )?
    .form(&[
        ("grant_type", "client_credentials"),
        ("client_id", credentials.text(Var::ShopifyApiKey)),
        ("client_secret", credentials.text(Var::ShopifyApiSecret)),
    ]);
    let reply = send(ctx, "Shopify", builder).await?;
    let token = reply
        .is_success()
        .then(|| reply.json::<Value>())
        .flatten()
        .and_then(|body| {
            body.get("access_token")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let Some(token) = token else {
        let code = error_code(&reply.body);
        let hint = if code.as_deref() == Some("app_not_installed") {
            "install the app on the store first (the grant needs it installed)"
        } else {
            "check the client id and secret, that the app is installed on the store, and that the store is in the app's organization"
        };
        return Ok(Outcome::fail(format!(
            "the client credentials grant failed: {}; {hint}",
            status_text(reply.status, code.as_deref())
        )));
    };
    // The minted token is a credential: scrub it from anything printed from here on.
    let token = Secret::new(token);
    register(ctx, &token);
    if !header_safe(token.expose()) {
        return Err(bad_header("the access token Shopify returned"));
    }

    // 2. The smallest Admin GraphQL read that needs that token.
    let url = format!("{base}/admin/api/{}/graphql.json", shopify::API_VERSION);
    let builder = request(ctx, Method::POST, &url)?
        .header("X-Shopify-Access-Token", token.expose())
        .json(&json!({ "query": QUERY }));
    let reply = send(ctx, "Shopify", builder).await?;
    if !reply.is_success() {
        return Ok(Outcome::fail(format!(
            "the Admin API rejected the minted token: {}",
            status_text(reply.status, None)
        )));
    }
    let Some(body) = reply.json::<Value>() else {
        return Ok(Outcome::fail(
            "the Admin API answered 200 without a JSON body",
        ));
    };
    if has_graphql_errors(&body) {
        return Ok(Outcome::fail(format!(
            "the Admin API refused currentAppInstallation ({})",
            graphql_codes(&body).join(", ")
        )));
    }
    let scopes = body
        .pointer("/data/currentAppInstallation/accessScopes")
        .and_then(Value::as_array);
    match scopes {
        Some(scopes) => Ok(Outcome::pass(format!(
            "the client credentials were exchanged on the development store and Admin API {} answered currentAppInstallation with {} access scope(s)",
            shopify::API_VERSION,
            scopes.len()
        ))),
        None => Ok(Outcome::fail(
            "the Admin API answered without currentAppInstallation.accessScopes",
        )),
    }
}
