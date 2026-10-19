//! The Partner API `activeSubscription` operation against recorded fixtures copied from the
//! documented response shapes (shopify.dev, read 2026-10-17), plus the token-redaction rules.

// Integration tests are test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::future::Future;
use std::pin::pin;
use std::sync::Mutex;
use std::task::{Context, Poll, Waker};

use billing::partner_api::{
    ACCESS_TOKEN_HEADER, ACTIVE_SUBSCRIPTION_QUERY, ActiveSubscription, BillingCycle, ItemPrice,
    MAX_REQUESTS_PER_SECOND, PARTNER_API_VERSION, PartnerApiClient, PartnerApiError,
    PartnerCredentials, PartnerRequest, PartnerResponse, PartnerTransport, PendingUpdate,
    SubscriptionItem, TransportError, active_subscription_request, endpoint,
    parse_active_subscription,
};
use billing::{AppGid, BillingInterval, Currency, Money, PartnerOrganizationId, ShopGid};
use secrecy::{ExposeSecret, SecretString};
use time::macros::datetime;

/// A value that is obviously not a real credential; used to prove redaction.
const FAKE_TOKEN: &str = "fake-partner-token-for-redaction-test";

fn shop() -> ShopGid {
    ShopGid::parse("gid://shopify/Shop/5678").unwrap()
}

fn app() -> AppGid {
    AppGid::parse("gid://shopify/App/1234").unwrap()
}

fn credentials() -> PartnerCredentials {
    PartnerCredentials {
        organization: PartnerOrganizationId::parse("424242").unwrap(),
        access_token: SecretString::from(FAKE_TOKEN),
    }
}

fn ok(body: &str) -> PartnerResponse {
    PartnerResponse {
        status: 200,
        body: body.to_owned(),
    }
}

fn parse(body: &str) -> Result<Option<ActiveSubscription>, PartnerApiError> {
    parse_active_subscription(&ok(body), shop())
}

fn fixture(name: &str) -> String {
    let path = format!(
        "{}/tests/fixtures/partner_api/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn flat(handle: &str, cents: i64) -> SubscriptionItem {
    SubscriptionItem {
        handle: handle.to_owned(),
        price: Some(ItemPrice::FlatRate {
            amount: Money::usd_cents(cents),
            active: true,
        }),
    }
}

/// Polls a future that never waits on I/O to completion.
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(output) = future.as_mut().poll(&mut context) {
            return output;
        }
        std::thread::yield_now();
    }
}

#[test]
fn the_operation_is_the_documented_active_subscription_query() {
    assert_eq!(PARTNER_API_VERSION, "2026-10");
    assert_eq!(ACCESS_TOKEN_HEADER, "X-Shopify-Access-Token");
    assert_eq!(MAX_REQUESTS_PER_SECOND, 4);
    assert!(
        ACTIVE_SUBSCRIPTION_QUERY
            .starts_with("query ActiveSubscription($appId: ID!, $shopId: ID!) {")
    );
    assert!(
        ACTIVE_SUBSCRIPTION_QUERY.contains("activeSubscription(appId: $appId, shopId: $shopId) {")
    );
    for field in [
        "billingPeriod",
        "cancelAtEndOfCycle",
        "trialEndsAt",
        "currentBillingCycle",
        "startTime",
        "endTime",
        "items",
        "handle",
        "__typename",
        "active",
        "currency",
        "... on FlatRatePrice",
        "amount",
        "pendingUpdate",
    ] {
        assert!(ACTIVE_SUBSCRIPTION_QUERY.contains(field), "{field}");
    }
    let opens = ACTIVE_SUBSCRIPTION_QUERY.matches('{').count();
    assert_eq!(opens, ACTIVE_SUBSCRIPTION_QUERY.matches('}').count());
}

#[test]
fn the_request_targets_the_organization_endpoint_with_variables() {
    assert_eq!(
        endpoint(PartnerOrganizationId::parse("424242").unwrap()),
        "https://partners.shopify.com/424242/api/2026-10/graphql.json"
    );
    let request = active_subscription_request(&credentials(), app(), shop());
    assert_eq!(
        request.url,
        "https://partners.shopify.com/424242/api/2026-10/graphql.json"
    );
    assert_eq!(request.access_token.expose_secret(), FAKE_TOKEN);
    let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body["query"], ACTIVE_SUBSCRIPTION_QUERY);
    assert_eq!(body["variables"]["appId"], "gid://shopify/App/1234");
    assert_eq!(body["variables"]["shopId"], "gid://shopify/Shop/5678");
    assert!(
        !request.body.contains(FAKE_TOKEN),
        "the token goes in a header, not the body"
    );
}

#[test]
fn parses_the_documented_example_and_ignores_unselected_fields() {
    let parsed = parse(&fixture("documented_example")).unwrap().unwrap();
    assert_eq!(
        parsed,
        ActiveSubscription {
            billing_period: BillingInterval::Monthly,
            cancel_at_end_of_cycle: false,
            trial_ends_at: None,
            current_billing_cycle: Some(BillingCycle {
                start: datetime!(2026-04-01 00:00 UTC),
                end: datetime!(2026-05-01 00:00 UTC),
            }),
            items: vec![flat("pro_plan", 2_900)],
            pending_update: None,
        }
    );
    assert_eq!(parsed.item_handles().collect::<Vec<_>>(), ["pro_plan"]);
}

#[test]
fn null_means_no_active_subscription() {
    assert_eq!(parse(&fixture("no_active_subscription")).unwrap(), None);
}

#[test]
fn parses_monthly_yearly_trial_pending_and_cancelling_subscriptions() {
    let starter = parse(&fixture("starter_monthly")).unwrap().unwrap();
    assert_eq!(starter.items, [flat("starter", 7_900)]);
    assert_eq!(
        starter.current_billing_cycle.unwrap().start,
        datetime!(2026-10-03 14:20 UTC)
    );

    let growth = parse(&fixture("growth_yearly")).unwrap().unwrap();
    assert_eq!(growth.billing_period, BillingInterval::Yearly);
    assert_eq!(growth.items, [flat("growth", 199_000)]);

    let trial = parse(&fixture("starter_trial")).unwrap().unwrap();
    assert_eq!(trial.current_billing_cycle, None);
    assert_eq!(trial.trial_ends_at, Some(datetime!(2026-10-24 12:00 UTC)));

    let pending = parse(&fixture("pro_downgrade_pending")).unwrap().unwrap();
    assert_eq!(
        pending.pending_update,
        Some(PendingUpdate {
            billing_period: BillingInterval::Monthly,
            item_handles: vec!["starter".to_owned()],
        })
    );

    let cancelling = parse(&fixture("growth_cancel_scheduled")).unwrap().unwrap();
    assert!(cancelling.cancel_at_end_of_cycle);

    let free = parse(&fixture("free_subscription")).unwrap().unwrap();
    assert_eq!(free.items, [flat("free", 0)]);
}

#[test]
fn non_flat_prices_and_numeric_decimals_are_accepted() {
    let parsed = parse(&fixture("flat_and_tiered_items")).unwrap().unwrap();
    assert_eq!(
        parsed.items[0],
        flat("starter", 7_900),
        "79.0 as a JSON number"
    );
    assert_eq!(
        parsed.items[1],
        SubscriptionItem {
            handle: "extra_scans".to_owned(),
            price: Some(ItemPrice::Other {
                typename: "TieredPrice".to_owned(),
                currency: Currency::USD,
                active: true,
            }),
        }
    );
}

#[test]
fn documented_graphql_errors_map_to_typed_errors() {
    assert!(matches!(
        parse(&fixture("error_not_public_app")),
        Err(PartnerApiError::NotPublicApp)
    ));
    assert!(matches!(
        parse(&fixture("error_shop_not_found")),
        Err(PartnerApiError::ShopNotFound)
    ));
    let throttled = parse(&fixture("error_throttled")).unwrap_err();
    assert!(matches!(throttled, PartnerApiError::Throttled));
    assert!(throttled.is_transient());
    match parse(r#"{"errors":[{"message":"Feature not enabled"}],"data":null}"#) {
        Err(PartnerApiError::Graphql(messages)) => assert_eq!(messages, ["Feature not enabled"]),
        other => panic!("{other:?}"),
    }
}

#[test]
fn http_statuses_map_to_typed_errors() {
    let status = |code: u16| {
        parse_active_subscription(
            &PartnerResponse {
                status: code,
                body: String::new(),
            },
            shop(),
        )
        .unwrap_err()
    };
    assert!(matches!(status(401), PartnerApiError::Unauthorized));
    assert!(matches!(status(429), PartnerApiError::Throttled));
    assert!(matches!(status(500), PartnerApiError::Unavailable(500)));
    assert!(matches!(status(503), PartnerApiError::Unavailable(503)));
    assert!(matches!(
        status(400),
        PartnerApiError::UnexpectedStatus(400)
    ));
    assert!(matches!(
        status(404),
        PartnerApiError::UnexpectedStatus(404)
    ));
    assert!(status(503).is_transient());
    assert!(!status(401).is_transient());
    assert!(!status(404).is_transient());
}

#[test]
fn malformed_bodies_are_errors_not_guesses() {
    let malformed = |body: &str| matches!(parse(body), Err(PartnerApiError::Malformed(_)));
    assert!(malformed("not json"));
    assert!(malformed("{}"));
    assert!(malformed(
        r#"{"data":{"activeSubscription":{"billingPeriod":"EVERY_30_DAYS"}}}"#
    ));

    let starter = fixture("starter_monthly");
    assert!(malformed(
        &starter.replace("EVERY_30_DAYS", "EVERY_90_DAYS")
    ));
    assert!(malformed(
        &starter.replace("2026-10-03T14:20:00Z", "3 Oct 2026")
    ));
    assert!(malformed(&starter.replace("\"79.00\"", "\"79.001\"")));
    assert!(malformed(&starter.replace("\"79.00\"", "null")));
    assert!(malformed(&starter.replace("\"USD\"", "\"US\"")));
}

#[test]
fn an_answer_about_another_shop_is_rejected() {
    let other = fixture("starter_monthly").replace("Shop/5678", "Shop/9999");
    match parse(&other) {
        Err(PartnerApiError::ShopMismatch { asked, answered }) => {
            assert_eq!(asked, shop());
            assert_eq!(answered, "gid://shopify/Shop/9999");
        }
        result => panic!("{result:?}"),
    }
}

/// A transport that records the request and replays one canned result.
#[derive(Debug)]
struct FakeTransport {
    reply: Mutex<Option<Result<PartnerResponse, TransportError>>>,
    seen: Mutex<Vec<PartnerRequest>>,
}

impl FakeTransport {
    fn replying(reply: Result<PartnerResponse, TransportError>) -> Self {
        Self {
            reply: Mutex::new(Some(reply)),
            seen: Mutex::new(Vec::new()),
        }
    }
}

impl PartnerTransport for FakeTransport {
    fn send(
        &self,
        request: PartnerRequest,
    ) -> impl Future<Output = Result<PartnerResponse, TransportError>> + Send {
        self.seen.lock().unwrap().push(request);
        let reply = self
            .reply
            .lock()
            .unwrap()
            .take()
            .expect("one request per fake");
        std::future::ready(reply)
    }
}

#[test]
fn the_client_sends_one_request_and_parses_the_answer() {
    let client = PartnerApiClient::new(
        FakeTransport::replying(Ok(ok(&fixture("starter_monthly")))),
        credentials(),
        app(),
    );
    let answer = block_on(client.active_subscription(shop()))
        .unwrap()
        .unwrap();
    assert_eq!(answer.items, [flat("starter", 7_900)]);
}

#[test]
fn transport_failures_are_transient_errors() {
    let failure = TransportError(Box::new(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "timed out",
    )));
    let client = PartnerApiClient::new(FakeTransport::replying(Err(failure)), credentials(), app());
    let error = block_on(client.active_subscription(shop())).unwrap_err();
    assert!(matches!(error, PartnerApiError::Transport(_)));
    assert!(error.is_transient());
}

#[test]
fn the_token_never_appears_in_debug_output_or_errors() {
    let creds = credentials();
    let request = active_subscription_request(&creds, app(), shop());
    let transport = FakeTransport::replying(Ok(PartnerResponse {
        status: 401,
        body: String::new(),
    }));
    let client = PartnerApiClient::new(transport, creds.clone(), app());
    let error = block_on(client.active_subscription(shop())).unwrap_err();

    let rendered = [
        format!("{creds:?}"),
        format!("{request:?}"),
        format!("{client:?}"),
        format!("{error:?}"),
        error.to_string(),
    ];
    for text in &rendered {
        assert!(!text.contains(FAKE_TOKEN), "token leaked: {text}");
    }
    assert!(rendered[0].contains("REDACTED"));
    assert!(rendered[1].contains("REDACTED"));
    assert!(
        rendered[2].contains("REDACTED"),
        "the recorded request is redacted too"
    );
}
