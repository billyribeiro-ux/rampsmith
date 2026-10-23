//! The emails `ctl` queues when something happens to a shop (ADR-279): the welcome email, when
//! the shop's owner contact is first stored. The ones the scan pipeline queues
//! (`first_scan_complete`, `weekly_summary`, `fix_verified`) come from the engine, which has
//! the results.
//!
//! Whether the merchant wants the mail is not decided here: the mailer holds the suppression
//! list and the opt-outs (ADR-275) and drops a refused message with a recorded reason.

use contracts::{EmailRecipient, EmailSend, EmailTemplate, WelcomeInput, email_store_name};
use db::repo::jobs as job_repo;
use domain::ShopId;
use queue::{Failure, NewJob};

use super::{database, failure};

/// Queues the `welcome` email for `shop`: once for the shop, however many times the contact is
/// stored afterwards (the message key is the shop; the queue and the sender's ledger both refuse
/// a second). A shop that uninstalls and installs again is not welcomed twice.
pub(super) async fn queue_welcome(
    tx: &mut db::TenantTx,
    shop: ShopId,
    store_name: &str,
    locale: Option<&str>,
) -> Result<(), Failure> {
    let message = EmailSend {
        template: EmailTemplate::Welcome,
        recipient: EmailRecipient::ShopOwner {
            shop_id: shop.as_uuid(),
        },
        input: WelcomeInput {
            store_name: email_store_name(store_name),
            locale: locale.map(str::to_owned),
        }
        .into_map(),
        message_key: format!("welcome:{}", shop.as_uuid()),
    };
    let payload = serde_json::to_value(&message)
        .map_err(|e| failure(false, "payload_invalid", e.to_string()))?;
    job_repo::enqueue(
        tx,
        NewJob::new(EmailSend::QUEUE, EmailSend::SCHEMA, payload)
            .idempotency_key(message.idempotency_key())
            .max_attempts(24),
    )
    .await
    .map_err(|e| database(&e))?;
    Ok(())
}
