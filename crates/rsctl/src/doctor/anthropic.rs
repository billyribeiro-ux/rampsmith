//! C row 5: the Anthropic API key lists models (ADR-152).
//!
//! `GET /v1/models` with `x-api-key` and `anthropic-version`. The key is also required to see
//! the models PLAN §13 names, so a key that lists others only still fails.

use std::collections::BTreeSet;

use reqwest::Method;
use serde::Deserialize;

use super::common::{
    Step, bad_header, error_code, gather, header_safe, request, send, status_text,
};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[Var::AnthropicApiKey];

/// The models PLAN §13 uses: Haiku by default, Sonnet to escalate, Opus for offline patches.
pub const EXPECTED_MODELS: &[&str] = &["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];

/// The API version header the Messages API documents.
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Pages followed at most, at the documented maximum of 1000 models per page.
const MAX_PAGES: usize = 5;

#[derive(Deserialize)]
struct Page {
    data: Vec<Model>,
    #[serde(default)]
    has_more: bool,
    last_id: Option<String>,
}

#[derive(Deserialize)]
struct Model {
    id: String,
}

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).await.unwrap_or_else(|outcome| outcome) })
}

async fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(ctx, 5, READS)?;
    let key = inputs.text(Var::AnthropicApiKey);
    if !header_safe(key) {
        return Err(bad_header("ANTHROPIC_API_KEY"));
    }
    let base = ctx.endpoints.anthropic_api.trim_end_matches('/');
    let mut ids = BTreeSet::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut url = format!("{base}/v1/models?limit=1000");
        if let Some(cursor) = &after {
            url.push_str("&after_id=");
            url.push_str(&crate::util::uri_encode(cursor, true));
        }
        let builder = request(ctx, Method::GET, &url)?
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION);
        let reply = send(ctx, "the Anthropic API", builder).await?;
        if !reply.is_success() {
            let code = error_code(&reply.body);
            let meaning = match reply.status {
                401 => " (the key was rejected)",
                403 => " (the key may not list models: check its workspace permissions)",
                429 => " (rate limited: run again in a minute)",
                _ => "",
            };
            return Ok(Outcome::fail(format!(
                "GET /v1/models failed: {}{meaning}",
                status_text(reply.status, code.as_deref())
            )));
        }
        let Some(page) = reply.json::<Page>() else {
            return Ok(Outcome::fail(
                "GET /v1/models answered 200 but not with the documented list shape",
            ));
        };
        ids.extend(page.data.into_iter().map(|model| model.id));
        match (page.has_more, page.last_id) {
            (true, Some(last)) => after = Some(last),
            _ => break,
        }
    }
    let missing = missing_models(&ids);
    if missing.is_empty() {
        Ok(Outcome::pass(format!(
            "the key lists {} models, including {}",
            ids.len(),
            EXPECTED_MODELS.join(", ")
        )))
    } else {
        Ok(Outcome::fail(format!(
            "the key lists {} models but not {} (PLAN §13 uses them)",
            ids.len(),
            missing.join(", ")
        )))
    }
}

/// The expected models no listed id matches. A listed id matches when it is the model's alias
/// or the alias followed by a dated suffix (`claude-haiku-5-5-20261001`).
fn missing_models(listed: &BTreeSet<String>) -> Vec<&'static str> {
    EXPECTED_MODELS
        .iter()
        .copied()
        .filter(|expected| {
            !listed.iter().any(|id| {
                id == expected
                    || id
                        .strip_prefix(*expected)
                        .is_some_and(|rest| rest.starts_with('-'))
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn aliases_and_dated_ids_both_match() {
        assert!(
            missing_models(&set(&[
                "claude-haiku-5-5",
                "claude-sonnet-5-5-20261001",
                "claude-opus-5-5"
            ]))
            .is_empty()
        );
    }

    #[test]
    fn a_longer_name_is_not_a_match() {
        // `claude-haiku-5-50` must not satisfy `claude-haiku-5-5`.
        assert_eq!(
            missing_models(&set(&[
                "claude-haiku-5-50",
                "claude-sonnet-5-5",
                "claude-opus-5-5"
            ])),
            vec!["claude-haiku-5-5"]
        );
    }

    #[test]
    fn missing_models_are_named() {
        assert_eq!(
            missing_models(&set(&["claude-haiku-5-5"])),
            vec!["claude-sonnet-5-5", "claude-opus-5-5"]
        );
    }
}
