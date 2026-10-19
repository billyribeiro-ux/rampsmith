//! C row 10: the optional Cloudflare DNS token reads its zone (ADR-152).
//!
//! `GET /client/v4/zones` lists the zones the token can see, and
//! `GET /client/v4/zones/{id}/dns_records?per_page=1` proves it can read DNS records there.
//! Nothing is created or changed.

use reqwest::Method;
use serde::Deserialize;
use serde_json::Value;

use super::common::{Step, bad_header, gather, header_safe, request, send, status_text};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::util::safe_token;
use crate::vars::Var;

pub(super) const READS: &[Var] = &[Var::CloudflareApiToken];

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    errors: Vec<ApiError>,
    result: Option<Value>,
}

#[derive(Deserialize)]
struct ApiError {
    code: Option<i64>,
}

#[derive(Deserialize)]
struct Zone {
    id: String,
    name: String,
}

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).await.unwrap_or_else(|outcome| outcome) })
}

fn failure(what: &str, status: u16, envelope: Option<&Envelope>) -> Outcome {
    let codes = envelope
        .map(|e| {
            e.errors
                .iter()
                .filter_map(|error| error.code)
                .map(|code| code.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|codes| !codes.is_empty());
    let hint = match status {
        401 | 403 => {
            " (the token was rejected or lacks the permission: it needs Zone:Read and DNS:Read or Edit on the zone)"
        }
        _ => "",
    };
    Outcome::fail(format!(
        "{what} failed: {}{}{hint}",
        status_text(status, None),
        codes.map_or_else(String::new, |codes| format!(
            ", Cloudflare error code {codes}"
        ))
    ))
}

async fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(ctx, 10, READS)?;
    let token = inputs.text(Var::CloudflareApiToken);
    if !header_safe(token) {
        return Err(bad_header("CLOUDFLARE_API_TOKEN"));
    }
    let base = ctx.endpoints.cloudflare_api.trim_end_matches('/');

    let builder = request(
        ctx,
        Method::GET,
        &format!("{base}/client/v4/zones?per_page=50"),
    )?
    .bearer_auth(token);
    let reply = send(ctx, "the Cloudflare API", builder).await?;
    let envelope = reply.json::<Envelope>();
    if !reply.is_success() || !envelope.as_ref().is_some_and(|e| e.success) {
        return Ok(failure("listing zones", reply.status, envelope.as_ref()));
    }
    let zones: Vec<Zone> = envelope
        .and_then(|e| e.result)
        .and_then(|result| serde_json::from_value(result).ok())
        .unwrap_or_default();
    let Some(first) = zones.first() else {
        return Ok(Outcome::fail(
            "the token is valid but sees no zones; scope it to the Rampsmith zone with Zone:Read and DNS:Edit",
        ));
    };

    let id = crate::util::uri_encode(&first.id, true);
    let builder = request(
        ctx,
        Method::GET,
        &format!("{base}/client/v4/zones/{id}/dns_records?per_page=1"),
    )?
    .bearer_auth(token);
    let reply = send(ctx, "the Cloudflare API", builder).await?;
    let envelope = reply.json::<Envelope>();
    if !reply.is_success() || !envelope.as_ref().is_some_and(|e| e.success) {
        return Ok(failure(
            "reading DNS records",
            reply.status,
            envelope.as_ref(),
        ));
    }
    let names = zones
        .iter()
        .take(3)
        .map(|zone| safe_token(&zone.name))
        .collect::<Vec<_>>()
        .join(", ");
    let more = zones.len().saturating_sub(3);
    Ok(Outcome::pass(format!(
        "the token sees {} zone(s) ({names}{}) and reads DNS records in {}",
        zones.len(),
        if more > 0 {
            format!(", and {more} more")
        } else {
            String::new()
        },
        safe_token(&first.name)
    )))
}
