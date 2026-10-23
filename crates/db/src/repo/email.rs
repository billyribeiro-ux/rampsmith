//! The shop owner's address and the suppression list behind `email.send` (ADR-270 to ADR-272).
//!
//! `ctl` writes the contact; the engine reads it and the suppression list through its own SQL
//! (`packages/engine/src/email`). The address is personal data: it is never returned to a
//! caller that only needs to know whether one exists, and nothing here logs it.

use domain::ShopId;

use crate::{DbError, TenantTx};

/// Why an address is on the suppression list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuppressionReason {
    /// The recipient unsubscribed; blocks notification and marketing mail.
    Unsubscribed,
    /// The address bounced for good; blocks everything.
    Bounced,
    /// The recipient complained; blocks everything.
    Complained,
    /// An operator added it; blocks everything.
    Manual,
}

impl SuppressionReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Unsubscribed => "unsubscribed",
            Self::Bounced => "bounced",
            Self::Complained => "complained",
            Self::Manual => "manual",
        }
    }
}

/// A category of mail a recipient can switch off (ADR-191, ADR-275). Security and transactional
/// mail has no category here: nobody can opt out of a sign-in link or a deletion notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OptOutCategory {
    /// Product notifications: scan results, fix updates, store activity.
    Notification,
    /// Anything promotional.
    Marketing,
}

impl OptOutCategory {
    /// Every category, in the order the screens list them.
    pub const ALL: [Self; 2] = [Self::Notification, Self::Marketing];

    /// The value stored and sent over the wire.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Notification => "notification",
            Self::Marketing => "marketing",
        }
    }

    /// The category named by `text`.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == text)
    }
}

/// What the email needs to know about a shop's owner besides the address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShopContact {
    /// The store's name.
    pub store_name: String,
    /// The shop's primary locale, when it reported one.
    pub locale: Option<String>,
}

/// Whether `address` is one the sender can use: the same rule as `isEmailAddress` in
/// `packages/email` (ASCII, a dot-separated local part of atom characters, a domain of LDH labels
/// ending in an alphabetic top-level label, at most 254 characters), which is stricter than the
/// table's check. An address that fails it is not stored, rather than failing the read that found
/// it or the insert (audit L3).
fn plausible(address: &str) -> bool {
    const ATOM: &str = "!#$%&'*+/=?^_`{|}~-";
    let Some(at) = address.rfind('@') else {
        return false;
    };
    let (local, domain) = (&address[..at], &address[at + 1..]);
    if at == 0 || address.len() > 254 || local.len() > 64 {
        return false;
    }
    let atoms_ok = local.split('.').all(|atom| {
        !atom.is_empty()
            && atom
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ATOM.contains(c))
    });
    let labels: Vec<&str> = domain.split('.').collect();
    let label_ok = |label: &str| {
        (1..=63).contains(&label.len())
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    let tld_ok = labels.last().is_some_and(|tld| {
        (2..=63).contains(&tld.len()) && tld.chars().all(|c| c.is_ascii_alphabetic())
    });
    atoms_ok && labels.len() >= 2 && labels.iter().all(|l| label_ok(l)) && tld_ok
}

/// Stores the owner's address and the store's name for an installed shop, replacing what was
/// there. Returns `false`, storing nothing, when the shop is not an installed shop of the
/// tenant or the address or name is unusable.
pub async fn put_shop_contact(
    tx: &mut TenantTx,
    shop: ShopId,
    address: &str,
    store_name: &str,
    locale: Option<&str>,
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let address = address.trim().to_lowercase();
    let name = store_name.trim();
    if !plausible(&address) || name.is_empty() || name.chars().count() > 255 {
        return Ok(false);
    }
    let locale = locale.filter(|l| (2..=35).contains(&l.len()));
    let done = sqlx::query!(
        r#"insert into shop_contacts (shop_id, tenant_id, email, store_name, locale)
           select id, tenant_id, $3, $4, $5 from shopify_shops
            where tenant_id = $1 and id = $2 and status = 'installed'
           on conflict (shop_id) do update
              set email = excluded.email, store_name = excluded.store_name,
                  locale = excluded.locale, updated_at = now()"#,
        tenant,
        shop.as_uuid(),
        address,
        name,
        locale,
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() > 0)
}

/// The store's name and language for the emails about `shop`, if a contact is stored. The
/// address stays in the database: the engine reads it where it sends.
pub async fn get_shop_contact(
    tx: &mut TenantTx,
    shop: ShopId,
) -> Result<Option<ShopContact>, DbError> {
    let tenant = tx.tenant_uuid();
    let row = sqlx::query!(
        r#"select store_name, locale from shop_contacts where tenant_id = $1 and shop_id = $2"#,
        tenant,
        shop.as_uuid(),
    )
    .fetch_optional(tx.conn())
    .await?;
    Ok(row.map(|r| ShopContact {
        store_name: r.store_name,
        locale: r.locale,
    }))
}

/// Removes the shop's contact (`shop/redact`). Returns how many rows went.
pub async fn delete_shop_contact(tx: &mut TenantTx, shop: ShopId) -> Result<u64, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        "delete from shop_contacts where tenant_id = $1 and shop_id = $2",
        tenant,
        shop.as_uuid(),
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected())
}

/// Puts `address` on the tenant's suppression list, or changes its reason. The list holds a
/// hash of the address (`email_address_hash`), not the address.
pub async fn suppress(
    tx: &mut TenantTx,
    address: &str,
    reason: SuppressionReason,
) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        r#"insert into email_suppressions (tenant_id, address_hash, reason)
           values ($1, email_address_hash($1, $2), $3)
           on conflict (tenant_id, address_hash) do update set reason = excluded.reason"#,
        tenant,
        address,
        reason.as_str(),
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// Whether `address` is on the tenant's suppression list.
pub async fn is_suppressed(tx: &mut TenantTx, address: &str) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    Ok(sqlx::query_scalar!(
        r#"select exists (select 1 from email_suppressions
                           where tenant_id = $1 and address_hash = email_address_hash($1, $2)) as "e!""#,
        tenant,
        address,
    )
    .fetch_one(tx.conn())
    .await?)
}

/// Switches `category` off for the address with this hash (`email_address_hash`). A second call
/// changes nothing.
pub async fn opt_out(
    tx: &mut TenantTx,
    address_hash: &[u8],
    category: OptOutCategory,
) -> Result<(), DbError> {
    let tenant = tx.tenant_uuid();
    sqlx::query!(
        r#"insert into email_opt_outs (tenant_id, address_hash, category)
           values ($1, $2, $3) on conflict do nothing"#,
        tenant,
        address_hash,
        category.as_str(),
    )
    .execute(tx.conn())
    .await?;
    Ok(())
}

/// Switches `category` back on for the address with this hash. Returns whether it was off.
pub async fn opt_in(
    tx: &mut TenantTx,
    address_hash: &[u8],
    category: OptOutCategory,
) -> Result<bool, DbError> {
    let tenant = tx.tenant_uuid();
    let done = sqlx::query!(
        "delete from email_opt_outs where tenant_id = $1 and address_hash = $2 and category = $3",
        tenant,
        address_hash,
        category.as_str(),
    )
    .execute(tx.conn())
    .await?;
    Ok(done.rows_affected() > 0)
}

/// The categories the address with this hash has switched off.
pub async fn opted_out(
    tx: &mut TenantTx,
    address_hash: &[u8],
) -> Result<Vec<OptOutCategory>, DbError> {
    let tenant = tx.tenant_uuid();
    let rows = sqlx::query_scalar!(
        "select category from email_opt_outs where tenant_id = $1 and address_hash = $2",
        tenant,
        address_hash,
    )
    .fetch_all(tx.conn())
    .await?;
    Ok(rows
        .iter()
        .filter_map(|text| OptOutCategory::parse(text))
        .collect())
}

/// The hash of the address the shop's notification mail goes to: the settings' notification
/// address when the merchant gave one, else the owner's (ADR-275). `None` while neither is
/// known. The address itself stays in the database, and the application role cannot read it.
pub async fn notification_address_hash(
    tx: &mut TenantTx,
    shop: ShopId,
) -> Result<Option<Vec<u8>>, DbError> {
    // A function, not a table read: the application role cannot read `shop_contacts`, so the
    // api cannot list owners' addresses (audit L6). It answers for the session's tenant only.
    let row = sqlx::query_scalar!(
        r#"select email_notification_hash($1) as "hash""#,
        shop.as_uuid(),
    )
    .fetch_one(tx.conn())
    .await?;
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::{OptOutCategory, plausible};

    #[test]
    fn categories_round_trip_through_their_wire_names() {
        for category in OptOutCategory::ALL {
            assert_eq!(OptOutCategory::parse(category.as_str()), Some(category));
        }
        for other in ["security", "transactional", "", "Notification"] {
            assert_eq!(OptOutCategory::parse(other), None, "{other}");
        }
    }

    #[test]
    fn plausible_addresses_follow_the_senders_rule_and_fit_the_tables_check() {
        assert!(plausible("owner@shop.example"));
        assert!(plausible("first.last+tag@sub.shop-name.example"));
        for bad in [
            "",
            "owner",
            "@shop.example",
            "owner@shop",
            "a@b@c.example",
            "a b@c.example",
            "owner@.com",
            "owner@shop.",
            "owner@shop..example",
            "owner@-shop.example",
            "o..wner@shop.example",
            "owner@shop.e",
            "owner@shop.123",
            "owner@shöp.example",
        ] {
            assert!(!plausible(bad), "{bad}");
        }
    }
}
