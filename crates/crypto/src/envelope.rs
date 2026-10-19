//! The sealed format, version 1:
//!
//! ```text
//! offset  size  field
//! 0       1     format version (1)
//! 1       12    nonce for the wrapped data key
//! 13      48    data key (32) encrypted under the master key, with its tag (16)
//! 61      12    nonce for the value
//! 73      n+16  value encrypted under the data key, with its tag
//! ```
//!
//! The wrap authenticates the master key id and the context; the value authenticates the
//! context. Nonces are random: each data key encrypts exactly one value, and a master key
//! wraps far fewer than 2^32 data keys, so random 96-bit nonces stay within GCM's bounds.

use aes_gcm::aead::{Aead, Generate, Key, Nonce, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use zeroize::{Zeroize, Zeroizing};

use crate::{CryptoError, KeyId};

const VERSION: u8 = 1;
const NONCE: usize = 12;
const TAG: usize = 16;
const KEY: usize = 32;
const WRAP_NONCE_AT: usize = 1;
const WRAPPED_AT: usize = WRAP_NONCE_AT + NONCE;
const DATA_NONCE_AT: usize = WRAPPED_AT + KEY + TAG;
const DATA_AT: usize = DATA_NONCE_AT + NONCE;

/// An AES-256 key that is wiped when dropped.
pub(crate) struct WipedKey(Key<Aes256Gcm>);

impl WipedKey {
    pub(crate) fn generate() -> Result<Self, CryptoError> {
        Key::<Aes256Gcm>::try_generate()
            .map(Self)
            .map_err(|_| CryptoError::Random)
    }

    /// `None` unless `bytes` is exactly 32 bytes long.
    pub(crate) fn from_slice(bytes: &[u8]) -> Option<Self> {
        Key::<Aes256Gcm>::try_from(bytes).ok().map(Self)
    }

    pub(crate) fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }

    pub(crate) fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(&self.0)
    }
}

impl Drop for WipedKey {
    fn drop(&mut self) {
        self.0.as_mut_slice().zeroize();
    }
}

/// A sealed value and the id of the master key that wrapped its data key. Store both.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    key_id: KeyId,
    bytes: Vec<u8>,
}

impl Sealed {
    /// Bytes a sealed value adds to its plaintext.
    pub const OVERHEAD: usize = DATA_AT + TAG;

    /// The master key id to store next to the bytes.
    #[must_use]
    pub const fn key_id(&self) -> &KeyId {
        &self.key_id
    }

    /// The sealed bytes.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// The key id and the bytes, for storing.
    #[must_use]
    pub fn into_parts(self) -> (KeyId, Vec<u8>) {
        (self.key_id, self.bytes)
    }
}

fn wrap_aad(key_id: &KeyId, context: &[u8]) -> Vec<u8> {
    let id = key_id.as_str().as_bytes();
    let mut aad = Vec::with_capacity(32 + id.len() + context.len());
    aad.extend_from_slice(b"rampsmith/envelope/v1/wrap\0");
    // Ids are at most 32 bytes (KeyId::new), so the length fits in one byte.
    aad.push(u8::try_from(id.len()).unwrap_or(u8::MAX));
    aad.extend_from_slice(id);
    aad.extend_from_slice(context);
    aad
}

fn data_aad(context: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(32 + context.len());
    aad.extend_from_slice(b"rampsmith/envelope/v1/data\0");
    aad.extend_from_slice(context);
    aad
}

fn nonce() -> Result<Nonce<Aes256Gcm>, CryptoError> {
    Nonce::<Aes256Gcm>::try_generate().map_err(|_| CryptoError::Random)
}

/// The parts of a well-formed sealed value.
struct Parts<'a> {
    wrap_nonce: Nonce<Aes256Gcm>,
    wrapped: &'a [u8],
    data_nonce: Nonce<Aes256Gcm>,
    data: &'a [u8],
}

fn split(sealed: &[u8]) -> Result<Parts<'_>, CryptoError> {
    if sealed.len() < Sealed::OVERHEAD || sealed.first() != Some(&VERSION) {
        return Err(CryptoError::Malformed);
    }
    let field = |from: usize, to: usize| sealed.get(from..to).ok_or(CryptoError::Malformed);
    let wrap_nonce = Nonce::<Aes256Gcm>::try_from(field(WRAP_NONCE_AT, WRAPPED_AT)?)
        .map_err(|_| CryptoError::Malformed)?;
    let data_nonce = Nonce::<Aes256Gcm>::try_from(field(DATA_NONCE_AT, DATA_AT)?)
        .map_err(|_| CryptoError::Malformed)?;
    Ok(Parts {
        wrap_nonce,
        wrapped: field(WRAPPED_AT, DATA_NONCE_AT)?,
        data_nonce,
        data: field(DATA_AT, sealed.len())?,
    })
}

fn wrap(
    master: &Aes256Gcm,
    key_id: &KeyId,
    data_key: &[u8],
    context: &[u8],
) -> Result<(Nonce<Aes256Gcm>, Vec<u8>), CryptoError> {
    let wrap_nonce = nonce()?;
    let aad = wrap_aad(key_id, context);
    let wrapped = master
        .encrypt(
            &wrap_nonce,
            Payload {
                msg: data_key,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::Authentication)?;
    Ok((wrap_nonce, wrapped))
}

fn unwrap_key(
    master: &Aes256Gcm,
    key_id: &KeyId,
    parts: &Parts<'_>,
    context: &[u8],
) -> Result<WipedKey, CryptoError> {
    let aad = wrap_aad(key_id, context);
    let bytes = master
        .decrypt(
            &parts.wrap_nonce,
            Payload {
                msg: parts.wrapped,
                aad: &aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::Authentication)?;
    WipedKey::from_slice(&bytes).ok_or(CryptoError::Authentication)
}

fn assemble(
    key_id: &KeyId,
    wrap_nonce: &[u8],
    wrapped: &[u8],
    data_nonce: &[u8],
    data: &[u8],
) -> Sealed {
    let mut bytes = Vec::with_capacity(DATA_AT + data.len());
    bytes.push(VERSION);
    bytes.extend_from_slice(wrap_nonce);
    bytes.extend_from_slice(wrapped);
    bytes.extend_from_slice(data_nonce);
    bytes.extend_from_slice(data);
    Sealed {
        key_id: key_id.clone(),
        bytes,
    }
}

pub(crate) fn seal(
    master: &Aes256Gcm,
    key_id: &KeyId,
    plaintext: &[u8],
    context: &[u8],
) -> Result<Sealed, CryptoError> {
    let data_key = WipedKey::generate()?;
    let data_nonce = nonce()?;
    let aad = data_aad(context);
    let data = data_key
        .cipher()
        .encrypt(
            &data_nonce,
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::Authentication)?;
    let (wrap_nonce, wrapped) = wrap(master, key_id, data_key.as_slice(), context)?;
    Ok(assemble(key_id, &wrap_nonce, &wrapped, &data_nonce, &data))
}

pub(crate) fn open(
    master: &Aes256Gcm,
    key_id: &KeyId,
    sealed: &[u8],
    context: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let parts = split(sealed)?;
    let data_key = unwrap_key(master, key_id, &parts, context)?;
    let aad = data_aad(context);
    data_key
        .cipher()
        .decrypt(
            &parts.data_nonce,
            Payload {
                msg: parts.data,
                aad: &aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::Authentication)
}

pub(crate) fn rewrap(
    old_master: &Aes256Gcm,
    old_id: &KeyId,
    new_master: &Aes256Gcm,
    new_id: &KeyId,
    sealed: &[u8],
    context: &[u8],
) -> Result<Sealed, CryptoError> {
    let parts = split(sealed)?;
    let data_key = unwrap_key(old_master, old_id, &parts, context)?;
    // Prove the context also opens the value before re-binding the key to it.
    let aad = data_aad(context);
    data_key
        .cipher()
        .decrypt(
            &parts.data_nonce,
            Payload {
                msg: parts.data,
                aad: &aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::Authentication)?;
    let (wrap_nonce, wrapped) = wrap(new_master, new_id, data_key.as_slice(), context)?;
    Ok(assemble(
        new_id,
        &wrap_nonce,
        &wrapped,
        &parts.data_nonce,
        parts.data,
    ))
}
