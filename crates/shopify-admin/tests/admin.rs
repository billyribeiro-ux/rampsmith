//! The Admin client against recorded responses in the shapes shopify.dev documents for
//! 2026-10 (ADR-080 to ADR-082). The substitute for the live dev-store suite (LAUNCH.md E).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use secrecy::SecretString;
use serde_json::json;
use shopify::ShopDomain;
use shopify_admin::{
    AdminClient, AdminEndpoint, AdminError, AdminFactory, Field, Owner, Target, same_value,
};
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "shpat_test_token_value";
const GRAPHQL_PATH: &str = "/demo-store.myshopify.com/admin/api/2026-10/graphql.json";

fn fixture(name: &str) -> serde_json::Value {
    let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn client(server: &MockServer) -> AdminClient {
    let factory =
        AdminFactory::new(AdminEndpoint::Base(server.uri()), Duration::from_secs(5)).unwrap();
    factory.client(
        &ShopDomain::parse("demo-store.myshopify.com").unwrap(),
        SecretString::from(TOKEN),
    )
}

async fn answer(server: &MockServer, operation: &str, body: serde_json::Value) {
    Mock::given(method("POST"))
        .and(path(GRAPHQL_PATH))
        .and(header("X-Shopify-Access-Token", TOKEN))
        .and(body_partial_json(json!({ "operationName": operation })))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

#[tokio::test]
async fn the_shop_its_locales_and_its_live_theme_are_read() {
    let server = MockServer::start().await;
    answer(&server, "RampsmithShop", fixture("shop")).await;
    answer(&server, "RampsmithShopOwner", fixture("shop")).await;
    let shop = client(&server).shop().await.unwrap();
    assert_eq!(shop.gid, "gid://shopify/Shop/548380009");
    assert_eq!(shop.myshopify_domain, "super-toys.myshopify.com");
    assert_eq!(shop.primary_domain.unwrap().host, "supertoys.example");
    assert_eq!(shop.locales.len(), 2);
    assert!(shop.locales[0].primary && shop.locales[0].published);
    let theme = shop.live_theme.unwrap();
    assert_eq!((theme.name.as_str(), theme.role.as_str()), ("Dawn", "MAIN"));
}

#[tokio::test]
async fn products_come_with_media_and_a_cursor_to_continue() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(body_partial_json(json!({
            "operationName": "RampsmithProducts",
            "variables": { "first": 20, "media": 20, "after": null }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture("products_page1")))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(json!({
            "operationName": "RampsmithProducts",
            "variables": { "after": "eyJsYXN0X2lkIjoxfQ==" }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture("products_page2")))
        .mount(&server)
        .await;
    let client = client(&server);

    let first = client.products(None).await.unwrap();
    assert_eq!(first.next.as_deref(), Some("eyJsYXN0X2lkIjoxfQ=="));
    assert_eq!(first.items.len(), 2);
    let globe = &first.items[0];
    assert_eq!(globe.status, "ACTIVE");
    assert_eq!(globe.media.len(), 2);
    assert_eq!(globe.media[0].kind, "MediaImage");
    assert_eq!(globe.media[0].alt, None);
    assert_eq!(globe.media[0].status.as_deref(), Some("READY"));
    assert_eq!(globe.media[0].image.as_ref().unwrap().width, Some(800));
    assert_eq!(globe.media[1].kind, "Video");
    assert!(!globe.media_truncated);
    assert!(first.items[1].media_truncated);
    assert_eq!(first.items[1].online_store_url, None);

    let second = client.products(first.next.as_deref()).await.unwrap();
    assert_eq!(second.items, []);
    assert_eq!(second.next, None);
}

#[tokio::test]
async fn collections_pages_articles_and_menus_parse() {
    let server = MockServer::start().await;
    answer(&server, "RampsmithCollections", fixture("collections")).await;
    answer(&server, "RampsmithPages", fixture("pages")).await;
    answer(&server, "RampsmithArticles", fixture("articles")).await;
    answer(&server, "RampsmithMenus", fixture("menus")).await;
    let client = client(&server);

    let collections = client.collections(None).await.unwrap();
    assert_eq!(collections.items[0].image.as_ref().unwrap().alt_text, None);
    assert!(collections.items[1].image.is_none());
    let pages = client.pages(None).await.unwrap();
    assert_eq!(pages.items[0].body, "<h2>About us</h2>");
    let articles = client.articles(None).await.unwrap();
    assert_eq!(articles.items[0].blog_handle, "journal");
    assert_eq!(
        articles.items[0]
            .image
            .as_ref()
            .unwrap()
            .alt_text
            .as_deref(),
        Some("A newspaper")
    );
    let menus = client.menus(None).await.unwrap();
    assert_eq!(menus.items[0].items[0].items[0].title, "Winter");
    assert_eq!(menus.items[0].items[0].kind, "COLLECTIONS");
}

#[tokio::test]
async fn a_live_value_is_read_and_a_missing_or_mistyped_node_is_reported() {
    let server = MockServer::start().await;
    let image = Target::parse("gid://shopify/MediaImage/11", "alt").unwrap();
    Mock::given(method("POST"))
        .and(body_partial_json(
            json!({ "operationName": "RampsmithNodeValue" }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture("node_media_image")))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(
            json!({ "operationName": "RampsmithNodeValue" }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture("node_media_image_unset")))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(
            json!({ "operationName": "RampsmithNodeValue" }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture("node_missing")))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(
            json!({ "operationName": "RampsmithNodeValue" }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture("node_product")))
        .mount(&server)
        .await;
    let client = client(&server);

    let live = client.live_value(&image).await.unwrap();
    assert_eq!(live.value.as_deref(), Some("A snow globe"));
    assert_eq!(live.media_status.as_deref(), Some("READY"));
    let unset = client.live_value(&image).await.unwrap();
    assert_eq!(unset.value, None);
    assert_eq!(unset.media_status.as_deref(), Some("PROCESSING"));
    assert!(same_value(Field::Alt, unset.value.as_deref(), Some("")));
    assert_eq!(
        client.live_value(&image).await.unwrap_err(),
        AdminError::ResourceMissing
    );
    // The node is a Product, the GID names a MediaImage: refuse rather than compare.
    assert_eq!(
        client.live_value(&image).await.unwrap_err(),
        AdminError::ResourceMissing
    );
}

#[tokio::test]
async fn each_data_fix_uses_its_documented_mutation_and_input() {
    let server = MockServer::start().await;
    for (operation, input, response) in [
        (
            "RampsmithSetMediaAlt",
            json!({ "files": [{ "id": "gid://shopify/MediaImage/11", "alt": "A snow globe on a table" }] }),
            "file_update_ok",
        ),
        (
            "RampsmithSetProductDescription",
            json!({ "product": { "id": "gid://shopify/Product/1", "descriptionHtml": "<p>Shake it well.</p>" } }),
            "product_update_ok",
        ),
        (
            "RampsmithSetCollectionDescription",
            json!({ "collection": { "id": "gid://shopify/Collection/5", "descriptionHtml": "<p>Cold things, warm prices</p>" } }),
            "collection_update_ok",
        ),
        (
            "RampsmithSetPageBody",
            json!({ "id": "gid://shopify/Page/7", "page": { "body": "<h2>About Super Toys</h2>" } }),
            "page_update_ok",
        ),
    ] {
        Mock::given(method("POST"))
            .and(body_partial_json(json!({
                "operationName": operation,
                "variables": input
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(fixture(response)))
            .expect(1)
            .mount(&server)
            .await;
    }
    let client = client(&server);
    let write = |gid: &'static str, field: &'static str, value: &'static str| {
        let client = client.clone();
        async move {
            client
                .write_value(&Target::parse(gid, field).unwrap(), value)
                .await
        }
    };
    assert_eq!(
        write(
            "gid://shopify/MediaImage/11",
            "alt",
            "A snow globe on a table"
        )
        .await
        .unwrap(),
        "A snow globe on a table"
    );
    assert_eq!(
        write(
            "gid://shopify/Product/1",
            "description_html",
            "<p>Shake it well.</p>"
        )
        .await
        .unwrap(),
        "<p>Shake it well.</p>"
    );
    assert_eq!(
        write(
            "gid://shopify/Collection/5",
            "description_html",
            "<p>Cold things, warm prices</p>"
        )
        .await
        .unwrap(),
        "<p>Cold things, warm prices</p>"
    );
    assert_eq!(
        write("gid://shopify/Page/7", "body", "<h2>About Super Toys</h2>")
            .await
            .unwrap(),
        "<h2>About Super Toys</h2>"
    );
}

#[tokio::test]
async fn user_errors_are_a_failure_never_a_silent_success() {
    let server = MockServer::start().await;
    answer(
        &server,
        "RampsmithSetMediaAlt",
        fixture("file_update_user_error"),
    )
    .await;
    answer(
        &server,
        "RampsmithSetProductDescription",
        fixture("product_update_user_error"),
    )
    .await;
    let client = client(&server);

    let error = client
        .write_value(
            &Target::parse("gid://shopify/MediaImage/11", "alt").unwrap(),
            "x",
        )
        .await
        .unwrap_err();
    let AdminError::User(errors) = &error else {
        panic!("expected user errors, got {error:?}");
    };
    assert_eq!(errors[0].code.as_deref(), Some("FILE_DOES_NOT_EXIST"));
    assert_eq!(errors[0].field.as_deref().map(<[String]>::len), Some(3));
    assert!(!error.is_retryable());
    assert_eq!(error.code(), "user_errors");

    let error = client
        .write_value(
            &Target::parse("gid://shopify/Product/1", "description_html").unwrap(),
            "x",
        )
        .await
        .unwrap_err();
    assert!(matches!(error, AdminError::User(e) if e.len() == 1 && e[0].code.is_none()));
}

#[tokio::test]
async fn a_throttled_call_waits_and_runs_again() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture("throttled")))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    answer(&server, "RampsmithShop", fixture("shop")).await;
    answer(&server, "RampsmithShopOwner", fixture("shop")).await;
    let shop = client(&server).shop().await.unwrap();
    assert_eq!(shop.name, "Super Toys");
    assert_eq!(
        shop.email.as_ref().map(shopify_admin::OwnerEmail::as_str),
        Some("Owner@SuperToys.example")
    );
    // Debug output never shows the owner's address.
    assert!(
        !format!("{shop:?}").to_lowercase().contains("owner@"),
        "Debug must not show the owner's address"
    );
    assert!(
        !serde_json::to_string(&shop)
            .unwrap()
            .to_lowercase()
            .contains("owner@"),
        "the owner's address is never serialised"
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 3);
}

#[tokio::test]
async fn a_failed_read_of_the_owner_address_leaves_the_shop_read_with_no_address() {
    let server = MockServer::start().await;
    answer(&server, "RampsmithShop", fixture("shop")).await;
    answer(&server, "RampsmithShopOwner", fixture("internal_error")).await;
    let shop = client(&server).shop().await.unwrap();
    assert_eq!(shop.name, "Super Toys");
    assert!(shop.email.is_none(), "none reported");
}

#[tokio::test]
async fn a_call_that_stays_throttled_gives_up_after_its_retries() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture("throttled")))
        .mount(&server)
        .await;
    let error = client(&server).shop().await.unwrap_err();
    assert!(matches!(error, AdminError::Throttled { .. }));
    assert!(error.is_retryable());
    // The first try and three retries.
    assert_eq!(server.received_requests().await.unwrap().len(), 4);
}

#[tokio::test]
async fn http_statuses_map_to_typed_errors() {
    for (status, expected) in [
        (401_u16, AdminError::Unauthorized),
        (402, AdminError::ShopUnavailable { status: 402 }),
        (403, AdminError::AccessDenied),
        (404, AdminError::NotFound),
        (423, AdminError::ShopUnavailable { status: 423 }),
        (500, AdminError::Upstream { status: 500 }),
        (503, AdminError::Upstream { status: 503 }),
        (400, AdminError::Rejected { status: 400 }),
        (302, AdminError::Rejected { status: 302 }),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(status).insert_header("location", "http://127.0.0.1:9/x"),
            )
            .mount(&server)
            .await;
        let error = client(&server).shop().await.unwrap_err();
        assert_eq!(error, expected, "HTTP {status}");
        // A redirect is never followed: exactly one request reached the server.
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn a_429_honours_retry_after_and_then_gives_up() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "0"))
        .mount(&server)
        .await;
    let error = client(&server).shop().await.unwrap_err();
    assert_eq!(
        error,
        AdminError::Throttled {
            retry_after: Duration::ZERO
        }
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 4);
}

#[tokio::test]
async fn graphql_error_codes_map_to_typed_errors() {
    let server = MockServer::start().await;
    answer(&server, "RampsmithPages", fixture("access_denied")).await;
    answer(&server, "RampsmithShop", fixture("internal_error")).await;
    let client = client(&server);
    assert_eq!(
        client.pages(None).await.unwrap_err(),
        AdminError::AccessDenied
    );
    assert!(!AdminError::AccessDenied.is_retryable());
    let error = client.shop().await.unwrap_err();
    assert_eq!(error, AdminError::Upstream { status: 200 });
    assert!(error.is_retryable());
}

#[tokio::test]
async fn an_unreadable_body_is_a_decode_error_and_a_dead_token_is_recognised() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>maintenance</html>"))
        .mount(&server)
        .await;
    assert_eq!(
        client(&server).shop().await.unwrap_err(),
        AdminError::Decode
    );
    assert!(AdminError::Unauthorized.is_token_dead());
    assert!(!AdminError::AccessDenied.is_token_dead());
}

#[tokio::test]
async fn the_grant_check_asks_for_the_shop_id_only_and_only_a_401_is_a_dead_grant() {
    let server = MockServer::start().await;
    answer(
        &server,
        "RampsmithGrant",
        json!({"data": {"shop": {"id": "gid://shopify/Shop/1"}}}),
    )
    .await;
    client(&server).grant_check().await.unwrap();
    let request = &server.received_requests().await.unwrap()[0];
    let sent = String::from_utf8_lossy(&request.body).into_owned();
    assert!(
        sent.contains("shop { id }") && !sent.contains("themes"),
        "{sent}"
    );

    for (status, dead) in [(401, true), (403, false), (503, false)] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(status).set_body_json(json!({})))
            .mount(&server)
            .await;
        let error = client(&server).grant_check().await.unwrap_err();
        assert_eq!(error.is_token_dead(), dead, "HTTP {status}: {error:?}");
    }
}

#[tokio::test]
async fn the_throttle_follows_what_responses_report() {
    let server = MockServer::start().await;
    answer(&server, "RampsmithShop", fixture("shop")).await;
    answer(&server, "RampsmithShopOwner", fixture("shop")).await;
    let factory =
        AdminFactory::new(AdminEndpoint::Base(server.uri()), Duration::from_secs(5)).unwrap();
    let shop = ShopDomain::parse("demo-store.myshopify.com").unwrap();
    let client = factory.client(&shop, SecretString::from(TOKEN));
    client.shop().await.unwrap();
    // A second client for the same shop shares the bucket the first one corrected.
    let again = factory.client(&shop, SecretString::from(TOKEN));
    again.shop().await.unwrap();
    // Each `shop()` is two queries: the shop, and its owner's address (audit L4).
    assert_eq!(server.received_requests().await.unwrap().len(), 4);
}

#[test]
fn nothing_prints_the_token() {
    let factory = AdminFactory::new(
        AdminEndpoint::Base("http://127.0.0.1:9".to_owned()),
        Duration::from_secs(1),
    )
    .unwrap();
    let client = factory.client(
        &ShopDomain::parse("demo-store.myshopify.com").unwrap(),
        SecretString::from(TOKEN),
    );
    assert!(!format!("{client:?}").contains(TOKEN));
    assert!(!format!("{factory:?}").contains(TOKEN));
}

#[tokio::test]
async fn an_owner_is_read_again_by_its_gid_and_names_its_storefront_path() {
    let server = MockServer::start().await;
    answer(&server, "RampsmithOwner", fixture("owner_product")).await;
    let owner = client(&server)
        .owner("gid://shopify/Product/1")
        .await
        .unwrap();
    let Owner::Product(product) = &owner else {
        panic!("expected a product, got {owner:?}");
    };
    assert_eq!(product.media.len(), 2);
    assert_eq!(owner.path(), "/products/snow-globe");

    // The answer must be the object that was asked for.
    let wrong = client(&server).owner("gid://shopify/Product/2").await;
    assert!(
        matches!(wrong, Err(AdminError::ResourceMissing)),
        "{wrong:?}"
    );
}

#[tokio::test]
async fn a_page_owner_and_a_deleted_owner() {
    let server = MockServer::start().await;
    answer(&server, "RampsmithOwner", fixture("owner_page")).await;
    let owner = client(&server).owner("gid://shopify/Page/7").await.unwrap();
    assert_eq!(owner.path(), "/pages/about");
    assert!(matches!(owner, Owner::Page(ref p) if p.is_published && p.body == "<p>Hi</p>"));

    let gone = MockServer::start().await;
    answer(&gone, "RampsmithOwner", fixture("owner_missing")).await;
    let missing = client(&gone).owner("gid://shopify/Page/7").await;
    assert!(
        matches!(missing, Err(AdminError::ResourceMissing)),
        "{missing:?}"
    );
}
