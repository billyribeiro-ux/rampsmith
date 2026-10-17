//! Shopify identifiers used by plan state, validated on the way in, and the hosted plan
//! selection page URL (<https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/redirect-plan-selection-page>).

use std::fmt;
use std::str::FromStr;

/// An identifier did not have the expected shape.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    /// Not a `<handle>.myshopify.com` domain.
    #[error("{0:?} is not a myshopify.com shop domain")]
    ShopDomain(String),
    /// Not an app handle (lower-case letters, digits and hyphens).
    #[error("{0:?} is not an app handle")]
    AppHandle(String),
    /// Not a Shopify global ID of the expected resource type.
    #[error("{input:?} is not a gid://shopify/{resource}/<number> ID")]
    Gid {
        /// The input.
        input: String,
        /// The expected resource type, such as `Shop`.
        resource: &'static str,
    },
    /// Not a Partner organization ID (digits only).
    #[error("{0:?} is not a Partner organization ID")]
    OrganizationId(String),
}

const MYSHOPIFY_SUFFIX: &str = ".myshopify.com";

fn is_handle(text: &str) -> bool {
    let mut bytes = text.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// A shop's permanent `*.myshopify.com` domain, lower-cased. The accepted shape is the
/// `shopify_shops.shop_domain` check constraint: `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ShopDomain(String);

impl ShopDomain {
    /// Validates and lower-cases a shop domain.
    pub fn parse(input: &str) -> Result<Self, IdError> {
        let lowered = input.to_ascii_lowercase();
        match lowered.strip_suffix(MYSHOPIFY_SUFFIX) {
            Some(handle) if handle.len() <= 255 && is_handle(handle) => Ok(Self(lowered)),
            _ => Err(IdError::ShopDomain(input.to_owned())),
        }
    }

    /// The domain, such as `cool-shop.myshopify.com`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The store handle used in Shopify admin URLs: the domain without `.myshopify.com`,
    /// such as `cool-shop`.
    #[must_use]
    pub fn store_handle(&self) -> &str {
        self.0.strip_suffix(MYSHOPIFY_SUFFIX).unwrap_or(&self.0)
    }
}

impl fmt::Display for ShopDomain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for ShopDomain {
    type Err = IdError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

/// The app's `handle` from `shopify.app.toml`, which names it in Shopify admin URLs.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AppHandle(String);

impl AppHandle {
    /// Validates an app handle: lower-case letters, digits and hyphens, starting with a letter
    /// or digit.
    pub fn parse(input: &str) -> Result<Self, IdError> {
        if input.len() <= 255 && is_handle(input) {
            Ok(Self(input.to_owned()))
        } else {
            Err(IdError::AppHandle(input.to_owned()))
        }
    }

    /// The handle.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AppHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Shopify's hosted plan selection page for this shop and app. The embedded app must open it
/// in the top frame (`target: "_top"`), because it is outside the app's iframe.
#[must_use]
pub fn plan_selection_url(shop: &ShopDomain, app: &AppHandle) -> String {
    // Both parts are validated to [a-z0-9-], so no percent-encoding is needed.
    format!(
        "https://admin.shopify.com/store/{}/charges/{}/pricing_plans",
        shop.store_handle(),
        app.as_str()
    )
}

fn parse_gid(input: &str, resource: &'static str) -> Result<u64, IdError> {
    let error = || IdError::Gid {
        input: input.to_owned(),
        resource,
    };
    let number = input
        .strip_prefix("gid://shopify/")
        .and_then(|rest| rest.strip_prefix(resource))
        .and_then(|rest| rest.strip_prefix('/'))
        .ok_or_else(error)?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(error());
    }
    number.parse().map_err(|_| error())
}

macro_rules! gid_type {
    ($(#[$doc:meta])* $name:ident => $resource:literal) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $name(u64);

        impl $name {
            #[doc = concat!("Parses `gid://shopify/", $resource, "/<number>`.")]
            pub fn parse(input: &str) -> Result<Self, IdError> {
                parse_gid(input, $resource).map(Self)
            }

            /// The numeric ID.
            #[must_use]
            pub const fn number(self) -> u64 {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!("gid://shopify/", $resource, "/{}"), self.0)
            }
        }

        impl FromStr for $name {
            type Err = IdError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::parse(s)
            }
        }
    };
}

gid_type!(
    /// A shop's global ID, read from the Admin API's `shop { id }`. The Partner API's
    /// `activeSubscription` takes it as `shopId`.
    ShopGid => "Shop"
);
gid_type!(
    /// The app's global ID (`SHOPIFY_APP_GID`), the Partner API's `appId`.
    AppGid => "App"
);

/// The Partner organization ID in the Partner API URL (`SHOPIFY_PARTNER_ORG_ID`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PartnerOrganizationId(u64);

impl PartnerOrganizationId {
    /// Parses the numeric ID shown in the Partner Dashboard URL.
    pub fn parse(input: &str) -> Result<Self, IdError> {
        if input.is_empty() || !input.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(IdError::OrganizationId(input.to_owned()));
        }
        input
            .parse()
            .map(Self)
            .map_err(|_| IdError::OrganizationId(input.to_owned()))
    }
}

impl fmt::Display for PartnerOrganizationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shop_domains_follow_the_database_constraint() {
        let shop = ShopDomain::parse("Cool-Shop.myshopify.com").unwrap();
        assert_eq!(shop.as_str(), "cool-shop.myshopify.com");
        assert_eq!(shop.store_handle(), "cool-shop");
        assert_eq!(
            ShopDomain::parse("9shop.myshopify.com")
                .unwrap()
                .store_handle(),
            "9shop"
        );
        for bad in [
            "",
            ".myshopify.com",
            "-shop.myshopify.com",
            "shop.myshopify.com.evil.com",
            "shop.example.com",
            "sh op.myshopify.com",
            "shop_1.myshopify.com",
            "a.b.myshopify.com",
            "https://shop.myshopify.com",
            "shop.myshopify.com/",
        ] {
            assert_eq!(
                ShopDomain::parse(bad),
                Err(IdError::ShopDomain(bad.to_owned())),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn app_handles_are_url_safe() {
        assert_eq!(AppHandle::parse("rampsmith").unwrap().as_str(), "rampsmith");
        assert!(AppHandle::parse("rampsmith-dev-2").is_ok());
        for bad in [
            "",
            "Rampsmith",
            "-rampsmith",
            "ramp smith",
            "ramp/smith",
            "ramp?x=1",
        ] {
            assert_eq!(
                AppHandle::parse(bad),
                Err(IdError::AppHandle(bad.to_owned()))
            );
        }
    }

    #[test]
    fn plan_selection_url_matches_the_documented_template() {
        let shop = ShopDomain::parse("cool-shop.myshopify.com").unwrap();
        let app = AppHandle::parse("rampsmith").unwrap();
        assert_eq!(
            plan_selection_url(&shop, &app),
            "https://admin.shopify.com/store/cool-shop/charges/rampsmith/pricing_plans"
        );
    }

    #[test]
    fn gids_round_trip_and_reject_other_resources() {
        let shop = ShopGid::parse("gid://shopify/Shop/5678").unwrap();
        assert_eq!(shop.number(), 5678);
        assert_eq!(shop.to_string(), "gid://shopify/Shop/5678");
        assert_eq!(
            AppGid::parse("gid://shopify/App/1234").unwrap().number(),
            1234
        );
        for bad in [
            "gid://shopify/App/5678",
            "gid://shopify/Shop/",
            "gid://shopify/Shop/12a",
            "gid://shopify/Shop/-1",
            "gid://shopify/Shopx/1",
            "gid://partners/Shop/1",
            "5678",
            "gid://shopify/Shop/99999999999999999999999",
        ] {
            assert_eq!(
                ShopGid::parse(bad),
                Err(IdError::Gid {
                    input: bad.to_owned(),
                    resource: "Shop"
                }),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn organization_ids_are_digits() {
        assert_eq!(
            PartnerOrganizationId::parse("123456").unwrap().to_string(),
            "123456"
        );
        for bad in ["", "12a", "-1", "1 2", "99999999999999999999999"] {
            assert_eq!(
                PartnerOrganizationId::parse(bad),
                Err(IdError::OrganizationId(bad.to_owned()))
            );
        }
    }
}
