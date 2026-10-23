//! Job payloads of the R1 scan-and-fix pipeline (PLAN §5 R1, §10, §11, §12; ADR-036).
//!
//! Who runs what: `ctl` holds the Shopify tokens, so it runs every Admin API job
//! (`shopify.read_store`, `shopify.apply_data_fix`, `shopify.revert_data_fix`,
//! `webhook.process`). The engine never holds a token (ADR-035): it plans and scans pages
//! (`scan.plan`, `scan.page@2`, `scan.finalize`), audits store data that `ctl` has already read
//! into `scan_inputs` (`audit.data`), drafts alt text (`ai.alt_text`) and runs verification
//! scans (`verify.scan`). Every job's tenant is the tenant that owns the ids in its payload.
//!
//! The vocabulary enums are inlined into each schema, so the TypeScript generated from two
//! schemas never declares the same type twice.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One of the eight page types R1 scans (PLAN §5, "R1 detail").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum PageType {
    /// The home page.
    Home,
    /// A collection page.
    Collection,
    /// A product page.
    Product,
    /// The cart page.
    Cart,
    /// Search results.
    Search,
    /// The customer account login page.
    Login,
    /// A standard page.
    Page,
    /// A blog article.
    Article,
}

impl PageType {
    /// Every page type, in PLAN §5's order.
    pub const ALL: [Self; 8] = [
        Self::Home,
        Self::Collection,
        Self::Product,
        Self::Cart,
        Self::Search,
        Self::Login,
        Self::Page,
        Self::Article,
    ];

    /// Whether the page is on the purchase path, which doubles a finding's priority (PLAN §11).
    #[must_use]
    pub const fn on_purchase_path(self) -> bool {
        matches!(self, Self::Product | Self::Cart | Self::Search)
    }
}

/// The viewport a page is loaded at (PLAN §11: desktop 1280×800, mobile 390×844).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum Viewport {
    /// 1280×800.
    Desktop,
    /// 390×844.
    Mobile,
}

/// The interactive state a page is checked in. Spelled as `crates/domain`'s `PageState` and
/// `packages/a11y-rules`' `PAGE_STATES`; the `spellings` test below pins them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum PageState {
    /// As loaded.
    Default,
    /// Main navigation opened by keyboard.
    NavOpen,
    /// Cart drawer open after add-to-cart.
    CartDrawer,
    /// A variant picker changed.
    VariantChanged,
    /// The first modal or popup found.
    Modal,
}

/// Payload of `shopify.read_store` jobs, schema `shopify.read_store@1`. Runs in `ctl`: reads the
/// shop (primary domain, locales) and the store data R1 audits (products' media, collections,
/// pages, articles, menus) through the Admin API into `scan_inputs`, then enqueues `scan.plan`
/// and one `audit.data` per input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShopifyReadStore {
    /// The `scans.id` the read feeds.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub scan_id: Uuid,
    /// The `sites.id` of the store.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub site_id: Uuid,
    /// The `shopify_shops.id` whose token `ctl` uses.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub shop_id: Uuid,
}

impl ShopifyReadStore {
    /// The queue.
    pub const QUEUE: &'static str = "shopify.read_store";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "shopify.read_store@1";
}

/// Payload of `scan.plan` jobs, schema `scan.plan@1`. Runs in the engine: chooses the pages of
/// the eight types from what `shopify.read_store` stored, writes the plan on the scan, and
/// enqueues the first `scan.page@2` jobs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanPlan {
    /// The `scans.id` to plan.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub scan_id: Uuid,
    /// The `sites.id` scanned; it must be verified.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub site_id: Uuid,
}

impl ScanPlan {
    /// The queue.
    pub const QUEUE: &'static str = "scan.plan";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "scan.plan@1";
}

/// Payload of `scan.page` jobs, schema `scan.page@2`. Runs in the engine: loads `url` at the
/// viewport, checks it in each state in order, and records the findings. It replaced
/// `scan.page@1`, which carried only the URL; `@1` was removed once nothing enqueued it
/// (ADR-036, ADR-264).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanPageV2 {
    /// The `scans.id` this page belongs to.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub scan_id: Uuid,
    /// The `sites.id` the page is on; it must be verified.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub site_id: Uuid,
    /// The page to load: an `https://` URL on the site's primary or `myshopify.com` host.
    #[schemars(extend("format" = "uri"))]
    pub url: String,
    /// Which of the eight page types this is.
    pub page_type: PageType,
    /// The viewport to load it at.
    pub viewport: Viewport,
    /// The states to check, in order; `default` comes first when present.
    #[schemars(length(min = 1, max = 5))]
    pub states: Vec<PageState>,
    /// The page's position in the scan plan, from 0; it keys the job's idempotency.
    pub seq: u32,
}

impl ScanPageV2 {
    /// The queue.
    pub const QUEUE: &'static str = "scan.page";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "scan.page@2";
}

/// Payload of `scan.finalize` jobs, schema `scan.finalize@1`. Runs in the engine once every
/// planned page and data input is done: ranks findings (PLAN §11 score), closes findings not
/// seen again, records `checks_run` and `checks_passed`, and writes the coverage disclosure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScanFinalize {
    /// The `scans.id` to finish.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub scan_id: Uuid,
    /// The `sites.id` scanned.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub site_id: Uuid,
}

impl ScanFinalize {
    /// The queue.
    pub const QUEUE: &'static str = "scan.finalize";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "scan.finalize@1";
}

/// Payload of `audit.data` jobs, schema `audit.data@1`. Runs in the engine: audits one stored
/// batch of store data (alt text, rich text, menus) with `packages/a11y-rules`' data audit,
/// without a browser and without a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AuditData {
    /// The `scans.id` the findings belong to.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub scan_id: Uuid,
    /// The `sites.id` audited.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub site_id: Uuid,
    /// The `scan_inputs.id` holding the batch.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub input_id: Uuid,
}

impl AuditData {
    /// The queue.
    pub const QUEUE: &'static str = "audit.data";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "audit.data@1";
}

/// Payload of `ai.alt_text` jobs, schema `ai.alt_text@1`. Runs in the engine: fetches the image
/// through egress, drafts alt text with `packages/ai` within the store's budget, and proposes a
/// data fix for the merchant to approve. Nothing is written to Shopify here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AiAltText {
    /// The `sites.id` the image belongs to.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub site_id: Uuid,
    /// The `findings.id` of the missing or poor alt text.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub finding_id: Uuid,
    /// The `scan_inputs.id` holding the image's context (product title, existing alt text).
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub input_id: Uuid,
    /// The Shopify GID of the media image, such as `gid://shopify/MediaImage/1`.
    #[schemars(length(max = 200))]
    pub resource_gid: String,
}

impl AiAltText {
    /// The queue.
    pub const QUEUE: &'static str = "ai.alt_text";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "ai.alt_text@1";
}

/// Payload of `verify.scan` jobs, schema `verify.scan@1`. Runs in the engine after a fix is
/// applied: rescans the pages that showed the finding and records whether it is gone and
/// whether anything new appeared (PLAN §5, "What each fix must carry").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VerifyScan {
    /// The verification scan's `scans.id`.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub scan_id: Uuid,
    /// The `sites.id` verified.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub site_id: Uuid,
    /// The `fixes.id` being verified.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub fix_id: Uuid,
    /// The `scan_inputs.id` holding the re-read store data, when the fix changed data.
    #[schemars(with = "Option<String>", extend("format" = "uuid"))]
    pub input_id: Option<Uuid>,
    /// The pages to rescan: `https://` URLs on the site.
    #[schemars(length(min = 1, max = 20))]
    pub urls: Vec<String>,
}

impl VerifyScan {
    /// The queue.
    pub const QUEUE: &'static str = "verify.scan";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "verify.scan@1";
}

/// Payload of `shopify.apply_data_fix` jobs, schema `shopify.apply_data_fix@1`. Runs in `ctl`:
/// writes an approved data fix through the Admin API after checking that the current value
/// still equals the snapshot taken when the fix was proposed, then re-reads it and enqueues
/// `verify.scan`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShopifyApplyDataFix {
    /// The approved `fixes.id`.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub fix_id: Uuid,
    /// The `shopify_shops.id` whose token `ctl` uses.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub shop_id: Uuid,
}

impl ShopifyApplyDataFix {
    /// The queue.
    pub const QUEUE: &'static str = "shopify.apply_data_fix";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "shopify.apply_data_fix@1";
}

/// Payload of `shopify.revert_data_fix` jobs, schema `shopify.revert_data_fix@1`. Runs in
/// `ctl`: restores the snapshot of an applied data fix, only if the current value still equals
/// what the fix wrote (one-click undo, PLAN §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShopifyRevertDataFix {
    /// The applied `fixes.id`.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub fix_id: Uuid,
    /// The `shopify_shops.id` whose token `ctl` uses.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub shop_id: Uuid,
}

impl ShopifyRevertDataFix {
    /// The queue.
    pub const QUEUE: &'static str = "shopify.revert_data_fix";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "shopify.revert_data_fix@1";
}

/// Payload of `webhook.process` jobs, schema `webhook.process@1`. Runs in `ctl`: handles one
/// verified Shopify webhook already recorded in `webhook_events` (app uninstall, shop update,
/// the compliance topics). The body is read from that row, never from the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WebhookProcess {
    /// The `webhook_events.id` to process.
    #[schemars(with = "String", extend("format" = "uuid"))]
    pub event_id: Uuid,
}

impl WebhookProcess {
    /// The queue.
    pub const QUEUE: &'static str = "webhook.process";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "webhook.process@1";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn round_trip<T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(wire: &Value) {
        let parsed: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(&serde_json::to_value(&parsed).unwrap(), wire);
        let mut extra = wire.clone();
        extra
            .as_object_mut()
            .unwrap()
            .insert("extra".to_owned(), json!(1));
        assert!(
            serde_json::from_value::<T>(extra).is_err(),
            "unknown members must be refused"
        );
    }

    fn id(n: u128) -> String {
        Uuid::from_u128(n).to_string()
    }

    #[test]
    fn every_payload_round_trips_and_refuses_unknown_members() {
        round_trip::<ShopifyReadStore>(
            &json!({"scan_id": id(1), "site_id": id(2), "shop_id": id(3)}),
        );
        round_trip::<ScanPlan>(&json!({"scan_id": id(1), "site_id": id(2)}));
        round_trip::<ScanPageV2>(&json!({
            "scan_id": id(1), "site_id": id(2), "url": "https://example.myshopify.com/cart",
            "page_type": "cart", "viewport": "mobile",
            "states": ["default", "cart_drawer"], "seq": 3
        }));
        round_trip::<ScanFinalize>(&json!({"scan_id": id(1), "site_id": id(2)}));
        round_trip::<AuditData>(&json!({"scan_id": id(1), "site_id": id(2), "input_id": id(4)}));
        round_trip::<AiAltText>(&json!({
            "site_id": id(2), "finding_id": id(5), "input_id": id(4),
            "resource_gid": "gid://shopify/MediaImage/1"
        }));
        round_trip::<VerifyScan>(&json!({
            "scan_id": id(1), "site_id": id(2), "fix_id": id(6), "input_id": null,
            "urls": ["https://example.myshopify.com/products/a"]
        }));
        round_trip::<ShopifyApplyDataFix>(&json!({"fix_id": id(6), "shop_id": id(3)}));
        round_trip::<ShopifyRevertDataFix>(&json!({"fix_id": id(6), "shop_id": id(3)}));
        round_trip::<WebhookProcess>(&json!({"event_id": id(7)}));
    }

    #[test]
    fn bad_ids_and_unknown_vocabulary_are_refused() {
        assert!(
            serde_json::from_value::<ScanPlan>(json!({"scan_id": "x", "site_id": id(2)})).is_err()
        );
        let page = |field: &str, value: Value| {
            let mut wire = json!({
                "scan_id": id(1), "site_id": id(2), "url": "https://a.myshopify.com/",
                "page_type": "home", "viewport": "desktop", "states": ["default"], "seq": 0
            });
            wire[field] = value;
            serde_json::from_value::<ScanPageV2>(wire)
        };
        assert!(page("page_type", json!("checkout")).is_err());
        assert!(page("viewport", json!("tablet")).is_err());
        assert!(page("states", json!(["hover"])).is_err());
        assert!(page("seq", json!(-1)).is_err());
    }

    #[test]
    fn spellings_match_the_domain_and_the_rule_package() {
        // crates/domain PageState and packages/a11y-rules PAGE_STATES use these exact strings;
        // packages/a11y-rules/test/spellings.test.ts reads them from the Rust source.
        let states: Vec<Value> = [
            PageState::Default,
            PageState::NavOpen,
            PageState::CartDrawer,
            PageState::VariantChanged,
            PageState::Modal,
        ]
        .iter()
        .map(|s| serde_json::to_value(s).unwrap())
        .collect();
        assert_eq!(
            states,
            [
                "default",
                "nav_open",
                "cart_drawer",
                "variant_changed",
                "modal"
            ]
            .map(Value::from)
            .to_vec()
        );
        let types: Vec<Value> = PageType::ALL
            .iter()
            .map(|t| serde_json::to_value(t).unwrap())
            .collect();
        assert_eq!(
            types,
            [
                "home",
                "collection",
                "product",
                "cart",
                "search",
                "login",
                "page",
                "article"
            ]
            .map(Value::from)
            .to_vec()
        );
    }

    #[test]
    fn only_product_cart_and_search_are_on_the_purchase_path() {
        let on: Vec<PageType> = PageType::ALL
            .into_iter()
            .filter(|t| t.on_purchase_path())
            .collect();
        assert_eq!(on, [PageType::Product, PageType::Cart, PageType::Search]);
    }

    #[test]
    fn queues_are_unique_and_schemas_name_their_queue() {
        let pairs = [
            (ShopifyReadStore::QUEUE, ShopifyReadStore::SCHEMA),
            (ScanPlan::QUEUE, ScanPlan::SCHEMA),
            (ScanPageV2::QUEUE, ScanPageV2::SCHEMA),
            (ScanFinalize::QUEUE, ScanFinalize::SCHEMA),
            (AuditData::QUEUE, AuditData::SCHEMA),
            (AiAltText::QUEUE, AiAltText::SCHEMA),
            (VerifyScan::QUEUE, VerifyScan::SCHEMA),
            (ShopifyApplyDataFix::QUEUE, ShopifyApplyDataFix::SCHEMA),
            (ShopifyRevertDataFix::QUEUE, ShopifyRevertDataFix::SCHEMA),
            (WebhookProcess::QUEUE, WebhookProcess::SCHEMA),
        ];
        let mut queues: Vec<&str> = pairs.iter().map(|(q, _)| *q).collect();
        queues.sort_unstable();
        queues.dedup();
        assert_eq!(queues.len(), pairs.len());
        for (queue, schema) in pairs {
            assert!(schema.starts_with(&format!("{queue}@")), "{schema}");
        }
    }
}
