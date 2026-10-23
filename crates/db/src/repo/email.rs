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

/// What the email needs to know about a shop's owner besides the address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShopContact {
    /// The store's name.
    pub store_name: String,
    /// The shop's primary locale, when it reported one.
    pub locale: Option<String>,
}

/// Whether `address` has the shape the table's check accepts (one `@`, a dot in the domain, no
/// white space). Anything else is not stored, rather than failing the read that found it.
fn plausible(address: &str) -> bool {
    let Some((local, domain)) = address.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.contains('@')
        && address.len() <= 254
        && !address.chars().any(char::is_whitespace)
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

#[cfg(test)]
mod tests {
    use super::plausible;

    #[test]
    fn plausible_addresses_match_the_tables_check() {
        assert!(plausible("owner@shop.example"));
        for bad in [
            "",
            "owner",
            "@shop.example",
            "owner@shop",
            "a@b@c.example",
            "a b@c.example",
        ] {
            assert!(!plausible(bad), "{bad}");
        }
    }
}
