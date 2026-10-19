use std::fmt;

/// A shop's permanent `*.myshopify.com` host, lowercased. The same rule as the
/// `shopify_shops.shop_domain` check constraint.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ShopDomain(String);

/// The text is not a `*.myshopify.com` host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("not a valid *.myshopify.com shop domain")]
pub struct InvalidShopDomain;

const SUFFIX: &str = ".myshopify.com";

impl ShopDomain {
    /// Validates a bare host such as `demo-store.myshopify.com` (any case).
    pub fn parse(host: &str) -> Result<Self, InvalidShopDomain> {
        let host = host.to_ascii_lowercase();
        let name = host.strip_suffix(SUFFIX).ok_or(InvalidShopDomain)?;
        let valid = host.len() <= 255
            && name
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if valid {
            Ok(Self(host))
        } else {
            Err(InvalidShopDomain)
        }
    }

    /// Parses an `https://<shop>` origin with no path, as in a session token's `dest`.
    pub fn from_origin(origin: &str) -> Result<Self, InvalidShopDomain> {
        Self::parse(origin.strip_prefix("https://").ok_or(InvalidShopDomain)?)
    }

    /// The host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `https://<shop>`.
    #[must_use]
    pub fn origin(&self) -> String {
        format!("https://{}", self.0)
    }
}

impl fmt::Display for ShopDomain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
