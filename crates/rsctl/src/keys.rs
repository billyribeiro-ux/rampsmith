//! `rsctl keys`: master key material in the format `crates/crypto` reads (ADR-021, ADR-153).
//!
//! A key ring is `id:base64key[,id:base64key...]`, newest first. The first key seals and every
//! key opens, so a rotation prepends a fresh key and keeps the old ones until nothing they
//! wrapped remains. This module builds those strings. It never decodes a key: key bytes come
//! from [`crypto::KeyRing::generate_master_key`], and every ring it returns is parsed back
//! with [`crypto::KeyRing::parse`] before it is handed out.

use crypto::{CryptoError, KeyId, KeyRing};
use time::OffsetDateTime;

use crate::secret::Secret;
use crate::util::compact_date;

/// Why a ring could not be generated or changed. No message contains key material.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum KeysError {
    /// The input ring does not parse; the reason is `crypto`'s own, which names no key bytes.
    #[error("the key ring is not valid: {0}")]
    Ring(CryptoError),
    /// A requested key id is not `1 to 32 characters of a-z, 0-9, '-' and '_'`.
    #[error("`{0}` is not a valid key id: use 1 to 32 characters of a-z, 0-9, '-' and '_'")]
    BadId(String),
    /// A requested new key id is already in the ring.
    #[error("key id `{0}` is already in the ring")]
    DuplicateId(String),
    /// A key to drop is not in the ring.
    #[error("key id `{0}` is not in the ring")]
    UnknownId(String),
    /// The newest key seals new values and cannot be dropped.
    #[error("`{0}` is the active key; rotate to a new key first")]
    DropActive(String),
    /// The operating system's random source failed.
    #[error("the random number generator failed")]
    Random,
}

/// A new ring after a rotation or a drop.
#[derive(Debug, Clone)]
pub struct Updated {
    /// The ring to store, newest first.
    pub ring: Secret,
    /// The key that seals new values.
    pub active: String,
    /// The older keys that remain, newest first.
    pub kept: Vec<String>,
}

/// The default id for a key created at `now`: `k` and the UTC date, so ids are never reused.
#[must_use]
pub fn default_id(now: OffsetDateTime) -> String {
    format!("k{}", compact_date(now))
}

fn valid_id(id: &str) -> Result<KeyId, KeysError> {
    KeyId::new(id).map_err(|_| KeysError::BadId(id.to_owned()))
}

/// Splits a ring into `(id, entry)` pairs after checking that `crypto` accepts it.
fn entries(spec: &str) -> Result<Vec<(String, String)>, KeysError> {
    KeyRing::parse(spec).map_err(KeysError::Ring)?;
    Ok(spec
        .split(',')
        .map(str::trim)
        .filter_map(|entry| {
            entry
                .split_once(':')
                .map(|(id, _)| (id.trim().to_owned(), entry.to_owned()))
        })
        .collect())
}

fn finish(parts: &[String]) -> Result<Updated, KeysError> {
    let spec = parts.join(",");
    let ring = KeyRing::parse(&spec).map_err(KeysError::Ring)?;
    let ids = entries(&spec)?;
    let mut ids = ids.into_iter().map(|(id, _)| id);
    let active = ids.next().unwrap_or_else(|| ring.active().to_string());
    Ok(Updated {
        ring: Secret::new(spec),
        active,
        kept: ids.collect(),
    })
}

fn new_entry(id: &str) -> Result<String, KeysError> {
    let key = KeyRing::generate_master_key().map_err(|_| KeysError::Random)?;
    Ok(format!("{id}:{key}"))
}

/// A ring with one new key. `id` defaults to [`default_id`].
pub fn generate(now: OffsetDateTime, id: Option<&str>) -> Result<Updated, KeysError> {
    let id = id.map_or_else(|| default_id(now), str::to_owned);
    valid_id(&id)?;
    finish(&[new_entry(&id)?])
}

/// `current` with a fresh key in front; every old entry is kept exactly as given, so values
/// sealed under it still open. Without an explicit `id`, a clash with an existing id (a second
/// rotation on the same day) gets a `-2`, `-3`, ... suffix.
pub fn rotate(current: &str, now: OffsetDateTime, id: Option<&str>) -> Result<Updated, KeysError> {
    let existing = entries(current)?;
    let taken = |candidate: &str| existing.iter().any(|(known, _)| known == candidate);
    let id = if let Some(requested) = id {
        valid_id(requested)?;
        if taken(requested) {
            return Err(KeysError::DuplicateId(requested.to_owned()));
        }
        requested.to_owned()
    } else {
        let base = default_id(now);
        let mut candidate = base.clone();
        let mut n = 2_u32;
        while taken(&candidate) {
            candidate = format!("{base}-{n}");
            n += 1;
        }
        candidate
    };
    let mut parts = vec![new_entry(&id)?];
    parts.extend(existing.into_iter().map(|(_, entry)| entry));
    finish(&parts)
}

/// `current` without the keys named in `drop`. Drop a key only after `KeyRing::rewrap` has
/// moved everything it wrapped; a value still sealed under it can no longer be opened.
pub fn drop_keys(current: &str, drop: &[String]) -> Result<Updated, KeysError> {
    let existing = entries(current)?;
    let active = existing
        .first()
        .map(|(id, _)| id.clone())
        .unwrap_or_default();
    for id in drop {
        if !existing.iter().any(|(known, _)| known == id) {
            return Err(KeysError::UnknownId(id.clone()));
        }
        if *id == active {
            return Err(KeysError::DropActive(id.clone()));
        }
    }
    let parts: Vec<String> = existing
        .into_iter()
        .filter(|(id, _)| !drop.contains(id))
        .map(|(_, entry)| entry)
        .collect();
    finish(&parts)
}

/// The key ids in `spec`, newest first.
pub fn ids(spec: &str) -> Result<Vec<String>, KeysError> {
    Ok(entries(spec)?.into_iter().map(|(id, _)| id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(date: &str) -> OffsetDateTime {
        OffsetDateTime::parse(
            &format!("{date}T09:00:00Z"),
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap()
    }

    #[test]
    fn the_default_id_is_k_and_the_utc_date() {
        assert_eq!(default_id(at("2026-10-19")), "k20261019");
    }

    #[test]
    fn generate_returns_a_ring_crypto_accepts() {
        let made = generate(at("2026-10-19"), None).unwrap();
        let ring = KeyRing::parse(made.ring.expose()).unwrap();
        assert_eq!(ring.active().as_str(), "k20261019");
        assert_eq!(made.active, "k20261019");
        assert_eq!(made.kept, Vec::<String>::new());
        // 32 bytes in unpadded base64 are 43 characters.
        assert_eq!(made.ring.expose().len(), "k20261019:".len() + 43);
    }

    #[test]
    fn rotate_keeps_old_entries_byte_for_byte_behind_a_new_first_key() {
        let old = generate(at("2026-10-19"), Some("k1")).unwrap();
        let rotated = rotate(old.ring.expose(), at("2026-11-02"), None).unwrap();
        assert_eq!(rotated.active, "k20261102");
        assert_eq!(rotated.kept, ["k1"]);
        assert!(
            rotated
                .ring
                .expose()
                .ends_with(&format!(",{}", old.ring.expose()))
        );
        assert!(rotated.ring.expose().starts_with("k20261102:"));
    }

    #[test]
    fn a_value_sealed_before_the_rotation_still_opens_and_can_be_rewrapped() {
        let old = generate(at("2026-10-19"), Some("k1")).unwrap();
        let old_ring = KeyRing::parse(old.ring.expose()).unwrap();
        let sealed = old_ring.seal(b"shpat_token", b"slot").unwrap();

        let rotated = rotate(old.ring.expose(), at("2026-11-02"), None).unwrap();
        let new_ring = KeyRing::parse(rotated.ring.expose()).unwrap();
        assert_eq!(new_ring.active().as_str(), "k20261102");
        assert!(new_ring.needs_rewrap(sealed.key_id().as_str()));
        let opened = new_ring
            .open(sealed.key_id().as_str(), sealed.bytes(), b"slot")
            .unwrap();
        assert_eq!(&opened[..], b"shpat_token");

        let moved = new_ring
            .rewrap(sealed.key_id().as_str(), sealed.bytes(), b"slot")
            .unwrap();
        assert_eq!(moved.key_id().as_str(), "k20261102");
        // Anything sealed from now on uses the new key.
        let fresh = new_ring.seal(b"x", b"slot").unwrap();
        assert_eq!(fresh.key_id().as_str(), "k20261102");
    }

    #[test]
    fn a_second_rotation_on_the_same_day_gets_a_suffix() {
        let first = generate(at("2026-10-19"), None).unwrap();
        let second = rotate(first.ring.expose(), at("2026-10-19"), None).unwrap();
        assert_eq!(second.active, "k20261019-2");
        let third = rotate(second.ring.expose(), at("2026-10-19"), None).unwrap();
        assert_eq!(third.active, "k20261019-3");
        assert_eq!(third.kept, ["k20261019-2", "k20261019"]);
    }

    #[test]
    fn an_explicit_id_must_be_valid_and_new() {
        let old = generate(at("2026-10-19"), Some("k1")).unwrap();
        assert_eq!(
            rotate(old.ring.expose(), at("2026-10-20"), Some("k1")).unwrap_err(),
            KeysError::DuplicateId("k1".to_owned())
        );
        assert_eq!(
            rotate(old.ring.expose(), at("2026-10-20"), Some("Bad Id")).unwrap_err(),
            KeysError::BadId("Bad Id".to_owned())
        );
        assert_eq!(
            rotate(old.ring.expose(), at("2026-10-20"), Some("prod-2"))
                .unwrap()
                .active,
            "prod-2"
        );
        assert_eq!(
            generate(at("2026-10-20"), Some("")).unwrap_err(),
            KeysError::BadId(String::new())
        );
    }

    #[test]
    fn surrounding_whitespace_and_a_trailing_newline_are_tolerated() {
        let old = generate(at("2026-10-19"), Some("k1")).unwrap();
        let padded = format!("  {}\n", old.ring.expose());
        let rotated = rotate(&padded, at("2026-10-20"), None).unwrap();
        assert!(rotated.ring.expose().ends_with(old.ring.expose()));
        assert!(!rotated.ring.expose().contains('\n'));
    }

    #[test]
    fn a_padded_old_key_is_preserved_as_written() {
        let padded = "k0:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let rotated = rotate(padded, at("2026-10-20"), None).unwrap();
        assert!(rotated.ring.expose().ends_with(padded));
    }

    #[test]
    fn invalid_rings_are_rejected_without_echoing_key_text() {
        let bad = "k1:not-base64-but-secret-looking-text";
        let err = rotate(bad, at("2026-10-20"), None).unwrap_err();
        assert!(matches!(err, KeysError::Ring(_)));
        assert!(!err.to_string().contains("secret-looking"));
        assert!(matches!(
            rotate("", at("2026-10-20"), None),
            Err(KeysError::Ring(_))
        ));
        assert!(matches!(
            rotate("k1", at("2026-10-20"), None),
            Err(KeysError::Ring(_))
        ));
    }

    #[test]
    fn drop_removes_old_keys_but_never_the_active_one() {
        let old = generate(at("2026-10-19"), Some("k1")).unwrap();
        let rotated = rotate(old.ring.expose(), at("2026-11-02"), Some("k2")).unwrap();
        assert_eq!(
            drop_keys(rotated.ring.expose(), &["k2".to_owned()]).unwrap_err(),
            KeysError::DropActive("k2".to_owned())
        );
        assert_eq!(
            drop_keys(rotated.ring.expose(), &["nope".to_owned()]).unwrap_err(),
            KeysError::UnknownId("nope".to_owned())
        );
        let dropped = drop_keys(rotated.ring.expose(), &["k1".to_owned()]).unwrap();
        assert_eq!(dropped.active, "k2");
        assert_eq!(dropped.kept, Vec::<String>::new());
        let ring = KeyRing::parse(dropped.ring.expose()).unwrap();
        let old_ring = KeyRing::parse(old.ring.expose()).unwrap();
        let sealed = old_ring.seal(b"x", b"slot").unwrap();
        assert_eq!(
            ring.open("k1", sealed.bytes(), b"slot").unwrap_err(),
            CryptoError::UnknownKey("k1".to_owned())
        );
    }

    #[test]
    fn ids_lists_newest_first() {
        let old = generate(at("2026-10-19"), Some("k1")).unwrap();
        let rotated = rotate(old.ring.expose(), at("2026-11-02"), Some("k2")).unwrap();
        assert_eq!(ids(rotated.ring.expose()).unwrap(), ["k2", "k1"]);
    }
}
