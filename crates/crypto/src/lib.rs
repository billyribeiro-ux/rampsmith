//! Envelope encryption for secrets at rest (PLAN §14 step 5, §18; ADR-021).
//!
//! Each sealed value gets its own random 256-bit data key. The value is encrypted with
//! AES-256-GCM under that data key, and the data key is encrypted ("wrapped") with
//! AES-256-GCM under a master key from the [`KeyRing`], which lives only in the
//! environment. The database stores the result and the master key's id; it never holds a
//! key that can open it.
//!
//! Both layers authenticate a caller-supplied context (for example the table, column and
//! row id), and the wrap also authenticates the master key id, so a ciphertext copied to
//! another row, column or key id fails to open instead of decrypting.

mod envelope;
mod keyring;

pub use envelope::Sealed;
pub use keyring::{KeyId, KeyRing};

/// Why sealing, opening or loading keys failed. Messages never contain key material or
/// plaintext.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    /// The key ring configuration is unusable.
    #[error("invalid key ring: {0}")]
    Config(&'static str),
    /// The ciphertext names a master key the ring does not hold.
    #[error("unknown master key {0}")]
    UnknownKey(String),
    /// The ciphertext is truncated or has an unknown format version.
    #[error("malformed ciphertext")]
    Malformed,
    /// Authentication failed: wrong key, wrong context or tampered bytes.
    #[error("ciphertext failed authentication")]
    Authentication,
    /// The opened value is not the expected text.
    #[error("decrypted value is not UTF-8")]
    NotText,
    /// The operating system's random source failed.
    #[error("random number generator failed")]
    Random,
}
