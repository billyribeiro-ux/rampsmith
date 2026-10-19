use std::fmt;

use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use time::OffsetDateTime;

use crate::ShopDomain;

/// Clock skew tolerated on `exp` and `nbf` (PLAN §14 step 3).
const LEEWAY_SECONDS: i64 = 5;

/// Why a session token was rejected. Every variant answers 401; none echoes the token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SessionTokenError {
    /// Not a decodable JWT.
    #[error("session token is malformed")]
    Malformed,
    /// Signed with another key.
    #[error("session token signature is invalid")]
    BadSignature,
    /// Not HS256.
    #[error("session token algorithm is not HS256")]
    WrongAlgorithm,
    /// Issued for another app.
    #[error("session token audience is not this app")]
    WrongAudience,
    /// Past `exp`.
    #[error("session token has expired")]
    Expired,
    /// Before `nbf`.
    #[error("session token is not valid yet")]
    NotYetValid,
    /// `exp`, `nbf`, `aud`, `iss` or `dest` is missing.
    #[error("session token lacks a required claim")]
    MissingClaim,
    /// `dest` is not `https://<shop>.myshopify.com`.
    #[error("session token destination is not a shop")]
    BadDestination,
    /// The hostnames of `iss` and `dest` differ.
    #[error("session token issuer does not match its destination")]
    IssuerMismatch,
}

/// A verified session token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionToken {
    /// The shop the merchant is signed in to (`dest`).
    pub shop: ShopDomain,
    /// The Shopify staff user id (`sub`).
    pub user_id: Option<String>,
    /// The user's session with this app (`sid`).
    pub session_id: Option<String>,
    /// The token's id (`jti`).
    pub token_id: Option<String>,
    /// When the token expires (`exp`).
    pub expires_at: OffsetDateTime,
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    dest: String,
    exp: i64,
    nbf: i64,
    sub: Option<String>,
    sid: Option<String>,
    jti: Option<String>,
}

/// Verifies App Bridge session tokens for one app.
#[derive(Clone)]
pub struct SessionTokenVerifier {
    client_id: String,
    key: DecodingKey,
    validation: Validation,
}

impl fmt::Debug for SessionTokenVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionTokenVerifier")
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

impl SessionTokenVerifier {
    /// A verifier for the app with `client_id`, signed with `client_secret`.
    #[must_use]
    pub fn new(client_id: &str, client_secret: &SecretString) -> Self {
        let mut validation = Validation::new(Algorithm::HS256);
        // exp and nbf are checked against an injected clock in `verify_at`.
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.leeway = 0;
        validation.set_audience(&[client_id]);
        validation.set_required_spec_claims(&["exp", "nbf", "aud", "iss"]);
        Self {
            client_id: client_id.to_owned(),
            key: DecodingKey::from_secret(client_secret.expose_secret().as_bytes()),
            validation,
        }
    }

    /// The app this verifier accepts tokens for.
    #[must_use]
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// Verifies `token` now.
    pub fn verify(&self, token: &str) -> Result<SessionToken, SessionTokenError> {
        self.verify_at(token, OffsetDateTime::now_utc())
    }

    /// Verifies `token` as of `now`: signature, algorithm, audience, expiry and not-before
    /// with leeway, then `dest` and `iss` (shopify.dev, "ID tokens").
    pub fn verify_at(
        &self,
        token: &str,
        now: OffsetDateTime,
    ) -> Result<SessionToken, SessionTokenError> {
        let claims = decode::<Claims>(token, &self.key, &self.validation)
            .map_err(|e| match e.kind() {
                ErrorKind::InvalidSignature => SessionTokenError::BadSignature,
                ErrorKind::InvalidAlgorithm | ErrorKind::InvalidAlgorithmName => {
                    SessionTokenError::WrongAlgorithm
                }
                ErrorKind::InvalidAudience => SessionTokenError::WrongAudience,
                ErrorKind::MissingRequiredClaim(_) => SessionTokenError::MissingClaim,
                _ => SessionTokenError::Malformed,
            })?
            .claims;

        let now = now.unix_timestamp();
        if now >= claims.exp.saturating_add(LEEWAY_SECONDS) {
            return Err(SessionTokenError::Expired);
        }
        if now < claims.nbf.saturating_sub(LEEWAY_SECONDS) {
            return Err(SessionTokenError::NotYetValid);
        }
        let shop =
            ShopDomain::from_origin(&claims.dest).map_err(|_| SessionTokenError::BadDestination)?;
        if issuer_host(&claims.iss) != Some(shop.as_str()) {
            return Err(SessionTokenError::IssuerMismatch);
        }
        Ok(SessionToken {
            shop,
            user_id: claims.sub,
            session_id: claims.sid,
            token_id: claims.jti,
            expires_at: OffsetDateTime::from_unix_timestamp(claims.exp)
                .map_err(|_| SessionTokenError::Malformed)?,
        })
    }
}

/// The lowercased host of an `https://host/...` issuer.
fn issuer_host(iss: &str) -> Option<&str> {
    let rest = iss.strip_prefix("https://")?;
    let host = rest.split('/').next()?;
    (!host.is_empty() && host.bytes().all(|b| !b.is_ascii_uppercase())).then_some(host)
}
