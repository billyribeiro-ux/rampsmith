//! C row 8: Railway tokens (ADR-152).
//!
//! - `RAILWAY_TOKEN` is a project token, sent in the `Project-Access-Token` header. The
//!   documented read is `query { projectToken { projectId environmentId } }`. The token works
//!   in one environment only, so the probe also asks for that environment's name and compares
//!   it with `--environment` when Railway answers.
//! - `RAILWAY_API_TOKEN` (optional) is a workspace token, sent as a bearer token. Railway
//!   documents `workspace(workspaceId:)` for it, but the founder inputs hold no workspace id,
//!   so the probe reads the project the project token names instead.

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

pub(super) const READS_PROJECT: &[Var] = &[Var::RailwayToken];
pub(super) const READS_API: &[Var] = &[Var::RailwayApiToken, Var::RailwayToken];

const PROJECT_TOKEN_QUERY: &str = "query { projectToken { projectId environmentId } }";
const ENVIRONMENT_QUERY: &str = "query Environment($id: String!) { environment(id: $id) { name } }";
const PROJECT_QUERY: &str = "query Project($id: String!) { project(id: $id) { id name } }";

/// What a project token is scoped to.
struct Scope {
    project_id: String,
    environment_id: String,
}

pub(super) fn run_project_token(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { project(ctx).await.unwrap_or_else(|outcome| outcome) })
}

pub(super) fn run_api_token(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { workspace(ctx).await.unwrap_or_else(|outcome| outcome) })
}

fn endpoint(ctx: &Ctx) -> String {
    format!("{}/graphql/v2", ctx.endpoints.railway.trim_end_matches('/'))
}

/// Which header carries the token.
#[derive(Clone, Copy)]
enum Auth<'a> {
    Project(&'a str),
    Bearer(&'a str),
}

/// Runs a GraphQL document. `Ok(None)` means Railway answered but the query was refused or had
/// no `data`; the caller decides what that means.
async fn graphql(
    ctx: &Ctx,
    auth: Auth<'_>,
    query: &str,
    variables: Value,
) -> Step<Result<Value, Outcome>> {
    let mut builder = request(ctx, Method::POST, &endpoint(ctx))?
        .json(&json!({ "query": query, "variables": variables }));
    builder = match auth {
        Auth::Project(token) => builder.header("Project-Access-Token", token),
        Auth::Bearer(token) => builder.bearer_auth(token),
    };
    let reply = send(ctx, "Railway", builder).await?;
    let body: Option<Value> = reply.json();
    if !reply.is_success() {
        return Ok(Err(Outcome::fail(format!(
            "the Railway API answered {}",
            status_text(reply.status, None)
        ))));
    }
    let Some(body) = body else {
        return Ok(Err(Outcome::fail(
            "the Railway API answered 200 without a JSON body",
        )));
    };
    if has_graphql_errors(&body) {
        let codes = graphql_codes(&body).join(", ");
        return Ok(Err(Outcome::fail(format!(
            "the Railway API refused the query ({codes}); the token is invalid, expired or the wrong kind"
        ))));
    }
    Ok(Ok(body))
}

fn text<'a>(body: &'a Value, pointer: &str) -> Option<&'a str> {
    body.pointer(pointer).and_then(Value::as_str)
}

/// The scope a project token reports.
async fn scope(ctx: &Ctx, token: &str) -> Step<Result<Scope, Outcome>> {
    let body = match graphql(ctx, Auth::Project(token), PROJECT_TOKEN_QUERY, json!({})).await? {
        Ok(body) => body,
        Err(outcome) => return Ok(Err(outcome)),
    };
    match (
        text(&body, "/data/projectToken/projectId"),
        text(&body, "/data/projectToken/environmentId"),
    ) {
        (Some(project_id), Some(environment_id)) => Ok(Ok(Scope {
            project_id: project_id.to_owned(),
            environment_id: environment_id.to_owned(),
        })),
        _ => Ok(Err(Outcome::fail(
            "projectToken returned no project: RAILWAY_TOKEN is not a project token (an account or workspace token goes in RAILWAY_API_TOKEN)",
        ))),
    }
}

async fn project(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(ctx, 8, READS_PROJECT)?;
    let token = inputs.text(Var::RailwayToken);
    if !header_safe(token) {
        return Err(bad_header("RAILWAY_TOKEN"));
    }
    let scope = match scope(ctx, token).await? {
        Ok(scope) => scope,
        Err(outcome) => return Ok(outcome),
    };
    // Best effort: the environment name is what tells a staging token from a production one.
    let name = match graphql(
        ctx,
        Auth::Project(token),
        ENVIRONMENT_QUERY,
        json!({ "id": scope.environment_id }),
    )
    .await?
    {
        Ok(body) => text(&body, "/data/environment/name").map(safe_token),
        Err(_) => None,
    };
    let want = ctx.options.target.name();
    match name {
        Some(name) if name.eq_ignore_ascii_case(want) => Ok(Outcome::pass(format!(
            "the project token reads its project and belongs to the `{name}` environment"
        ))),
        Some(name) => Ok(Outcome::fail(format!(
            "the project token belongs to the `{name}` environment, not `{want}`; a project token works in one environment only"
        ))),
        None => Ok(Outcome::pass(format!(
            "the project token reads its project (the environment name was not readable, so it is not compared with `{want}`)"
        ))),
    }
}

async fn workspace(ctx: &Ctx) -> Step<Outcome> {
    let inputs = ctx
        .vars
        .gather(8, &[Var::RailwayApiToken])
        .map_err(|gap| Outcome::from_gap(&gap))?;
    let api_token = inputs.text(Var::RailwayApiToken);
    if !header_safe(api_token) {
        return Err(bad_header("RAILWAY_API_TOKEN"));
    }
    let Some(project_token) = ctx.vars.get(Var::RailwayToken) else {
        return Ok(Outcome::needs_row(
            8,
            &[Var::RailwayToken],
            "to name the project the workspace token should read",
        ));
    };
    if !header_safe(&project_token) {
        return Err(bad_header("RAILWAY_TOKEN"));
    }
    let scope = match scope(ctx, &project_token).await? {
        Ok(scope) => scope,
        Err(outcome) => return Ok(outcome),
    };
    let body = match graphql(
        ctx,
        Auth::Bearer(api_token),
        PROJECT_QUERY,
        json!({ "id": scope.project_id }),
    )
    .await?
    {
        Ok(body) => body,
        Err(outcome) => {
            return Ok(Outcome::fail(format!(
                "the workspace token could not read the project RAILWAY_TOKEN belongs to: {}",
                outcome.detail()
            )));
        }
    };
    match text(&body, "/data/project/name") {
        Some(name) => Ok(Outcome::pass(format!(
            "the workspace token reads project `{}`",
            safe_token(name)
        ))),
        None => Ok(Outcome::fail(
            "the workspace token returned no project: it may belong to another workspace",
        )),
    }
}
