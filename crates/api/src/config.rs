//! Configuration: environment variables parsed into one typed struct at boot. A missing or
//! malformed value stops the process before it serves a request (PLAN §22).

use std::net::SocketAddr;

use crypto::KeyRing;
use secrecy::SecretString;
use thiserror::Error;

/// Everything the api needs from its environment.
#[derive(Debug)]
pub struct Config {
    /// PostgreSQL connection string for an application role. Secret: never logged.
    pub database_url: SecretString,
    /// Address to listen on.
    pub bind: SocketAddr,
    /// Pool size.
    pub db_max_connections: u32,
    /// Reported as `service.version`, normally the image's commit.
    pub service_version: String,
    /// The Shopify app's client id (`SHOPIFY_CLIENT_ID`).
    pub shopify_client_id: String,
    /// The Shopify app's client secret (`SHOPIFY_CLIENT_SECRET`). Signs session tokens.
    pub shopify_client_secret: SecretString,
    /// Master keys for envelope encryption (`RAMPSMITH_MASTER_KEYS`, ADR-021).
    pub master_keys: KeyRing,
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
            get("SHOPIFY_CLIENT_ID").ok_or(ConfigError::Missing("SHOPIFY_CLIENT_ID"))?;
        let shopify_client_secret =
            get("SHOPIFY_CLIENT_SECRET").ok_or(ConfigError::Missing("SHOPIFY_CLIENT_SECRET"))?;
        let master_keys = KeyRing::parse(
            &get("RAMPSMITH_MASTER_KEYS").ok_or(ConfigError::Missing("RAMPSMITH_MASTER_KEYS"))?,
        )
        .map_err(|e| ConfigError::Invalid {
            name: "RAMPSMITH_MASTER_KEYS",
            reason: e.to_string(),
        })?;
        Ok(Self {
            shopify_client_id: shopify_client_id.trim().to_owned(),
            shopify_client_secret: SecretString::from(shopify_client_secret),
            master_keys,
            database_url: SecretString::from(database_url),
            bind,
            db_max_connections,
            service_version: get("SERVICE_VERSION")
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned()),
        })
    }
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
            ("SHOPIFY_CLIENT_ID", "0123456789abcdef"),
            ("SHOPIFY_CLIENT_SECRET", "shpss_hunter3"),
            ("RAMPSMITH_MASTER_KEYS", &format!("k1:{KEY}") as &str),
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
    fn requires_shopify_credentials_and_master_keys() {
        let base = ("DATABASE_URL", "postgres://app@db/rampsmith");
        for name in [
            "SHOPIFY_CLIENT_ID",
            "SHOPIFY_CLIENT_SECRET",
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
