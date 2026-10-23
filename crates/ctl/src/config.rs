//! Configuration from the environment, parsed once at boot (PLAN §22).

use std::net::SocketAddr;

use crypto::KeyRing;
use secrecy::SecretString;
use thiserror::Error;

/// Everything `ctl` needs from its environment.
#[derive(Debug)]
pub struct Config {
    /// PostgreSQL URL for the `rampsmith_worker` role. Secret: never logged.
    pub database_url: SecretString,
    /// Pool size.
    pub db_max_connections: u32,
    /// Unique per process; stored as `jobs.locked_by`.
    pub worker_id: String,
    /// Reported as `service.version`.
    pub service_version: String,
    /// The Shopify app's client id.
    pub shopify_client_id: String,
    /// The Shopify app's client secret.
    pub shopify_client_secret: SecretString,
    /// Master keys for envelope encryption (ADR-021).
    pub master_keys: KeyRing,
    /// Where the health listener binds: `BIND_ADDR`, else `[::]:$PORT`, else `[::]:8080`
    /// (ADR-264). Railway's deploy health check calls `GET /healthz` on `PORT`.
    pub health_bind: SocketAddr,
    /// The app's public origin (`APP_ORIGIN`), such as `https://app.rampsmith.com`: the links in
    /// emails point at it. Optional: without it `ctl` queues no email that carries a link.
    pub app_origin: Option<String>,
}

/// A configuration value is missing or malformed. Never contains the value.
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
        /// Why.
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
        let require = |name: &'static str| get(name).ok_or(ConfigError::Missing(name));
        let database_url = require("DATABASE_URL")?;
        if !(database_url.starts_with("postgres://") || database_url.starts_with("postgresql://")) {
            return Err(ConfigError::Invalid {
                name: "DATABASE_URL",
                reason: "must be a postgres:// URL".to_owned(),
            });
        }
        let db_max_connections = get("DB_MAX_CONNECTIONS")
            .map_or(Ok(10), |v| v.parse::<u32>())
            .map_err(|e| ConfigError::Invalid {
                name: "DB_MAX_CONNECTIONS",
                reason: e.to_string(),
            })?;
        if db_max_connections < 3 {
            // The leader's dedicated connection, a listener and at least one job.
            return Err(ConfigError::Invalid {
                name: "DB_MAX_CONNECTIONS",
                reason: "must be at least 3".to_owned(),
            });
        }
        let master_keys = KeyRing::parse(&require("RAMPSMITH_MASTER_KEYS")?).map_err(|e| {
            ConfigError::Invalid {
                name: "RAMPSMITH_MASTER_KEYS",
                reason: e.to_string(),
            }
        })?;
        let health_bind = if let Some(addr) = get("BIND_ADDR") {
            addr.trim()
                .parse()
                .map_err(|e: std::net::AddrParseError| ConfigError::Invalid {
                    name: "BIND_ADDR",
                    reason: e.to_string(),
                })?
        } else {
            let port = get("PORT")
                .map_or(Ok(8080), |v| v.trim().parse::<u16>())
                .map_err(|e| ConfigError::Invalid {
                    name: "PORT",
                    reason: e.to_string(),
                })?;
            SocketAddr::from(([0_u16; 8], port))
        };
        let app_origin = get("APP_ORIGIN")
            .map(|v| origin(&v))
            .transpose()?;
        Ok(Self {
            database_url: SecretString::from(database_url),
            db_max_connections,
            worker_id: get("WORKER_ID").unwrap_or_else(default_worker_id),
            service_version: get("SERVICE_VERSION")
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned()),
            shopify_client_id: require("SHOPIFY_API_KEY")?.trim().to_owned(),
            shopify_client_secret: SecretString::from(require("SHOPIFY_API_SECRET")?),
            master_keys,
            health_bind,
            app_origin,
        })
    }
}

/// `value` as an origin: `https://host[:port]`, or `http://` on a loopback host for development,
/// with no path, query or credentials. Returned lower-case and without a trailing slash.
fn origin(value: &str) -> Result<String, ConfigError> {
    let invalid = |reason: &str| ConfigError::Invalid {
        name: "APP_ORIGIN",
        reason: reason.to_owned(),
    };
    let text = value.trim().trim_end_matches('/').to_ascii_lowercase();
    let (scheme, authority) = text
        .split_once("://")
        .ok_or_else(|| invalid("must look like https://app.example.com"))?;
    let host = authority
        .rsplit_once(':')
        .filter(|(_, port)| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
        .map_or(authority, |(name, _)| name);
    let plain = !host.is_empty()
        && authority
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'));
    if !plain {
        return Err(invalid(
            "must be a scheme and host only, with no path or credentials",
        ));
    }
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    match scheme {
        "https" => Ok(text),
        "http" if loopback => Ok(text),
        _ => Err(invalid("must be https (http only on a loopback host)")),
    }
}

/// `ctl-<railway replica or hostname>-<pid>`.
fn default_worker_id() -> String {
    let host = std::env::var("RAILWAY_REPLICA_ID")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "local".to_owned());
    format!("ctl-{host}-{}", std::process::id())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let mut vars: HashMap<String, String> = [
            ("DATABASE_URL", "postgres://worker@db/rampsmith"),
            ("SHOPIFY_API_KEY", "abc"),
            ("SHOPIFY_API_SECRET", "shpss_hunter4"),
            (
                "RAMPSMITH_MASTER_KEYS",
                "k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            ),
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
    fn reads_a_complete_environment_with_defaults() {
        let c = config(&[("WORKER_ID", "w-1")]).unwrap();
        assert_eq!(c.worker_id, "w-1");
        assert_eq!(c.db_max_connections, 10);
        assert_eq!(c.master_keys.active().as_str(), "k1");
        assert_eq!(c.health_bind, "[::]:8080".parse().unwrap());
        assert!(!format!("{c:?}").contains("hunter4"));
    }

    #[test]
    fn the_app_origin_is_an_origin_or_absent() {
        assert_eq!(config(&[]).unwrap().app_origin, None);
        let c = config(&[("APP_ORIGIN", "https://App.Rampsmith.example/")]).unwrap();
        assert_eq!(c.app_origin.as_deref(), Some("https://app.rampsmith.example"));
        let c = config(&[("APP_ORIGIN", "http://localhost:5173")]).unwrap();
        assert_eq!(c.app_origin.as_deref(), Some("http://localhost:5173"));
        for bad in [
            "app.rampsmith.example",
            "http://app.rampsmith.example",
            "https://app.rampsmith.example/path",
            "https://user:pw@app.rampsmith.example",
            "https://app.rampsmith.example?x=1",
            "ftp://app.rampsmith.example",
        ] {
            assert!(
                matches!(
                    config(&[("APP_ORIGIN", bad)]),
                    Err(ConfigError::Invalid { name: "APP_ORIGIN", .. })
                ),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_health_listener_follows_bind_addr_then_port() {
        let c = config(&[("PORT", "9090")]).unwrap();
        assert_eq!(c.health_bind, "[::]:9090".parse().unwrap());
        let c = config(&[("PORT", "9090"), ("BIND_ADDR", "[::]:8081")]).unwrap();
        assert_eq!(c.health_bind, "[::]:8081".parse().unwrap());
    }

    #[test]
    fn every_required_variable_is_required() {
        for name in [
            "DATABASE_URL",
            "SHOPIFY_API_KEY",
            "SHOPIFY_API_SECRET",
            "RAMPSMITH_MASTER_KEYS",
        ] {
            assert_eq!(
                config(&[(name, " ")]).unwrap_err(),
                ConfigError::Missing(name)
            );
        }
    }

    #[test]
    fn rejects_malformed_values() {
        for (name, value) in [
            ("DATABASE_URL", "mysql://x"),
            ("DB_MAX_CONNECTIONS", "2"),
            ("DB_MAX_CONNECTIONS", "many"),
            ("BIND_ADDR", "port 80"),
            ("PORT", "http"),
            ("RAMPSMITH_MASTER_KEYS", "k1:short"),
        ] {
            assert!(
                matches!(config(&[(name, value)]), Err(ConfigError::Invalid { name: n, .. }) if n == name),
                "{name}={value}"
            );
        }
    }
}
