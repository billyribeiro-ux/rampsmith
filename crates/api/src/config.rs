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
    /// The WebAuthn relying-party id, a registrable domain (`WEBAUTHN_RP_ID`, ADR-024).
    pub webauthn_rp_id: String,
    /// The dashboard's origin (`WEBAUTHN_RP_ORIGIN`), such as `https://app.rampsmith.com`.
    pub webauthn_rp_origin: String,
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
        Ok(Self {
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
}
