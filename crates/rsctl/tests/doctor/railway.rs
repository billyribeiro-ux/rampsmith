//! C row 8: Railway project and workspace tokens.

use rsctl::report::Target;
use wiremock::matchers::{body_string_contains, header, header_exists, method, path};
use wiremock::{Mock, ResponseTemplate};

use crate::support::{Rig, fail, json, pass, skip_missing};

const PROJECT_TOKEN: &str = "test-railway-project-token-SECRET-1";
const API_TOKEN: &str = "test-railway-workspace-token-SECRET-2";

fn graphql() -> wiremock::MockBuilder {
    Mock::given(method("POST")).and(path("/graphql/v2"))
}

pub fn vars() -> Vec<(&'static str, &'static str)> {
    vec![
        ("RAILWAY_TOKEN", PROJECT_TOKEN),
        ("RAILWAY_API_TOKEN", API_TOKEN),
    ]
}

pub async fn healthy(server: &wiremock::MockServer) {
    graphql()
        .and(header("project-access-token", PROJECT_TOKEN))
        .and(body_string_contains("projectToken"))
        .respond_with(json(200, "railway/project-token.json"))
        .mount(server)
        .await;
    graphql()
        .and(header("project-access-token", PROJECT_TOKEN))
        .and(body_string_contains("environment(id"))
        .respond_with(json(200, "railway/environment-production.json"))
        .mount(server)
        .await;
    graphql()
        .and(header(
            "authorization",
            format!("Bearer {API_TOKEN}").as_str(),
        ))
        .respond_with(json(200, "railway/project.json"))
        .mount(server)
        .await;
}

/// The two documented project-token queries, answering as the `environment` environment.
async fn mount_project_token(rig: &Rig, environment: &'static str) {
    graphql()
        .and(header("project-access-token", PROJECT_TOKEN))
        .and(body_string_contains("projectToken"))
        .respond_with(json(200, "railway/project-token.json"))
        .mount(&rig.server)
        .await;
    graphql()
        .and(header("project-access-token", PROJECT_TOKEN))
        .and(body_string_contains("environment(id"))
        .respond_with(json(
            200,
            &format!("railway/environment-{environment}.json"),
        ))
        .mount(&rig.server)
        .await;
}

#[tokio::test]
async fn a_project_token_reads_its_scope_and_matches_the_environment() {
    let rig = Rig::new(&[("RAILWAY_TOKEN", PROJECT_TOKEN)]).await;
    mount_project_token(&rig, "production").await;
    let outcome = rig.run("railway.project-token").await;
    let detail = pass(&outcome);
    assert!(detail.contains("`production` environment"), "{detail}");
    assert!(!detail.contains(PROJECT_TOKEN));
    // The project token goes in its own header, never as a bearer token.
    for request in rig.server.received_requests().await.unwrap() {
        assert!(request.headers.get("authorization").is_none());
    }
}

#[tokio::test]
async fn a_staging_token_in_the_production_slot_fails() {
    let rig = Rig::new(&[("RAILWAY_TOKEN", PROJECT_TOKEN)]).await;
    mount_project_token(&rig, "staging").await;
    let outcome = rig.run("railway.project-token").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("`staging`") && detail.contains("not `production`"),
        "{detail}"
    );
}

#[tokio::test]
async fn the_staging_target_expects_the_staging_environment() {
    let mut rig = Rig::new(&[("RAILWAY_TOKEN", PROJECT_TOKEN)]).await;
    rig.options.target = Target::Staging;
    mount_project_token(&rig, "staging").await;
    assert!(pass(&rig.run("railway.project-token").await).contains("`staging`"));
}

#[tokio::test]
async fn an_unreadable_environment_name_still_passes_and_says_so() {
    let rig = Rig::new(&[("RAILWAY_TOKEN", PROJECT_TOKEN)]).await;
    graphql()
        .and(body_string_contains("projectToken"))
        .respond_with(json(200, "railway/project-token.json"))
        .mount(&rig.server)
        .await;
    graphql()
        .and(body_string_contains("environment(id"))
        .respond_with(json(200, "railway/not-authorized.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("railway.project-token").await;
    assert!(
        pass(&outcome).contains("environment name was not readable"),
        "{outcome:?}"
    );
}

#[tokio::test]
async fn a_rejected_token_fails_with_the_extension_code_not_the_message() {
    let rig = Rig::new(&[("RAILWAY_TOKEN", PROJECT_TOKEN)]).await;
    graphql()
        .respond_with(json(200, "railway/not-authorized.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("railway.project-token").await;
    let detail = fail(&outcome);
    assert!(
        detail.contains("INTERNAL_SERVER_ERROR") && detail.contains("refused"),
        "{detail}"
    );
    assert!(!detail.contains("Not Authorized"), "{detail}");
}

#[tokio::test]
async fn an_account_token_in_the_project_slot_is_explained() {
    let rig = Rig::new(&[("RAILWAY_TOKEN", PROJECT_TOKEN)]).await;
    graphql()
        .respond_with(
            ResponseTemplate::new(200).set_body_string(r#"{"data":{"projectToken":null}}"#),
        )
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("railway.project-token").await).contains("not a project token"));
}

#[tokio::test]
async fn http_errors_fail() {
    let rig = Rig::new(&[("RAILWAY_TOKEN", PROJECT_TOKEN)]).await;
    graphql()
        .respond_with(ResponseTemplate::new(502))
        .mount(&rig.server)
        .await;
    assert!(fail(&rig.run("railway.project-token").await).contains("502"));
}

#[tokio::test]
async fn a_workspace_token_reads_the_project_the_project_token_names() {
    let rig = Rig::new(&[
        ("RAILWAY_TOKEN", PROJECT_TOKEN),
        ("RAILWAY_API_TOKEN", API_TOKEN),
    ])
    .await;
    graphql()
        .and(header("project-access-token", PROJECT_TOKEN))
        .and(body_string_contains("projectToken"))
        .respond_with(json(200, "railway/project-token.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    graphql()
        .and(header(
            "authorization",
            format!("Bearer {API_TOKEN}").as_str(),
        ))
        .and(body_string_contains("project(id"))
        .and(body_string_contains("9e1a2b3c-0000-4000-8000-000000000001"))
        .respond_with(json(200, "railway/project.json"))
        .expect(1)
        .mount(&rig.server)
        .await;
    let outcome = rig.run("railway.workspace-token").await;
    let detail = pass(&outcome);
    assert!(detail.contains("`rampsmith`"), "{detail}");
    assert!(!detail.contains(API_TOKEN) && !detail.contains(PROJECT_TOKEN));
}

#[tokio::test]
async fn a_workspace_token_from_another_workspace_fails() {
    let rig = Rig::new(&[
        ("RAILWAY_TOKEN", PROJECT_TOKEN),
        ("RAILWAY_API_TOKEN", API_TOKEN),
    ])
    .await;
    graphql()
        .and(header_exists("project-access-token"))
        .respond_with(json(200, "railway/project-token.json"))
        .mount(&rig.server)
        .await;
    graphql()
        .and(header_exists("authorization"))
        .respond_with(json(200, "railway/not-authorized.json"))
        .mount(&rig.server)
        .await;
    let outcome = rig.run("railway.workspace-token").await;
    let detail = fail(&outcome);
    assert!(detail.contains("could not read the project"), "{detail}");
}

#[tokio::test]
async fn a_workspace_token_alone_asks_for_the_project_token() {
    let rig = Rig::new(&[("RAILWAY_API_TOKEN", API_TOKEN)]).await;
    let outcome = rig.run("railway.workspace-token").await;
    let detail = skip_missing(&outcome);
    assert!(
        detail.contains("RAILWAY_TOKEN") && detail.contains("C row 8"),
        "{detail}"
    );
}

#[tokio::test]
async fn unset_inputs_skip_naming_row_8() {
    let rig = Rig::new(&[]).await;
    assert!(skip_missing(&rig.run("railway.project-token").await).contains("C row 8"));
    assert!(skip_missing(&rig.run("railway.workspace-token").await).contains("C row 8"));
}
