//! C row 15: the staging environment uses its own copies of the Shopify app and the GitHub
//! App (ADR-152). Each app has one set of URLs and one webhook endpoint, so a staging
//! environment configured with the production app's identifiers breaks production.
//!
//! The probe compares the staging identifiers (the same variable names as rows 1 and 4, read
//! from the staging environment) with the production values given on the command line. Both
//! are public identifiers, not secrets.

use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[Var::ShopifyApiKey, Var::GithubAppId];

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx) })
}

fn probe(ctx: &Ctx) -> Outcome {
    let shopify = ctx.vars.get(Var::ShopifyApiKey);
    let github = ctx.vars.get(Var::GithubAppId);
    let (Some(shopify), Some(github)) = (shopify, github) else {
        let missing: Vec<Var> = [
            (
                Var::ShopifyApiKey,
                ctx.vars.get(Var::ShopifyApiKey).is_none(),
            ),
            (Var::GithubAppId, ctx.vars.get(Var::GithubAppId).is_none()),
        ]
        .into_iter()
        .filter_map(|(var, absent)| absent.then_some(var))
        .collect();
        return Outcome::needs_row(15, &missing, "in the staging environment");
    };
    let (Some(production_shopify), Some(production_github)) = (
        ctx.options.production_shopify_api_key.as_deref(),
        ctx.options.production_github_app_id.as_deref(),
    ) else {
        return Outcome::missing(
            "C row 15 needs the production identifiers to compare with: pass --production-shopify-api-key and --production-github-app-id",
        );
    };
    let mut shared = Vec::new();
    if shopify == production_shopify.trim() {
        shared.push("the Shopify app (SHOPIFY_API_KEY)");
    }
    if github == production_github.trim() {
        shared.push("the GitHub App (GITHUB_APP_ID)");
    }
    if shared.is_empty() {
        Outcome::pass("staging uses its own Shopify app and its own GitHub App")
    } else {
        Outcome::fail(format!(
            "staging shares {} with production; create a staging copy (each app has one set of URLs and one webhook endpoint)",
            shared.join(" and ")
        ))
    }
}
