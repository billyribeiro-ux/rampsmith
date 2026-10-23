//! Installation state and the installer's identity, against the fake API (ADR-290, ADR-291).

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use github::{
    GitHubError, InstallationId, OAuthApp, OAuthError, RepositoryId, RepositorySelection,
    TokenScope,
};
use secrecy::SecretString;
use support::{
    CLIENT_ID, CLIENT_SECRET, Fake, GOOD_CODE, INSTALLATION, REPO_ID, USER_TOKEN, installation,
    repo_ref,
};

fn app() -> OAuthApp {
    OAuthApp::new(CLIENT_ID, SecretString::from(CLIENT_SECRET))
}

#[tokio::test]
async fn an_installation_is_read_from_the_api_and_a_gone_one_is_none() {
    let fake = Fake::start().await;
    let client = fake.client();
    let info = client.installation(installation()).await.unwrap().unwrap();
    assert_eq!(info.id, installation());
    assert_eq!(info.account.login.as_deref(), Some("octo-shop"));
    assert_eq!(info.repository_selection, RepositorySelection::Selected);
    assert_eq!(info.suspended_at, None);
    assert_eq!(info.app_id, Some(123));
    assert_eq!(
        client.installation(InstallationId::new(1)).await.unwrap(),
        None,
        "an uninstalled installation answers 404"
    );
    let sent = fake.requests();
    assert!(
        sent.iter()
            .all(|r| r.headers["authorization"].starts_with("Bearer ")),
        "every call is authenticated"
    );
    assert!(
        fake.state().minted.is_empty(),
        "reading an installation needs the App JWT only"
    );
}

#[tokio::test]
async fn installation_repositories_are_listed_across_pages_with_a_metadata_token() {
    let fake = Fake::start().await;
    fake.state().extra_repos = 250;
    let client = fake.client();
    let listing = client
        .installation_repositories(installation())
        .await
        .unwrap();
    assert_eq!(listing.items.len(), 251);
    assert!(!listing.truncated);
    assert_eq!(listing.items[0].id, RepositoryId::new(REPO_ID));
    let sent = fake.requests();
    let pages = sent
        .iter()
        .filter(|r| r.path == "/installation/repositories")
        .count();
    assert_eq!(pages, 3, "100 + 100 + 51");
    let mint = sent
        .iter()
        .find(|r| r.path.ends_with("/access_tokens"))
        .unwrap()
        .json();
    assert_eq!(
        mint,
        serde_json::json!({"permissions": {"metadata": "read"}})
    );
}

#[tokio::test]
async fn a_very_long_repository_list_is_cut_and_says_so() {
    let fake = Fake::start().await;
    fake.state().extra_repos = 1100;
    let listing = fake
        .client()
        .installation_repositories(installation())
        .await
        .unwrap();
    assert_eq!(listing.items.len(), 1000);
    assert!(listing.truncated);
}

#[tokio::test]
async fn a_code_is_exchanged_and_the_user_can_be_checked() {
    let fake = Fake::start().await;
    let client = fake.client();
    let token = client.exchange_oauth_code(&app(), GOOD_CODE).await.unwrap();
    assert_eq!(client.user_login(&token).await.unwrap(), "octo-person");
    let installations = client.user_installations(&token).await.unwrap();
    assert_eq!(installations.items.len(), 1);
    assert_eq!(installations.items[0].id, installation());
    let repos = client
        .user_installation_repositories(&token, installation())
        .await
        .unwrap();
    assert_eq!(repos.items[0].id, RepositoryId::new(REPO_ID));
    assert!(repos.items[0].permissions.unwrap().push);
    let shown = format!("{token:?} {:?}", app());
    assert!(!shown.contains(USER_TOKEN), "{shown}");
    assert!(!shown.contains(CLIENT_SECRET), "{shown}");
    let sent = fake.requests();
    let exchange = sent
        .iter()
        .find(|r| r.path == "/login/oauth/access_token")
        .unwrap();
    assert_eq!(exchange.headers["accept"], "application/json");
}

#[tokio::test]
async fn a_user_without_push_access_is_visible_in_the_permissions() {
    let fake = Fake::start().await;
    fake.state().user_can_push = false;
    let client = fake.client();
    let token = client.exchange_oauth_code(&app(), GOOD_CODE).await.unwrap();
    let repos = client
        .user_installation_repositories(&token, installation())
        .await
        .unwrap();
    assert!(!repos.items[0].permissions.unwrap().push);
}

#[tokio::test]
async fn a_refused_exchange_names_githubs_error_and_nothing_else() {
    let fake = Fake::start().await;
    let client = fake.client();
    let err = client
        .exchange_oauth_code(&app(), "someone-elses-code")
        .await
        .unwrap_err();
    assert_eq!(err, OAuthError::Refused("bad_verification_code".to_owned()));
    let wrong = OAuthApp::new(CLIENT_ID, SecretString::from("not-the-secret"));
    let err = client
        .exchange_oauth_code(&wrong, GOOD_CODE)
        .await
        .unwrap_err();
    assert_eq!(
        err,
        OAuthError::Refused("incorrect_client_credentials".to_owned())
    );
    let shown = format!("{err} {err:?}");
    assert!(!shown.contains("not-the-secret"), "{shown}");
}

#[tokio::test]
async fn a_malformed_code_is_refused_before_any_request() {
    let fake = Fake::start().await;
    let client = fake.client();
    for bad in ["", "a b", "x&client_secret=y", &"a".repeat(129), "co\nde"] {
        assert!(
            matches!(
                client.exchange_oauth_code(&app(), bad).await,
                Err(OAuthError::Refused(_))
            ),
            "{bad:?}"
        );
    }
    assert!(fake.requests().is_empty());
}

#[tokio::test]
async fn an_expired_user_token_is_unauthorized_not_empty() {
    let fake = Fake::start().await;
    let client = fake.client();
    let token = client.exchange_oauth_code(&app(), GOOD_CODE).await.unwrap();
    fake.inject(support::Injected::json(
        401,
        serde_json::json!({"message": "Bad credentials"}),
    ));
    assert_eq!(
        client.user_installations(&token).await.unwrap_err(),
        GitHubError::Unauthorized
    );
}

#[tokio::test]
async fn a_pull_request_is_read_back_with_the_repository_it_targets() {
    let fake = Fake::start().await;
    let base = support::seed(&fake);
    let plan = github::plan_pull_requests(&support::batch(), "main", github::PrLimits::default())
        .unwrap()
        .remove(0);
    let client = fake.client();
    let repo = client.repository(installation(), repo_ref(), support::scope());
    repo.push(&plan, &base, &github::RefUpdate::FastForward)
        .await
        .unwrap();
    let main = github::BranchName::parse("main").unwrap();
    let opened = repo
        .open_or_update_pull_request(&plan, &main)
        .await
        .unwrap();
    let state = repo.pull_request(opened.number).await.unwrap().unwrap();
    assert_eq!(state.number, opened.number);
    assert!(state.open && !state.merged);
    assert_eq!(state.base_repository, RepositoryId::new(REPO_ID));
    assert_eq!(state.head_ref, plan.head.as_str());
    assert_eq!(repo.pull_request(999).await.unwrap(), None);
    assert_eq!(INSTALLATION, 4242);
    let _ = TokenScope::read_theme(RepositoryId::new(REPO_ID));
}
