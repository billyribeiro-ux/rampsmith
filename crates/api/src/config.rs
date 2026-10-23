//! Configuration: environment variables parsed into one typed struct at boot. A missing or
//! malformed value stops the process before it serves a request (PLAN §22).

use std::net::SocketAddr;

use crypto::KeyRing;
use secrecy::SecretString;
use thiserror::Error;
use url::{Host, Url};

/// Everything the api needs from its environment.
#[derive(Debug)]
pub struct Config {
    /// PostgreSQL connection string for an application role. Secret: never logged.
    pub database_url: SecretString,
    /// Address to listen on.
    pub bind: SocketAddr,
    /// Address of the webhook listener (`WEBHOOK_BIND_ADDR`, ADR-182): a second listener that
    /// serves only `/webhooks/*`. Without it, no webhook listener starts.
    pub webhook_bind: Option<SocketAddr>,
    /// Pool size.
    pub db_max_connections: u32,
    /// Reported as `service.version`, normally the image's commit.
    pub service_version: String,
    /// The Shopify app's client id (`SHOPIFY_API_KEY`).
    pub shopify_client_id: String,
    /// The Shopify app's client secret (`SHOPIFY_API_SECRET`). Signs session tokens.
    pub shopify_client_secret: SecretString,
    /// Master keys for envelope encryption (`RAMPSMITH_MASTER_KEYS`, ADR-021).
    pub master_keys: KeyRing,
    /// Partner API access for plan confirmation (`SHOPIFY_PARTNER_ORG_ID`,
    /// `SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_APP_GID`; LAUNCH.md section C). All three or none:
    /// without them the app serves each shop's stored plan, Free until one is stored.
    pub partner: Option<PartnerConfig>,
    /// The free scanner (`FREE_SCAN_SERVICE_TOKEN`, `TURNSTILE_SECRET_KEY`, optional
    /// `TURNSTILE_ORIGIN` and `TURNSTILE_HOSTNAMES`; ADR-267). Both secrets or neither: without them the free scanner's
    /// routes answer 503 and the marketing site's form stays closed.
    pub free_scan: Option<crate::free_scan::FreeScanSettings>,
    /// The keys of the links in email and the app's origin (`EMAIL_LINK_KEYS`, `APP_ORIGIN`;
    /// ADR-274). Both or neither: without them the unsubscribe and preferences routes answer 503.
    pub email_links: Option<crate::email_link::EmailLinks>,
    /// The WebAuthn relying-party id, a registrable domain (`WEBAUTHN_RP_ID`, ADR-024).
    pub webauthn_rp_id: String,
    /// The dashboard's origin (`WEBAUTHN_RP_ORIGIN`), such as `https://app.rampsmith.com`.
    pub webauthn_rp_origin: String,
}

/// The Partner API settings for plan confirmation.
#[derive(Debug)]
pub struct PartnerConfig {
    /// The organization that owns the app.
    pub organization: billing::PartnerOrganizationId,
    /// The API client's access token. Secret: never logged.
    pub token: SecretString,
    /// The app's GID.
    pub app: billing::AppGid,
}

/// A configuration value is missing or malformed.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    /// A required variable is unset or empty.
    #[error("{0} must be set")]
    Missing(&'static str),
    /// A variable does not parse.
    #[error("{name} is invalid: {reason}")]
    Invalid {
        /// The variable.
        name: &'static str,
        /// Why it does not parse; never contains the value itself.
        reason: String,
    },
}

impl Config {
    /// Reads the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Reads from any source, for tests.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let get = |name: &str| lookup(name).filter(|v| !v.trim().is_empty());
        let database_url = get("DATABASE_URL").ok_or(ConfigError::Missing("DATABASE_URL"))?;
        if !(database_url.starts_with("postgres://") || database_url.starts_with("postgresql://")) {
            return Err(ConfigError::Invalid {
                name: "DATABASE_URL",
                reason: "must be a postgres:// URL".to_owned(),
            });
        }
        let bind = get("BIND_ADDR")
            .unwrap_or_else(|| "0.0.0.0:8080".to_owned())
            .parse()
            .map_err(|e: std::net::AddrParseError| ConfigError::Invalid {
                name: "BIND_ADDR",
                reason: e.to_string(),
            })?;
        let webhook_bind = get("WEBHOOK_BIND_ADDR")
            .map(|v| v.parse())
            .transpose()
            .map_err(|e: std::net::AddrParseError| ConfigError::Invalid {
                name: "WEBHOOK_BIND_ADDR",
                reason: e.to_string(),
            })?;
        if webhook_bind.is_some_and(|w| w == bind) {
            return Err(ConfigError::Invalid {
                name: "WEBHOOK_BIND_ADDR",
                reason:
                    "must differ from BIND_ADDR: the webhook host reaches only the webhook listener"
                        .to_owned(),
            });
        }
        let db_max_connections = get("DB_MAX_CONNECTIONS")
            .map_or(Ok(10), |v| v.parse::<u32>())
            .map_err(|e| ConfigError::Invalid {
                name: "DB_MAX_CONNECTIONS",
                reason: e.to_string(),
            })?;
        if db_max_connections == 0 {
            return Err(ConfigError::Invalid {
                name: "DB_MAX_CONNECTIONS",
                reason: "must be at least 1".to_owned(),
            });
        }
        let shopify_client_id =
            get("SHOPIFY_API_KEY").ok_or(ConfigError::Missing("SHOPIFY_API_KEY"))?;
        let shopify_client_secret =
            get("SHOPIFY_API_SECRET").ok_or(ConfigError::Missing("SHOPIFY_API_SECRET"))?;
        let master_keys = KeyRing::parse(
            &get("RAMPSMITH_MASTER_KEYS").ok_or(ConfigError::Missing("RAMPSMITH_MASTER_KEYS"))?,
        )
        .map_err(|e| ConfigError::Invalid {
            name: "RAMPSMITH_MASTER_KEYS",
            reason: e.to_string(),
        })?;
        let webauthn_rp_id = get("WEBAUTHN_RP_ID").ok_or(ConfigError::Missing("WEBAUTHN_RP_ID"))?;
        let webauthn_rp_origin =
            get("WEBAUTHN_RP_ORIGIN").ok_or(ConfigError::Missing("WEBAUTHN_RP_ORIGIN"))?;
        let rp_id = webauthn_rp_id.trim().to_owned();
        if !is_host_name(&rp_id) {
            return Err(ConfigError::Invalid {
                name: "WEBAUTHN_RP_ID",
                reason: "must be a lowercase domain name such as app.rampsmith.com, with no scheme, port or path"
                    .to_owned(),
            });
        }
        let webauthn_rp_origin =
            check_webauthn_origin(&webauthn_rp_origin, &rp_id).map_err(|reason| {
                ConfigError::Invalid {
                    name: "WEBAUTHN_RP_ORIGIN",
                    reason: reason.to_owned(),
                }
            })?;
        let partner = partner_config(&get)?;
        let free_scan = free_scan_config(&get)?;
        let email_links = email_links_config(&get)?;
        Ok(Self {
            partner,
            free_scan,
            email_links,
            webauthn_rp_id: rp_id,
            webauthn_rp_origin,
            shopify_client_id: shopify_client_id.trim().to_owned(),
            shopify_client_secret: SecretString::from(shopify_client_secret),
            master_keys,
            database_url: SecretString::from(database_url),
            bind,
            webhook_bind,
            db_max_connections,
            service_version: get("SERVICE_VERSION")
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned()),
        })
    }
}

/// The Partner API settings: all three variables or none.
fn partner_config(
    get: &impl Fn(&str) -> Option<String>,
) -> Result<Option<PartnerConfig>, ConfigError> {
    let org = get("SHOPIFY_PARTNER_ORG_ID");
    let token = get("SHOPIFY_PARTNER_API_TOKEN");
    let app = get("SHOPIFY_APP_GID");
    if org.is_none() && token.is_none() && app.is_none() {
        return Ok(None);
    }
    let org = org.ok_or(ConfigError::Missing("SHOPIFY_PARTNER_ORG_ID"))?;
    let token = token.ok_or(ConfigError::Missing("SHOPIFY_PARTNER_API_TOKEN"))?;
    let app = app.ok_or(ConfigError::Missing("SHOPIFY_APP_GID"))?;
    Ok(Some(PartnerConfig {
        organization: billing::PartnerOrganizationId::parse(org.trim()).map_err(|e| {
            ConfigError::Invalid {
                name: "SHOPIFY_PARTNER_ORG_ID",
                reason: e.to_string(),
            }
        })?,
        token: SecretString::from(token),
        app: billing::AppGid::parse(app.trim()).map_err(|e| ConfigError::Invalid {
            name: "SHOPIFY_APP_GID",
            reason: e.to_string(),
        })?,
    }))
}

/// The free scanner's settings: the service token and the Turnstile secret, both or neither.
fn free_scan_config(
    get: &impl Fn(&str) -> Option<String>,
) -> Result<Option<crate::free_scan::FreeScanSettings>, ConfigError> {
    let token = get("FREE_SCAN_SERVICE_TOKEN");
    let secret = get("TURNSTILE_SECRET_KEY");
    if token.is_none() && secret.is_none() {
        return Ok(None);
    }
    let token = token.ok_or(ConfigError::Missing("FREE_SCAN_SERVICE_TOKEN"))?;
    let secret = secret.ok_or(ConfigError::Missing("TURNSTILE_SECRET_KEY"))?;
    if token.trim().len() < crate::free_scan::MIN_SERVICE_TOKEN {
        return Err(ConfigError::Invalid {
            name: "FREE_SCAN_SERVICE_TOKEN",
            reason: format!(
                "must be at least {} characters",
                crate::free_scan::MIN_SERVICE_TOKEN
            ),
        });
    }
    let origin =
        get("TURNSTILE_ORIGIN").unwrap_or_else(|| crate::free_scan::TURNSTILE_ORIGIN.to_owned());
    let origin = Url::parse(origin.trim())
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some() && u.path() == "/")
        .ok_or(ConfigError::Invalid {
            name: "TURNSTILE_ORIGIN",
            reason: "must be an http(s) origin such as https://challenges.cloudflare.com"
                .to_owned(),
        })?;
    // The widget's hostnames, comma separated; unset checks none (development).
    let mut hostnames = Vec::new();
    for name in get("TURNSTILE_HOSTNAMES").unwrap_or_default().split(',') {
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        if !is_host_name(&name) {
            return Err(ConfigError::Invalid {
                name: "TURNSTILE_HOSTNAMES",
                reason: "must be comma-separated host names such as rampsmith.com".to_owned(),
            });
        }
        hostnames.push(name);
    }
    Ok(Some(crate::free_scan::FreeScanSettings {
        service_token: SecretString::from(token.trim().to_owned()),
        turnstile_secret: SecretString::from(secret.trim().to_owned()),
        turnstile_origin: origin,
        turnstile_hostnames: hostnames,
    }))
}

/// The email links' settings: the key ring and the app's origin, both or neither.
fn email_links_config(
    get: &impl Fn(&str) -> Option<String>,
) -> Result<Option<crate::email_link::EmailLinks>, ConfigError> {
    let keys = get("EMAIL_LINK_KEYS");
    let origin = get("APP_ORIGIN");
    if keys.is_none() && origin.is_none() {
        return Ok(None);
    }
    let keys = keys.ok_or(ConfigError::Missing("EMAIL_LINK_KEYS"))?;
    let origin = origin.ok_or(ConfigError::Missing("APP_ORIGIN"))?;
    let keys = crate::email_link::LinkKeys::parse(&keys).map_err(|e| ConfigError::Invalid {
        name: "EMAIL_LINK_KEYS",
        reason: e.to_string(),
    })?;
    let url = Url::parse(origin.trim())
        .ok()
        .filter(|u| {
            u.host().is_some()
                && u.path() == "/"
                && u.query().is_none()
                && u.fragment().is_none()
                && u.username().is_empty()
                && u.password().is_none()
                && (u.scheme() == "https"
                    || (u.scheme() == "http"
                        && matches!(u.host_str(), Some("localhost" | "127.0.0.1"))))
        })
        .ok_or(ConfigError::Invalid {
            name: "APP_ORIGIN",
            reason: "must be an https origin such as https://app.rampsmith.com".to_owned(),
        })?;
    Ok(Some(crate::email_link::EmailLinks::new(
        keys,
        &url.origin().ascii_serialization(),
    )))
}

/// A dotted name of lowercase letters, digits and hyphens, as WebAuthn relying-party ids and
/// the hosts of `https` origins are written.
fn is_host_name(name: &str) -> bool {
    name.len() <= 253
        && name.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

/// Checks the dashboard's WebAuthn origin against the relying-party id and returns it in
/// canonical form (scheme, host and a non-default port). The rules (audit L9, ADR-024):
///
/// - it parses as a URL with the same parser the identity crate uses;
/// - the scheme is `https`, or `http` only when the host is exactly `localhost`;
/// - it is an origin: a domain host (not an IP address), no user info, query or fragment, and
///   no path beyond `/`;
/// - the host is the relying-party id or a subdomain of it, compared on whole labels.
///
/// The error is a fixed sentence: it never repeats the value.
fn check_webauthn_origin(origin: &str, rp_id: &str) -> Result<String, &'static str> {
    let url = Url::parse(origin)
        .map_err(|_| "must be an absolute URL such as https://app.rampsmith.com")?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("must use https (http is allowed only for the host localhost)");
    }
    let Some(Host::Domain(host)) = url.host() else {
        return Err("must have a domain name as its host, not an IP address");
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("must be an origin: scheme, host and optional port only");
    }
    if url.scheme() == "http" && host != "localhost" {
        return Err("must use https (http is allowed only for the host localhost)");
    }
    if host != rp_id && !host.ends_with(&format!(".{rp_id}")) {
        return Err("host must be WEBAUTHN_RP_ID or a subdomain of it");
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use secrecy::ExposeSecret;

    use super::*;

    const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    /// `pairs` over a complete Shopify and key configuration; an empty value unsets.
    fn config(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let mut vars: HashMap<String, String> = [
            ("SHOPIFY_API_KEY", "0123456789abcdef"),
            ("SHOPIFY_API_SECRET", "shpss_hunter3"),
            ("RAMPSMITH_MASTER_KEYS", &format!("k1:{KEY}") as &str),
            ("WEBAUTHN_RP_ID", "app.rampsmith.test"),
            ("WEBAUTHN_RP_ORIGIN", "https://app.rampsmith.test"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        vars.extend(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
        );
        Config::from_lookup(|name| vars.get(name).cloned())
    }

    #[test]
    fn requires_a_database_url() {
        assert_eq!(
            config(&[]).unwrap_err(),
            ConfigError::Missing("DATABASE_URL")
        );
        assert_eq!(
            config(&[("DATABASE_URL", "  ")]).unwrap_err(),
            ConfigError::Missing("DATABASE_URL")
        );
    }

    #[test]
    fn rejects_a_non_postgres_url_without_echoing_it() {
        let err = config(&[("DATABASE_URL", "mysql://root:hunter2@db/x")]).unwrap_err();
        assert!(matches!(
            err,
            ConfigError::Invalid {
                name: "DATABASE_URL",
                ..
            }
        ));
        assert!(!err.to_string().contains("hunter2"));
    }

    #[test]
    fn applies_defaults() {
        let c = config(&[("DATABASE_URL", "postgres://app@db/rampsmith")]).unwrap();
        assert_eq!(c.bind, "0.0.0.0:8080".parse().unwrap());
        assert_eq!(c.db_max_connections, 10);
        assert_eq!(
            c.database_url.expose_secret(),
            "postgres://app@db/rampsmith"
        );
    }

    #[test]
    fn keeps_secrets_out_of_debug_output() {
        let c = config(&[("DATABASE_URL", "postgres://app:hunter2@db/rampsmith")]).unwrap();
        let debug = format!("{c:?}");
        assert!(!debug.contains("hunter2"));
        assert!(!debug.contains("hunter3"));
        assert!(!debug.contains(KEY));
    }

    #[test]
    fn the_email_links_need_their_keys_and_the_app_origin_or_neither() {
        let base = ("DATABASE_URL", "postgres://app@db/rampsmith");
        assert!(config(&[base]).unwrap().email_links.is_none());
        let key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
        let ring = format!("k1:{key}");
        assert_eq!(
            config(&[base, ("EMAIL_LINK_KEYS", &ring)]).unwrap_err(),
            ConfigError::Missing("APP_ORIGIN")
        );
        assert_eq!(
            config(&[base, ("APP_ORIGIN", "https://app.rampsmith.test")]).unwrap_err(),
            ConfigError::Missing("EMAIL_LINK_KEYS")
        );
        let ok = config(&[
            base,
            ("EMAIL_LINK_KEYS", &ring),
            ("APP_ORIGIN", "https://app.rampsmith.test/"),
        ])
        .unwrap();
        let links = ok.email_links.unwrap();
        assert!(!format!("{links:?}").contains(key));
        for bad in [
            "ftp://x.test",
            "https://app.rampsmith.test/path",
            "http://app.rampsmith.test",
            "https://u:p@app.rampsmith.test",
        ] {
            assert!(
                matches!(
                    config(&[base, ("EMAIL_LINK_KEYS", &ring), ("APP_ORIGIN", bad)]).unwrap_err(),
                    ConfigError::Invalid {
                        name: "APP_ORIGIN",
                        ..
                    }
                ),
                "{bad}"
            );
        }
        let short = config(&[
            base,
            ("EMAIL_LINK_KEYS", "k1:AAAA"),
            ("APP_ORIGIN", "https://a.test"),
        ])
        .unwrap_err();
        assert!(matches!(
            short,
            ConfigError::Invalid {
                name: "EMAIL_LINK_KEYS",
                ..
            }
        ));
        assert!(!short.to_string().contains("AAAA"));
    }

    #[test]
    fn the_free_scanner_needs_both_secrets_or_neither() {
        let base = ("DATABASE_URL", "postgres://app@db/rampsmith");
        assert!(config(&[base]).unwrap().free_scan.is_none());
        let long = "x".repeat(32);
        assert_eq!(
            config(&[base, ("FREE_SCAN_SERVICE_TOKEN", &long)]).unwrap_err(),
            ConfigError::Missing("TURNSTILE_SECRET_KEY")
        );
        assert_eq!(
            config(&[base, ("TURNSTILE_SECRET_KEY", "s")]).unwrap_err(),
            ConfigError::Missing("FREE_SCAN_SERVICE_TOKEN")
        );
        let short = config(&[
            base,
            ("FREE_SCAN_SERVICE_TOKEN", "too-short"),
            ("TURNSTILE_SECRET_KEY", "s"),
        ])
        .unwrap_err();
        assert!(!short.to_string().contains("too-short"));
        let ok = config(&[
            base,
            ("FREE_SCAN_SERVICE_TOKEN", &long),
            ("TURNSTILE_SECRET_KEY", "s"),
        ])
        .unwrap();
        let settings = ok.free_scan.unwrap();
        assert_eq!(
            settings.turnstile_origin.as_str(),
            "https://challenges.cloudflare.com/"
        );
        assert!(!format!("{settings:?}").contains(&long));
        assert!(matches!(
            config(&[
                base,
                ("FREE_SCAN_SERVICE_TOKEN", &long),
                ("TURNSTILE_SECRET_KEY", "s"),
                ("TURNSTILE_ORIGIN", "ftp://x"),
            ])
            .unwrap_err(),
            ConfigError::Invalid {
                name: "TURNSTILE_ORIGIN",
                ..
            }
        ));
    }

    #[test]
    fn the_widgets_hostnames_are_a_lowercase_list_or_nothing() {
        let base = ("DATABASE_URL", "postgres://app@db/rampsmith");
        let long = "t".repeat(crate::free_scan::MIN_SERVICE_TOKEN);
        let with = |hostnames: &str| {
            config(&[
                base,
                ("FREE_SCAN_SERVICE_TOKEN", &long),
                ("TURNSTILE_SECRET_KEY", "s"),
                ("TURNSTILE_HOSTNAMES", hostnames),
            ])
        };
        let settings = with(" Rampsmith.com, www.rampsmith.com ,")
            .unwrap()
            .free_scan
            .unwrap();
        assert_eq!(
            settings.turnstile_hostnames,
            ["rampsmith.com", "www.rampsmith.com"]
        );
        assert_eq!(
            with("").unwrap().free_scan.unwrap().turnstile_hostnames,
            Vec::<String>::new()
        );
        assert!(matches!(
            with("https://rampsmith.com").unwrap_err(),
            ConfigError::Invalid {
                name: "TURNSTILE_HOSTNAMES",
                ..
            }
        ));
    }

    fn origin_config(id: &str, origin: &str) -> Result<Config, ConfigError> {
        config(&[
            ("DATABASE_URL", "postgres://app@db/rampsmith"),
            ("WEBAUTHN_RP_ID", id),
            ("WEBAUTHN_RP_ORIGIN", origin),
        ])
    }

    #[test]
    fn accepts_webauthn_origins_that_belong_to_the_relying_party() {
        // (relying-party id, configured origin, the origin the api keeps)
        for (id, origin, kept) in [
            (
                "app.rampsmith.test",
                "https://app.rampsmith.test",
                "https://app.rampsmith.test",
            ),
            (
                "app.rampsmith.test",
                "https://app.rampsmith.test/",
                "https://app.rampsmith.test",
            ),
            (
                "rampsmith.test",
                "https://app.rampsmith.test:8443",
                "https://app.rampsmith.test:8443",
            ),
            (
                "rampsmith.test",
                "HTTPS://App.Rampsmith.TEST",
                "https://app.rampsmith.test",
            ),
            (
                "rampsmith.test",
                "https://rampsmith.test",
                "https://rampsmith.test",
            ),
            ("localhost", "http://localhost", "http://localhost"),
            (
                "localhost",
                "http://localhost:5173",
                "http://localhost:5173",
            ),
            (
                "localhost",
                "http://LOCALHOST:5173",
                "http://localhost:5173",
            ),
            (
                "localhost",
                "https://localhost:5173",
                "https://localhost:5173",
            ),
        ] {
            let c = origin_config(id, origin).unwrap_or_else(|e| panic!("{id} {origin}: {e}"));
            assert_eq!(c.webauthn_rp_id, id, "{origin}");
            assert_eq!(c.webauthn_rp_origin, kept, "{origin}");
        }
    }

    #[test]
    fn refuses_webauthn_origins_that_do_not_belong_to_the_relying_party() {
        for (id, origin) in [
            // Plain http is for the exact host `localhost` only (audit L9).
            ("app.rampsmith.test", "http://app.rampsmith.test"),
            ("rampsmith.test", "http://localhost.rampsmith.test"),
            ("rampsmith.test", "http://localhost.rampsmith.test:5173"),
            ("localhost", "http://localhost.localhost"),
            ("localhost", "http://localhost.:5173"),
            ("rampsmith.test", "http://localhost:5173"),
            // The host must be the relying-party id or a subdomain of it.
            ("app.rampsmith.test", "https://evil.test"),
            ("app.rampsmith.test", "https://notapp.rampsmith.test"),
            ("app.rampsmith.test", "https://rampsmith.test"),
            ("rampsmith.test", "https://evilrampsmith.test"),
            ("rampsmith.test", "https://rampsmith.test.evil.test"),
            // Anything beyond scheme, host and port is not an origin.
            ("rampsmith.test", "https://evil.test@rampsmith.test"),
            ("rampsmith.test", "https://user:pass@rampsmith.test"),
            ("rampsmith.test", "https://rampsmith.test@evil.test"),
            ("rampsmith.test", "https://rampsmith.test/dashboard"),
            ("rampsmith.test", "https://rampsmith.test/?next=/"),
            ("rampsmith.test", "https://rampsmith.test/#top"),
            // Not a web origin at all.
            ("rampsmith.test", "rampsmith.test"),
            ("rampsmith.test", "//rampsmith.test"),
            ("rampsmith.test", "https://"),
            ("rampsmith.test", "ftp://rampsmith.test"),
            ("rampsmith.test", "javascript:alert(1)"),
            ("127.0.0.1", "https://127.0.0.1"),
            ("localhost", "http://127.0.0.1:5173"),
            ("localhost", "http://[::1]:5173"),
        ] {
            let err = origin_config(id, origin).unwrap_err();
            assert!(
                matches!(
                    err,
                    ConfigError::Invalid {
                        name: "WEBAUTHN_RP_ORIGIN",
                        ..
                    }
                ),
                "{id} {origin}: {err:?}"
            );
            // The error names the variable and the rule, never the value.
            let text = err.to_string();
            for fragment in [
                "rampsmith.test",
                "evil",
                "127.0.0.1",
                "[::1]",
                "alert",
                "pass",
            ] {
                assert!(!text.contains(fragment), "{text}");
            }
        }
    }

    #[test]
    fn refuses_a_relying_party_id_that_is_not_a_lowercase_host_name() {
        for id in [
            "App.Rampsmith.test",
            "https://rampsmith.test",
            "rampsmith.test:443",
            "rampsmith.test/",
            ".rampsmith.test",
            "rampsmith..test",
            "-rampsmith.test",
            "rampsmith test",
        ] {
            let err = origin_config(id, "https://rampsmith.test").unwrap_err();
            assert!(
                matches!(
                    err,
                    ConfigError::Invalid {
                        name: "WEBAUTHN_RP_ID",
                        ..
                    }
                ),
                "{id}: {err:?}"
            );
        }
        for name in ["WEBAUTHN_RP_ID", "WEBAUTHN_RP_ORIGIN"] {
            assert_eq!(
                config(&[("DATABASE_URL", "postgres://app@db/rampsmith"), (name, "")]).unwrap_err(),
                ConfigError::Missing(name)
            );
        }
    }

    #[test]
    fn requires_shopify_credentials_and_master_keys() {
        let base = ("DATABASE_URL", "postgres://app@db/rampsmith");
        for name in [
            "SHOPIFY_API_KEY",
            "SHOPIFY_API_SECRET",
            "RAMPSMITH_MASTER_KEYS",
        ] {
            assert_eq!(
                config(&[base, (name, "")]).unwrap_err(),
                ConfigError::Missing(name)
            );
        }
        let err = config(&[base, ("RAMPSMITH_MASTER_KEYS", "k1:c2hvcnQ")]).unwrap_err();
        assert!(matches!(
            err,
            ConfigError::Invalid {
                name: "RAMPSMITH_MASTER_KEYS",
                ..
            }
        ));
        assert!(!err.to_string().contains("c2hvcnQ"));
    }

    #[test]
    fn rejects_malformed_numbers_and_addresses() {
        let base = ("DATABASE_URL", "postgres://app@db/rampsmith");
        assert!(matches!(
            config(&[base, ("BIND_ADDR", "port 80")]).unwrap_err(),
            ConfigError::Invalid {
                name: "BIND_ADDR",
                ..
            }
        ));
        assert!(matches!(
            config(&[base, ("DB_MAX_CONNECTIONS", "lots")]).unwrap_err(),
            ConfigError::Invalid {
                name: "DB_MAX_CONNECTIONS",
                ..
            }
        ));
        assert!(matches!(
            config(&[base, ("DB_MAX_CONNECTIONS", "0")]).unwrap_err(),
            ConfigError::Invalid {
                name: "DB_MAX_CONNECTIONS",
                ..
            }
        ));
    }

    const PARTNER: [(&str, &str); 3] = [
        ("SHOPIFY_PARTNER_ORG_ID", "424242"),
        ("SHOPIFY_PARTNER_API_TOKEN", "prtnr_secret_value"),
        ("SHOPIFY_APP_GID", "gid://shopify/App/1234"),
    ];

    #[test]
    fn partner_access_is_all_three_variables_or_none() {
        let base = [("DATABASE_URL", "postgres://x@localhost/db")];
        assert!(config(&base).unwrap().partner.is_none());
        let all: Vec<(&str, &str)> = base.iter().chain(PARTNER.iter()).copied().collect();
        let configured = config(&all).unwrap();
        let partner = configured.partner.unwrap();
        assert_eq!(partner.organization.to_string(), "424242");
        assert_eq!(partner.app.to_string(), "gid://shopify/App/1234");
        assert_eq!(partner.token.expose_secret(), "prtnr_secret_value");
        for (skip, (missing, _)) in PARTNER.iter().enumerate() {
            let some: Vec<(&str, &str)> = base
                .iter()
                .copied()
                .chain(
                    PARTNER
                        .iter()
                        .copied()
                        .enumerate()
                        .filter(|(i, _)| *i != skip)
                        .map(|(_, p)| p),
                )
                .collect();
            assert!(
                matches!(config(&some).unwrap_err(), ConfigError::Missing(name) if name == *missing),
                "without {missing}"
            );
        }
    }

    #[test]
    fn a_malformed_partner_value_is_named_but_never_repeated() {
        let error = config(&[
            ("DATABASE_URL", "postgres://x@localhost/db"),
            ("SHOPIFY_PARTNER_ORG_ID", "not-a-number"),
            ("SHOPIFY_PARTNER_API_TOKEN", "prtnr_secret_value"),
            ("SHOPIFY_APP_GID", "gid://shopify/App/1234"),
        ])
        .unwrap_err();
        assert!(matches!(
            error,
            ConfigError::Invalid {
                name: "SHOPIFY_PARTNER_ORG_ID",
                ..
            }
        ));
        assert!(!error.to_string().contains("prtnr_secret_value"));
        let debug = format!(
            "{:?}",
            config(&[
                ("DATABASE_URL", "postgres://x@localhost/db"),
                PARTNER[0],
                PARTNER[1],
                PARTNER[2]
            ])
            .unwrap()
        );
        assert!(
            !debug.contains("prtnr_secret_value"),
            "the token must not appear in Debug"
        );
    }
}
