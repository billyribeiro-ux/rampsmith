//! App authentication: the RS256 JWT that GitHub exchanges for installation tokens.
//!
//! Checked against <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app>
//! on 2026-10-17 (ADR-122): RS256; `iat` 60 seconds in the past against clock drift; `exp` no
//! more than 10 minutes into the future; `iss` the client ID (recommended) or the app ID. The
//! key GitHub generates is a PEM file in PKCS#1 `RSAPrivateKey` format
//! (<https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps>);
//! PKCS#8 is accepted too, because key tooling often converts to it.

use std::fmt;

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use secrecy::zeroize::Zeroizing;
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use time::{Duration, OffsetDateTime};

/// How far in the past `iat` is set, to absorb clock drift (GitHub's recommendation).
pub const JWT_BACKDATE: Duration = Duration::seconds(60);

/// How far in the future `exp` is set. GitHub's maximum is 10 minutes ahead of its own clock;
/// 9 minutes leaves the same 60 seconds of drift tolerance on this side as `iat` does on the
/// other, and the token still spans exactly 10 minutes from `iat` to `exp`.
pub const JWT_EXPIRES_IN: Duration = Duration::seconds(540);

/// Why the App's key or JWT could not be used. Messages never contain key material.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum KeyError {
    /// The value is not a PEM document with matching BEGIN and END lines.
    #[error("the GitHub App private key is not a PEM document")]
    NotPem,
    /// The PEM label is neither `RSA PRIVATE KEY` (PKCS#1) nor `PRIVATE KEY` (PKCS#8).
    #[error("the GitHub App private key has an unsupported PEM label")]
    UnsupportedLabel,
    /// The key is encrypted; GitHub issues unencrypted keys and the service cannot prompt.
    #[error("encrypted private keys are not supported")]
    Encrypted,
    /// The PEM body is not valid base64.
    #[error("the GitHub App private key body is not valid base64")]
    InvalidBase64,
    /// The bytes are not an acceptable RSA private key (2048 to 8192 bits).
    #[error("the GitHub App private key is not a usable RSA key")]
    Rejected,
    /// The issuer is not a client ID (letters, digits and dots) or a numeric app ID.
    #[error("the GitHub App issuer is not a client ID or app ID")]
    InvalidIssuer,
    /// Signing failed.
    #[error("signing the GitHub App JWT failed")]
    Signing,
}

/// The JWT `iss` claim: the App's client ID (GitHub's recommendation) or its numeric app ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIssuer(String);

impl AppIssuer {
    /// A client ID such as `Iv23liExample` or the older `Iv1.0123abcd`.
    pub fn client_id(id: &str) -> Result<Self, KeyError> {
        let ok = (1..=64).contains(&id.len())
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.');
        if ok {
            Ok(Self(id.to_owned()))
        } else {
            Err(KeyError::InvalidIssuer)
        }
    }

    /// A numeric app ID.
    #[must_use]
    pub fn app_id(id: u64) -> Self {
        Self(id.to_string())
    }

    /// The claim value.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The App's RSA private key, parsed once. It has no `Display`, and its `Debug` prints a
/// placeholder; the PEM text and the decoded key bytes are wiped after parsing.
pub struct AppPrivateKey {
    pair: RsaKeyPair,
}

impl fmt::Debug for AppPrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AppPrivateKey([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PemKind {
    Pkcs1,
    Pkcs8,
}

/// Decodes a PEM private key. Accepts environment values that carry literal `\n` sequences
/// instead of newlines. Every intermediate copy of the key is wiped on drop.
fn decode_pem(pem: &str) -> Result<(PemKind, Zeroizing<Vec<u8>>), KeyError> {
    let text = if !pem.contains('\n') && pem.contains("\\n") {
        Zeroizing::new(pem.replace("\\n", "\n"))
    } else {
        Zeroizing::new(pem.to_owned())
    };
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let label = lines
        .next()
        .and_then(|l| l.strip_prefix("-----BEGIN "))
        .and_then(|l| l.strip_suffix("-----"))
        .ok_or(KeyError::NotPem)?;
    let kind = match label {
        "RSA PRIVATE KEY" => PemKind::Pkcs1,
        "PRIVATE KEY" => PemKind::Pkcs8,
        "ENCRYPTED PRIVATE KEY" => return Err(KeyError::Encrypted),
        _ => return Err(KeyError::UnsupportedLabel),
    };
    let end = format!("-----END {label}-----");
    let mut body = Zeroizing::new(String::with_capacity(text.len()));
    let mut ended = false;
    for line in lines.by_ref() {
        if line == end {
            ended = true;
            break;
        }
        // RFC 1421 headers such as `Proc-Type: 4,ENCRYPTED` mark a legacy encrypted key.
        if line.contains(':') {
            return Err(KeyError::Encrypted);
        }
        body.push_str(line);
    }
    if !ended || lines.next().is_some() {
        return Err(KeyError::NotPem);
    }
    let der = STANDARD
        .decode(body.as_bytes())
        .map_err(|_| KeyError::InvalidBase64)?;
    Ok((kind, Zeroizing::new(der)))
}

impl AppPrivateKey {
    /// Parses the PEM private key downloaded from the App's settings.
    pub fn from_pem(pem: &SecretString) -> Result<Self, KeyError> {
        let (kind, der) = decode_pem(pem.expose_secret())?;
        let pair = match kind {
            PemKind::Pkcs1 => RsaKeyPair::from_der(&der),
            PemKind::Pkcs8 => RsaKeyPair::from_pkcs8(&der),
        }
        .map_err(|_| KeyError::Rejected)?;
        Ok(Self { pair })
    }
}

/// Everything needed to sign App JWTs.
#[derive(Debug)]
pub struct AppCredentials {
    issuer: AppIssuer,
    key: AppPrivateKey,
}

#[derive(Serialize)]
struct Claims<'a> {
    iat: i64,
    exp: i64,
    iss: &'a str,
}

const JWT_HEADER: &[u8] = br#"{"alg":"RS256","typ":"JWT"}"#;

impl AppCredentials {
    /// Pairs the issuer with the key.
    #[must_use]
    pub fn new(issuer: AppIssuer, key: AppPrivateKey) -> Self {
        Self { issuer, key }
    }

    /// The issuer.
    #[must_use]
    pub fn issuer(&self) -> &AppIssuer {
        &self.issuer
    }

    /// Signs a JWT valid from `now - 60 s` to `now + 9 min`.
    pub fn jwt(&self, now: OffsetDateTime) -> Result<AppJwt, KeyError> {
        let issued_at = now - JWT_BACKDATE;
        let expires_at = now + JWT_EXPIRES_IN;
        let claims = serde_json::to_vec(&Claims {
            iat: issued_at.unix_timestamp(),
            exp: expires_at.unix_timestamp(),
            iss: &self.issuer.0,
        })
        .map_err(|_| KeyError::Signing)?;
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(JWT_HEADER),
            URL_SAFE_NO_PAD.encode(&claims)
        );
        let mut signature = vec![0_u8; self.key.pair.public_modulus_len()];
        self.key
            .pair
            .sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                signing_input.as_bytes(),
                &mut signature,
            )
            .map_err(|_| KeyError::Signing)?;
        let token = format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(&signature));
        Ok(AppJwt {
            token: SecretString::from(token),
            issued_at,
            expires_at,
        })
    }
}

/// A signed App JWT. It is a credential for up to 10 minutes, so it is held as a secret and
/// its `Debug` shows only its validity window.
pub struct AppJwt {
    token: SecretString,
    issued_at: OffsetDateTime,
    expires_at: OffsetDateTime,
}

impl AppJwt {
    /// The `iat` claim.
    #[must_use]
    pub fn issued_at(&self) -> OffsetDateTime {
        self.issued_at
    }

    /// The `exp` claim.
    #[must_use]
    pub fn expires_at(&self) -> OffsetDateTime {
        self.expires_at
    }
}

impl ExposeSecret<str> for AppJwt {
    fn expose_secret(&self) -> &str {
        self.token.expose_secret()
    }
}

impl fmt::Debug for AppJwt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AppJwt")
            .field("issued_at", &self.issued_at)
            .field("expires_at", &self.expires_at)
            // `SecretString`'s own `Debug` prints `[REDACTED]`.
            .field("token", &self.token)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pem_without_markers_is_rejected() {
        assert_eq!(decode_pem("not a key").unwrap_err(), KeyError::NotPem);
        assert_eq!(decode_pem("").unwrap_err(), KeyError::NotPem);
    }

    #[test]
    fn pem_with_unknown_label_is_rejected() {
        let pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
        assert_eq!(decode_pem(pem).unwrap_err(), KeyError::UnsupportedLabel);
        let pem = "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n";
        assert_eq!(decode_pem(pem).unwrap_err(), KeyError::UnsupportedLabel);
    }

    #[test]
    fn encrypted_pem_is_rejected() {
        let pkcs8 =
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----";
        assert_eq!(decode_pem(pkcs8).unwrap_err(), KeyError::Encrypted);
        let legacy = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----";
        assert_eq!(decode_pem(legacy).unwrap_err(), KeyError::Encrypted);
    }

    #[test]
    fn pem_end_line_must_match_and_be_last() {
        let mismatched = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
        assert_eq!(decode_pem(mismatched).unwrap_err(), KeyError::NotPem);
        let trailing = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\nextra";
        assert_eq!(decode_pem(trailing).unwrap_err(), KeyError::NotPem);
    }

    #[test]
    fn pem_body_must_be_base64() {
        let pem = "-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----";
        assert_eq!(decode_pem(pem).unwrap_err(), KeyError::InvalidBase64);
    }

    #[test]
    fn pem_with_literal_backslash_n_is_accepted() {
        let pem = "-----BEGIN PRIVATE KEY-----\\nAAEC\\n-----END PRIVATE KEY-----\\n";
        let (kind, der) = decode_pem(pem).unwrap();
        assert_eq!(kind, PemKind::Pkcs8);
        assert_eq!(der.as_slice(), &[0, 1, 2]);
    }

    #[test]
    fn pem_with_crlf_and_indentation_is_accepted() {
        let pem =
            "  -----BEGIN RSA PRIVATE KEY-----\r\n  AAEC\r\n  -----END RSA PRIVATE KEY-----\r\n";
        let (kind, der) = decode_pem(pem).unwrap();
        assert_eq!(kind, PemKind::Pkcs1);
        assert_eq!(der.as_slice(), &[0, 1, 2]);
    }

    #[test]
    fn issuer_accepts_client_ids_and_app_ids() {
        assert_eq!(
            AppIssuer::client_id("Iv23liExample01").unwrap().as_str(),
            "Iv23liExample01"
        );
        assert!(AppIssuer::client_id("Iv1.0123abcd").is_ok());
        assert_eq!(AppIssuer::app_id(123_456).as_str(), "123456");
        let long = "a".repeat(65);
        for bad in ["", "Iv1\"", "a b", "x\n", long.as_str()] {
            assert_eq!(
                AppIssuer::client_id(bad).unwrap_err(),
                KeyError::InvalidIssuer
            );
        }
    }

    #[test]
    fn non_rsa_der_is_rejected_without_echoing_it() {
        // Valid base64 and a valid PEM shape, but not a key.
        let pem = SecretString::from(
            "-----BEGIN PRIVATE KEY-----\nU0VDUkVUS0VZTUFURVJJQUw=\n-----END PRIVATE KEY-----",
        );
        let err = AppPrivateKey::from_pem(&pem).unwrap_err();
        assert_eq!(err, KeyError::Rejected);
        let shown = format!("{err} {err:?}");
        assert!(!shown.contains("U0VDUkVU"));
        assert!(!shown.contains("SECRETKEYMATERIAL"));
    }
}
