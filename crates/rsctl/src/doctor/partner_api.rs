//! C row 2: the Partner API client and the App Automation Token (ADR-152).
//!
//! The Partner API is `POST https://partners.shopify.com/{org}/api/{version}/graphql.json`
//! with `X-Shopify-Access-Token` (ADR-131). The smallest read is `app(id)`, which also returns
//! the app's `apiKey`, so the probe compares it with `SHOPIFY_API_KEY` when that is set.
//!
//! The App Automation Token is a Shopify CLI credential for `shopify app deploy`. Shopify
//! documents no call that checks it without deploying, so it is reported as not verifiable.

use reqwest::Method;
use serde_json::{Value, json};

use super::common::{
    Step, bad_header, gather, graphql_codes, has_graphql_errors, header_safe, request, send,
    status_text,
};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::util::safe_token;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[
    Var::ShopifyPartnerApiToken,
    Var::ShopifyPartnerOrgId,
    Var::ShopifyAppGid,
    Var::ShopifyApiKey,
];
pub(super) const AUTOMATION_READS: &[Var] = &[Var::ShopifyAppAutomationToken];

/// The Partner API version Rampsmith pins (ADR-131).
pub(super) const PARTNER_API_VERSION: &str = "2026-10";

const QUERY: &str = "query App($id: ID!) { app(id: $id) { id name apiKey } }";

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).await.unwrap_or_else(|outcome| outcome) })
}

pub(super) fn run_automation_token(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move {
        match ctx.vars.gather(2, AUTOMATION_READS) {
            Ok(_) => Outcome::not_verifiable(
                "SHOPIFY_APP_AUTOMATION_TOKEN is set; Shopify documents no read-only check for it, so `shopify app deploy` in CI is its test",
            ),
            Err(gap) => Outcome::from_gap(&gap),
        }
    })
}

/// The numeric tail of `gid://shopify/App/123` or `gid://partners/App/123`.
fn app_number(gid: &str) -> Option<&str> {
    let number = gid
        .strip_prefix("gid://shopify/App/")
        .or_else(|| gid.strip_prefix("gid://partners/App/"))?;
    (!number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())).then_some(number)
}

async fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(
        ctx,
        2,
        &[
            Var::ShopifyPartnerApiToken,
            Var::ShopifyPartnerOrgId,
            Var::ShopifyAppGid,
        ],
    )?;
    let token = inputs.text(Var::ShopifyPartnerApiToken);
    if !header_safe(token) {
        return Err(bad_header("SHOPIFY_PARTNER_API_TOKEN"));
    }
    let org = inputs.text(Var::ShopifyPartnerOrgId);
    if org.is_empty() || !org.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(Outcome::fail(
            "SHOPIFY_PARTNER_ORG_ID is not a number (it is the organization id in the Partner Dashboard URL)",
        ));
    }
    let gid = inputs.text(Var::ShopifyAppGid);
    let Some(number) = app_number(gid) else {
        return Ok(Outcome::fail(
            "SHOPIFY_APP_GID is not gid://shopify/App/<number> (ADR-131)",
        ));
    };
    let url = format!(
        "{}/{org}/api/{PARTNER_API_VERSION}/graphql.json",
        ctx.endpoints.partner_api.trim_end_matches('/')
    );

    // The docs for `app(id)` show `gid://partners/App/<n>` while ADR-131 and the billing flow
    // use `gid://shopify/App/<n>`. Try the configured form first, then the other.
    let alternative = if gid.starts_with("gid://shopify/") {
        format!("gid://partners/App/{number}")
    } else {
        format!("gid://shopify/App/{number}")
    };
    let mut last_codes = String::new();
    for (index, id) in [gid.to_owned(), alternative].into_iter().enumerate() {
        let builder = request(ctx, Method::POST, &url)?
            .header("X-Shopify-Access-Token", token)
            .json(&json!({ "query": QUERY, "variables": { "id": id } }));
        let reply = send(ctx, "the Partner API", builder).await?;
        match reply.status {
            200 => {}
            401 => {
                return Ok(Outcome::fail(
                    "the Partner API rejected the client (HTTP 401): the token is wrong, or the organization is disabled",
                ));
            }
            429 => {
                return Ok(Outcome::fail(
                    "the Partner API rate limit was hit (HTTP 429): run again in a moment",
                ));
            }
            status => {
                return Ok(Outcome::fail(format!(
                    "the Partner API answered {}",
                    status_text(status, None)
                )));
            }
        }
        let Some(body) = reply.json::<Value>() else {
            return Ok(Outcome::fail(
                "the Partner API answered 200 without a JSON body",
            ));
        };
        if has_graphql_errors(&body) {
            last_codes = graphql_codes(&body).join(", ");
            continue;
        }
        let Some(app) = body.pointer("/data/app").filter(|app| app.is_object()) else {
            "app is null".clone_into(&mut last_codes);
            continue;
        };
        if let Some(expected) = ctx.vars.get(Var::ShopifyApiKey)
            && let Some(found) = app.get("apiKey").and_then(Value::as_str)
            && found != expected
        {
            return Ok(Outcome::fail(
                "SHOPIFY_APP_GID names an app whose API key differs from SHOPIFY_API_KEY: they belong to different apps",
            ));
        }
        let name = app
            .get("name")
            .and_then(Value::as_str)
            .map_or_else(String::new, |name| format!(" `{}`", safe_token(name)));
        let form = if index == 0 {
            String::new()
        } else {
            " with the gid://partners/App form (Shopify's documented example), not the configured one".to_owned()
        };
        return Ok(Outcome::pass(format!(
            "the Partner API client reads app{name} in organization {org}{form}"
        )));
    }
    Ok(Outcome::fail(format!(
        "the Partner API answered but returned no app for SHOPIFY_APP_GID ({last_codes}); check the app id and that the client has the Manage apps permission"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_numbers_come_from_either_gid_form() {
        assert_eq!(app_number("gid://shopify/App/1234"), Some("1234"));
        assert_eq!(app_number("gid://partners/App/1234"), Some("1234"));
        assert_eq!(app_number("gid://shopify/App/"), None);
        assert_eq!(app_number("gid://shopify/App/12a"), None);
        assert_eq!(app_number("gid://shopify/Shop/12"), None);
        assert_eq!(app_number("1234"), None);
    }
}
