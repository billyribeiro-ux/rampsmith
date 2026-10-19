//! Scan tokens (ADR-025): what one page load may reach, signed by the engine with a secret
//! shared with egress, and presented by Chromium as its proxy password.
//!
//! Format: `base64url(json) "." base64url(HMAC-SHA256(key, "rampsmith-egress-v1." base64url(json)))`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::Refusal;

const CONTEXT: &[u8] = b"rampsmith-egress-v1.";

/// The furthest ahead of "now" a token's `exp` may be, in seconds (audit L14). The engine
/// signs tokens that live two minutes (ADR-025); anything much longer is not from it, and a
/// leaked token with a distant expiry would stay useful for as long as the signing secret
/// does. Five minutes leaves room for clock drift between the engine and egress.
pub const MAX_TOKEN_AHEAD_SECS: i64 = 300;

/// What a token grants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScanToken {
    /// Format version; 1.
    pub v: u8,
    /// The scan (or page job) it belongs to, for logs.
    pub scan: String,
    /// Hosts it may reach: exact names, or `.suffix` for any subdomain of `suffix`.
    pub hosts: Vec<String>,
    /// Connections it may open.
    pub budget: u32,
    /// Unix seconds after which it is refused.
    pub exp: i64,
}

fn normalise(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

impl ScanToken {
    /// Whether `host` is on this token's list.
    #[must_use]
    pub fn allows(&self, host: &str) -> bool {
        let host = normalise(host);
        !host.is_empty()
            && self.hosts.iter().any(|entry| {
                let entry = normalise(entry);
                match entry.strip_prefix('.') {
                    Some(suffix) => host.len() > suffix.len() + 1 && host.ends_with(&entry),
                    None => host == entry,
                }
            })
    }
}

/// The shared signing key.
#[derive(Clone)]
pub struct TokenKey(Hmac<Sha256>);

impl std::fmt::Debug for TokenKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TokenKey(..)")
    }
}

impl TokenKey {
    /// A key from at least 32 bytes of secret.
    pub fn new(secret: &[u8]) -> Result<Self, Refusal> {
        if secret.len() < 32 {
            return Err(Refusal::Misconfigured(
                "EGRESS_TOKEN_SECRET must be at least 32 bytes",
            ));
        }
        Hmac::<Sha256>::new_from_slice(secret)
            .map(Self)
            .map_err(|_| Refusal::Misconfigured("unusable token secret"))
    }

    fn tag(&self, body: &str) -> Hmac<Sha256> {
        let mut mac = self.0.clone();
        mac.update(CONTEXT);
        mac.update(body.as_bytes());
        mac
    }

    /// Signs `token` (the engine does this; egress only verifies, but tests sign too).
    pub fn sign(&self, token: &ScanToken) -> Result<String, Refusal> {
        let json = serde_json::to_vec(token).map_err(|_| Refusal::BadToken)?;
        let body = URL_SAFE_NO_PAD.encode(json);
        let tag = URL_SAFE_NO_PAD.encode(self.tag(&body).finalize().into_bytes());
        Ok(format!("{body}.{tag}"))
    }

    /// Verifies a token's signature in constant time, then its version and expiry. A token is
    /// refused once `now` reaches `exp`, and also when `exp` is more than
    /// [`MAX_TOKEN_AHEAD_SECS`] ahead of `now`.
    pub fn verify(&self, token: &str, now: i64) -> Result<ScanToken, Refusal> {
        let (body, tag) = token.split_once('.').ok_or(Refusal::BadToken)?;
        let tag = URL_SAFE_NO_PAD.decode(tag).map_err(|_| Refusal::BadToken)?;
        self.tag(body)
            .verify_slice(&tag)
            .map_err(|_| Refusal::BadToken)?;
        let json = URL_SAFE_NO_PAD
            .decode(body)
            .map_err(|_| Refusal::BadToken)?;
        let token: ScanToken = serde_json::from_slice(&json).map_err(|_| Refusal::BadToken)?;
        if token.v != 1 || now >= token.exp || token.exp > now.saturating_add(MAX_TOKEN_AHEAD_SECS)
        {
            return Err(Refusal::BadToken);
        }
        Ok(token)
    }
}
