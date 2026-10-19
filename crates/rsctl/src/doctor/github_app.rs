//! C row 4: the GitHub App's id, client id and private key (ADR-152).
//!
//! GitHub authenticates "as the app" with a JWT signed RS256 by the private key, with `iat`,
//! `exp` (at most ten minutes ahead) and `iss` (the client id, which GitHub recommends over
//! the app id). `GET /app` is the call that needs exactly that JWT and nothing else, and it
//! returns the app's `id` and `client_id`, so the probe checks they are the ones configured.
//! The webhook secret has no read call: GitHub's "Get a webhook configuration for an app"
//! masks it, so only its presence is checked.

use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use reqwest::Method;
use serde::Deserialize;
use serde_json::json;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc2822;

use super::common::{Step, gather, register, request, send, status_text};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::secret::Secret;
use crate::util::safe_token;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[
    Var::GithubAppId,
    Var::GithubAppClientId,
    Var::GithubAppPrivateKey,
    Var::GithubAppWebhookSecret,
];

/// The REST API version header. The OpenAPI description for 2026-03-10 is what the fields
/// below were read from.
pub(super) const GITHUB_API_VERSION: &str = "2026-03-10";

/// Seconds the JWT is dated into the past, as GitHub recommends, for clock drift.
const BACKDATE: i64 = 60;
/// Seconds the JWT stays valid. GitHub allows up to ten minutes.
const LIFETIME: i64 = 540;

#[derive(Deserialize)]
struct App {
    id: u64,
    client_id: Option<String>,
    slug: Option<String>,
}

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).await.unwrap_or_else(|outcome| outcome) })
}

/// Makes the PEM usable when a platform stored it on one line with literal `\n`.
fn normalise_pem(raw: &str) -> String {
    let raw = raw.trim().trim_matches('"');
    if raw.contains('\n') {
        raw.to_owned()
    } else {
        raw.replace("\\n", "\n")
    }
}

/// The app JWT. Errors name the fault, never the key.
fn app_jwt(pem: &str, client_id: &str, now: OffsetDateTime) -> Result<Secret, &'static str> {
    let key = EncodingKey::from_rsa_pem(normalise_pem(pem).as_bytes()).map_err(|_| {
        "GITHUB_APP_PRIVATE_KEY is not an RSA private key in PEM form (the .pem GitHub generates for the app)"
    })?;
    let issued = now.unix_timestamp() - BACKDATE;
    let claims = json!({ "iat": issued, "exp": issued + BACKDATE + LIFETIME, "iss": client_id });
    encode(&Header::new(Algorithm::RS256), &claims, &key)
        .map(Secret::new)
        .map_err(|_| "the private key could not sign a JWT (it should be at least 2048 bits)")
}

async fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(ctx, 4, READS)?;
    let app_id = inputs.text(Var::GithubAppId);
    if app_id.is_empty() || !app_id.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(Outcome::fail("GITHUB_APP_ID is not a number"));
    }
    let client_id = inputs.text(Var::GithubAppClientId);
    let jwt = match app_jwt(inputs.text(Var::GithubAppPrivateKey), client_id, ctx.now()) {
        Ok(jwt) => jwt,
        Err(reason) => return Ok(Outcome::fail(reason)),
    };
    register(ctx, &jwt);

    let url = format!("{}/app", ctx.endpoints.github_api.trim_end_matches('/'));
    let builder = request(ctx, Method::GET, &url)?
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", GITHUB_API_VERSION)
        .bearer_auth(jwt.expose());
    let reply = send(ctx, "GitHub", builder).await?;
    if reply.status == 401 {
        let skew = reply
            .header("date")
            .and_then(|date| OffsetDateTime::parse(date, &Rfc2822).ok())
            .map(|server| (ctx.now() - server).whole_seconds())
            .filter(|seconds| seconds.abs() > BACKDATE);
        let clock = skew.map_or_else(String::new, |seconds| {
            format!(
                "; this machine's clock is {seconds} s from GitHub's, which alone can break the JWT"
            )
        });
        return Ok(Outcome::fail(format!(
            "GitHub rejected the JWT (HTTP 401): the private key does not belong to the app GITHUB_APP_CLIENT_ID names{clock}"
        )));
    }
    if !reply.is_success() {
        return Ok(Outcome::fail(format!(
            "GET /app failed: {}",
            status_text(reply.status, None)
        )));
    }
    let Some(app) = reply.json::<App>() else {
        return Ok(Outcome::fail(
            "GET /app answered 200 but not with the documented app object",
        ));
    };
    if app.id.to_string() != app_id {
        return Ok(Outcome::fail(format!(
            "the key authenticates as app {}, not GITHUB_APP_ID {app_id}",
            app.id
        )));
    }
    if let Some(found) = &app.client_id
        && found != client_id
    {
        return Ok(Outcome::fail(
            "GET /app reports a client id that differs from GITHUB_APP_CLIENT_ID",
        ));
    }
    let slug = app
        .slug
        .as_deref()
        .map_or_else(String::new, |slug| format!(" (`{}`)", safe_token(slug)));
    Ok(Outcome::pass(format!(
        "the JWT reaches GET /app as app {}{slug}; the webhook secret is set but GitHub offers no way to read it back",
        app.id
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_line_pems_get_their_newlines_back() {
        assert_eq!(
            normalise_pem(
                "\"-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----\""
            ),
            "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"
        );
        let multi = "-----BEGIN X-----\nabc\n-----END X-----";
        assert_eq!(normalise_pem(multi), multi);
    }

    #[test]
    fn a_bad_key_errors_without_echoing_it() {
        let now = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        let error = app_jwt("not-a-pem-SECRETMARKER", "Iv1.abc", now).unwrap_err();
        assert!(!error.contains("SECRETMARKER"));
    }
}
