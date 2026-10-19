use std::collections::BTreeMap;
use std::fmt;

use aes_gcm::Aes256Gcm;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use secrecy::SecretString;
use zeroize::Zeroizing;

use crate::CryptoError;
use crate::envelope::{self, Sealed, WipedKey};

/// A master key id: 1 to 32 characters of `a-z`, `0-9`, `-` and `_`. Stored next to every
/// ciphertext and authenticated with it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KeyId(String);

impl KeyId {
    /// Validates `id`.
    pub fn new(id: &str) -> Result<Self, CryptoError> {
        let ok = !id.is_empty()
            && id.len() <= 32
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
        if ok {
            Ok(Self(id.to_owned()))
        } else {
            Err(CryptoError::Config(
                "key ids are 1 to 32 characters of a-z, 0-9, '-' and '_'",
            ))
        }
    }

    /// The id as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for KeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The master keys, from the environment only. The first key seals; every key opens, so a
/// new key is rolled out by prepending it and the old one is removed once nothing it
/// wrapped remains ([`KeyRing::rewrap`]).
#[derive(Clone)]
pub struct KeyRing {
    active: KeyId,
    keys: BTreeMap<KeyId, Aes256Gcm>,
}

impl fmt::Debug for KeyRing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyRing")
            .field("active", &self.active.as_str())
            .field(
                "keys",
                &self.keys.keys().map(KeyId::as_str).collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl KeyRing {
    /// Parses `id:base64key[,id:base64key...]`, newest first. Keys are 32 bytes in standard
    /// base64, padded or not.
    pub fn parse(spec: &str) -> Result<Self, CryptoError> {
        let mut keys = BTreeMap::new();
        let mut active = None;
        if spec.trim().is_empty() {
            return Err(CryptoError::Config("no master keys"));
        }
        for entry in spec.split(',') {
            let (id, key) = entry
                .split_once(':')
                .ok_or(CryptoError::Config("each entry is id:base64key"))?;
            let id = KeyId::new(id.trim())?;
            let cipher = decode_key(key.trim())?.cipher();
            if keys.insert(id.clone(), cipher).is_some() {
                return Err(CryptoError::Config("duplicate key id"));
            }
            active.get_or_insert(id);
        }
        let active = active.ok_or(CryptoError::Config("no master keys"))?;
        Ok(Self { active, keys })
    }

    /// A new random master key in the format [`KeyRing::parse`] reads.
    pub fn generate_master_key() -> Result<String, CryptoError> {
        let key = WipedKey::generate()?;
        Ok(STANDARD_NO_PAD.encode(key.as_slice()))
    }

    /// The key that seals new values.
    #[must_use]
    pub const fn active(&self) -> &KeyId {
        &self.active
    }

    /// Whether a value sealed under `key_id` should be re-wrapped under the active key.
    #[must_use]
    pub fn needs_rewrap(&self, key_id: &str) -> bool {
        key_id != self.active.as_str()
    }

    /// Seals `plaintext` under a fresh data key wrapped by the active master key. `context`
    /// is authenticated, not encrypted: pass what identifies the slot, such as
    /// `shopify_tokens/access/<shop id>`.
    pub fn seal(&self, plaintext: &[u8], context: &[u8]) -> Result<Sealed, CryptoError> {
        let master = self.cipher(self.active.as_str())?;
        envelope::seal(master, &self.active, plaintext, context)
    }

    /// Opens a value sealed under `key_id` with the same `context`.
    pub fn open(
        &self,
        key_id: &str,
        sealed: &[u8],
        context: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        let id = KeyId::new(key_id).map_err(|_| CryptoError::UnknownKey(key_id.to_owned()))?;
        envelope::open(self.cipher(key_id)?, &id, sealed, context)
    }

    /// Opens a sealed UTF-8 value, such as an access token.
    pub fn open_string(
        &self,
        key_id: &str,
        sealed: &[u8],
        context: &[u8],
    ) -> Result<SecretString, CryptoError> {
        let bytes = self.open(key_id, sealed, context)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| CryptoError::NotText)?;
        Ok(SecretString::from(text))
    }

    /// Re-wraps the data key of a value sealed under `key_id` with the active master key.
    ///
    /// The stored data ciphertext is carried over byte for byte and the value is not returned,
    /// but it is decrypted once inside this call, and the plaintext is dropped (and wiped) at
    /// once. That is deliberate: it proves that `context` opens the value, so a ciphertext
    /// that was moved to another slot fails here instead of being re-bound to the wrong one.
    /// Fails with [`CryptoError::Authentication`] when `context` or the bytes are wrong, and
    /// with [`CryptoError::UnknownKey`] when the ring no longer holds `key_id`.
    pub fn rewrap(
        &self,
        key_id: &str,
        sealed: &[u8],
        context: &[u8],
    ) -> Result<Sealed, CryptoError> {
        let id = KeyId::new(key_id).map_err(|_| CryptoError::UnknownKey(key_id.to_owned()))?;
        envelope::rewrap(
            self.cipher(key_id)?,
            &id,
            self.cipher(self.active.as_str())?,
            &self.active,
            sealed,
            context,
        )
    }

    fn cipher(&self, key_id: &str) -> Result<&Aes256Gcm, CryptoError> {
        self.keys
            .iter()
            .find(|(id, _)| id.as_str() == key_id)
            .map(|(_, cipher)| cipher)
            .ok_or_else(|| CryptoError::UnknownKey(key_id.to_owned()))
    }
}

fn decode_key(text: &str) -> Result<WipedKey, CryptoError> {
    let bytes = Zeroizing::new(
        STANDARD_NO_PAD
            .decode(text.trim_end_matches('='))
            .or_else(|_| STANDARD.decode(text))
            .map_err(|_| CryptoError::Config("a key is not valid base64"))?,
    );
    WipedKey::from_slice(&bytes).ok_or(CryptoError::Config("a master key must be 32 bytes"))
}
