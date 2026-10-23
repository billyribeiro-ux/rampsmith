//! The `email.send` job (ADR-194, ADR-270): one transactional email, rendered and sent by the
//! engine with `packages/email` through Amazon SES.
//!
//! The payload names a template and gives its typed input as JSON, never HTML or text: the
//! engine validates the input against that template's schema (an invalid one fails the job for
//! good, with the field path) and renders. The recipient is a *reference* to an address the
//! database already holds, so no address travels through the queue, the job log or a dead-letter
//! listing; the engine reads it inside the job's tenant transaction. The message key is the
//! message's idempotency key: the queue deduplicates enqueues on it, and the sender records it so
//! a retried job never sends twice.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

/// Which of the emails `packages/email` renders (`EMAIL_KINDS`). The engine's test pins this list
/// to the package's, so a template added on one side fails the other side's build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum EmailTemplate {
    /// A one-time sign-in link.
    SignInLink,
    /// Confirm an email address.
    EmailVerification,
    /// The founder's delivery check.
    DeliveryTest,
    /// Confirm a free-scanner request.
    ScannerConfirm,
    /// The free scanner's report.
    ScannerReport,
    /// After install.
    Welcome,
    /// The first scan finished.
    FirstScanComplete,
    /// The weekly summary.
    WeeklySummary,
    /// New failures appeared.
    RegressionAlert,
    /// A shopper's barrier report arrived.
    BarrierReportReceived,
    /// A fix was approved.
    FixApproved,
    /// A fix was verified.
    FixVerified,
    /// The plan changed.
    PlanChanged,
    /// A plan limit was reached.
    UsageLimit,
    /// An agency invitation.
    AgencyInvitation,
    /// A store-link code.
    StoreLinkCode,
    /// A store was linked.
    StoreLinked,
    /// Data was deleted.
    DataDeletion,
    /// The link to export the remediation record after an uninstall (PLAN §19).
    UninstallExport,
    /// A confirmed security incident.
    IncidentNotice,
    /// A subprocessor change.
    SubprocessorChange,
}

impl EmailTemplate {
    /// Every template, in the order `packages/email` lists them.
    pub const ALL: [Self; 21] = [
        Self::SignInLink,
        Self::EmailVerification,
        Self::DeliveryTest,
        Self::ScannerConfirm,
        Self::ScannerReport,
        Self::Welcome,
        Self::FirstScanComplete,
        Self::WeeklySummary,
        Self::RegressionAlert,
        Self::BarrierReportReceived,
        Self::FixApproved,
        Self::FixVerified,
        Self::PlanChanged,
        Self::UsageLimit,
        Self::AgencyInvitation,
        Self::StoreLinkCode,
        Self::StoreLinked,
        Self::DataDeletion,
        Self::UninstallExport,
        Self::IncidentNotice,
        Self::SubprocessorChange,
    ];
}

/// Where the address comes from. The engine resolves it inside the job's tenant transaction, so
/// a reference to another tenant's row finds nothing and the job fails for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EmailRecipient {
    /// The owner's address that `shopify.read_store` and `shop/update` read from the shop
    /// (`shop_contacts`, ADR-272).
    ShopOwner {
        /// The `shopify_shops.id`.
        #[schemars(with = "String", extend("format" = "uuid"))]
        shop_id: Uuid,
    },
}

/// Payload of `email.send` jobs, schema `email.send@1`. Runs in the engine, which holds the SES
/// credentials and no Shopify token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EmailSend {
    /// Which email to render.
    pub template: EmailTemplate,
    /// Whom to send it to.
    pub recipient: EmailRecipient,
    /// The template's input, as `packages/email` defines it (camelCase members). Validated by the
    /// engine, which fails the job permanently when it does not fit; it holds the data the email
    /// shows, so it is cleared with the rest of the job's payload on `shop/redact`.
    pub input: Map<String, Value>,
    /// Identifies the logical message: the same key is never sent twice. 8 to 200 characters of
    /// `A-Z a-z 0-9 . _ : -`; build it from what causes the email, such as
    /// `uninstall-export:<webhook event id>`.
    #[schemars(regex(pattern = r"^[A-Za-z0-9._:-]{8,200}$"))]
    pub message_key: String,
}

impl EmailSend {
    /// The queue.
    pub const QUEUE: &'static str = "email.send";
    /// The payload schema and version.
    pub const SCHEMA: &'static str = "email.send@1";
    /// Longest message key.
    pub const MESSAGE_KEY_MAX: usize = 200;

    /// Whether `key` is a valid message key.
    #[must_use]
    pub fn valid_message_key(key: &str) -> bool {
        (8..=Self::MESSAGE_KEY_MAX).contains(&key.len())
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    }

    /// The job's queue-level idempotency key: one `email.send` job per message key.
    #[must_use]
    pub fn idempotency_key(&self) -> String {
        format!("{}:{}", Self::QUEUE, self.message_key)
    }
}

/// The input of the `uninstall_export` template (`packages/email/src/templates/privacy.ts`),
/// built by `ctl` when a shop uninstalls. The members are the template's own camelCase names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UninstallExportInput {
    /// The store's name, as the shop reported it.
    pub store_name: String,
    /// When the data is deleted (RFC 3339, UTC). The remediation record travels as an attachment
    /// the mailer builds (ADR-277), not as a link.
    pub delete_at: String,
    /// The recipient's language, a BCP 47 tag; English when absent or unsupported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

impl UninstallExportInput {
    /// The input as the payload's `input` member.
    #[must_use]
    pub fn into_map(self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        }
    }
}

/// The longest store name an email shows (`STORE_NAME_MAX` in `packages/email`). Shopify allows
/// longer names; the template refuses them, which would fail the job for good.
pub const STORE_NAME_MAX: usize = 100;

/// `name` cut to what the emails accept, on a character boundary.
#[must_use]
pub fn email_store_name(name: &str) -> String {
    name.trim().chars().take(STORE_NAME_MAX).collect()
}

/// The input of the `welcome` template, built by `ctl` the first time a shop's contact is
/// stored. The link into the app is added by the mailer (ADR-279).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WelcomeInput {
    /// The store's name, as the shop reported it.
    pub store_name: String,
    /// The recipient's language, a BCP 47 tag; English when absent or unsupported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

impl WelcomeInput {
    /// The input as the payload's `input` member.
    #[must_use]
    pub fn into_map(self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id(n: u128) -> String {
        Uuid::from_u128(n).to_string()
    }

    #[test]
    fn the_payload_round_trips_and_is_strict() {
        let wire = json!({
            "template": "uninstall_export",
            "recipient": {"kind": "shop_owner", "shop_id": id(3)},
            "input": {"storeName": "Example"},
            "message_key": "uninstall-export:0192f3a4"
        });
        let parsed: EmailSend = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(parsed.template, EmailTemplate::UninstallExport);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), wire);
        assert_eq!(
            parsed.idempotency_key(),
            "email.send:uninstall-export:0192f3a4"
        );
        for (member, value) in [
            ("template", json!("newsletter")),
            (
                "recipient",
                json!({"kind": "address", "value": "a@b.example"}),
            ),
            ("recipient", json!({"kind": "shop_owner", "shop_id": "x"})),
            (
                "recipient",
                json!({"kind": "shop_owner", "shop_id": id(3), "address": "a@b.example"}),
            ),
            ("input", json!("<p>raw html</p>")),
            ("body_html", json!("<p>raw html</p>")),
        ] {
            let mut bad = wire.clone();
            bad[member] = value;
            assert!(
                serde_json::from_value::<EmailSend>(bad).is_err(),
                "{member} should be refused"
            );
        }
    }

    #[test]
    fn message_keys_are_checked_like_the_senders_guard() {
        for ok in [
            "uninstall-export:0192f3a4",
            "a.b_c:D-1234",
            &"k".repeat(200),
        ] {
            assert!(EmailSend::valid_message_key(ok), "{ok}");
        }
        for bad in [
            "short",
            "has space in it",
            "line\nbreak-key-1234",
            &"k".repeat(201),
        ] {
            assert!(!EmailSend::valid_message_key(bad), "{bad:?}");
        }
    }

    #[test]
    fn store_names_are_cut_to_what_the_emails_accept() {
        assert_eq!(email_store_name("  Demo  "), "Demo");
        let long = "é".repeat(150);
        assert_eq!(email_store_name(&long).chars().count(), STORE_NAME_MAX);
    }

    #[test]
    fn the_welcome_input_has_the_templates_member_names() {
        let input = WelcomeInput {
            store_name: "Demo".to_owned(),
            locale: Some("fr".to_owned()),
        };
        assert_eq!(
            Value::Object(input.into_map()),
            json!({"storeName": "Demo", "locale": "fr"})
        );
    }

    #[test]
    fn the_uninstall_export_input_has_the_templates_member_names() {
        let input = UninstallExportInput {
            store_name: "Example Outfitters".to_owned(),
            delete_at: "2026-10-24T18:30:00Z".to_owned(),
            locale: None,
        };
        assert_eq!(
            Value::Object(input.clone().into_map()),
            json!({
                "storeName": "Example Outfitters",
                "deleteAt": "2026-10-24T18:30:00Z"
            })
        );
        let with_locale = UninstallExportInput {
            locale: Some("fr".to_owned()),
            ..input
        };
        assert_eq!(with_locale.into_map()["locale"], json!("fr"));
    }

    #[test]
    fn every_template_has_a_distinct_snake_case_name() {
        let names: Vec<String> = EmailTemplate::ALL
            .iter()
            .map(|t| {
                serde_json::to_value(t)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 21);
        assert!(names.contains(&"uninstall_export".to_owned()));
    }
}
