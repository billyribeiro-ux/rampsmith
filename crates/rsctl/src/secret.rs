//! Secret values never reach output (ADR-151).
//!
//! Two layers, both tested in `tests/redaction.rs`:
//!
//! 1. [`Secret`] holds a value and prints `[REDACTED]` for `Debug` and `Display`. Its only way
//!    out is [`Secret::expose`], which probes call when they build a request.
//! 2. [`Redactor`] is the last line of defence. Every secret read from the environment, and
//!    every token a probe mints, is registered with it, and each line the CLI prints passes
//!    through [`Redactor::scrub`]. Probes also print only vendor error *codes*, never vendor
//!    free text, so a server that echoes a secret back cannot make it appear.

use std::fmt;
use std::sync::RwLock;

use secrecy::{ExposeSecret, SecretString};
use zeroize::Zeroizing;

use crate::util::uri_encode;

/// What a secret prints as.
pub const REDACTED: &str = "[REDACTED]";

/// Shortest value the redactor will replace. Shorter strings are not credentials, and
/// replacing them would mangle ordinary words in the output.
const MIN_NEEDLE: usize = 4;

/// A secret string. `Debug` and `Display` print `[REDACTED]`; the value is wiped on drop.
#[derive(Clone)]
pub struct Secret(SecretString);

impl Secret {
    /// Wraps `value`.
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(SecretString::from(value.into()))
    }

    /// The value. Call it only where a request is built.
    #[must_use]
    pub fn expose(&self) -> &str {
        self.0.expose_secret()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Secret({REDACTED})")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

/// Replaces registered secrets, and common re-encodings of them, in any text.
#[derive(Default)]
pub struct Redactor {
    /// Longest first, so a secret that contains another is replaced whole.
    needles: RwLock<Vec<Zeroizing<String>>>,
}

impl fmt::Debug for Redactor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Redactor")
            .field("needles", &self.len())
            .finish()
    }
}

impl Redactor {
    /// An empty redactor.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// How many distinct strings are registered.
    #[must_use]
    pub fn len(&self) -> usize {
        match self.needles.read() {
            Ok(guard) => guard.len(),
            Err(poisoned) => poisoned.into_inner().len(),
        }
    }

    /// Whether nothing is registered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Registers a secret: its value, its percent-encoded form, and, for a multi-line value
    /// such as a PEM key, each of its lines.
    pub fn register(&self, secret: &Secret) {
        let value = secret.expose();
        let mut forms = vec![
            value.to_owned(),
            value.trim().to_owned(),
            uri_encode(value, true),
        ];
        forms.extend(
            value
                .lines()
                .map(str::trim)
                .filter(|line| line.len() >= 16)
                .map(str::to_owned),
        );
        let mut guard = match self.needles.write() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        for form in forms {
            if form.len() >= MIN_NEEDLE && !guard.iter().any(|known| **known == form) {
                guard.push(Zeroizing::new(form));
            }
        }
        guard.sort_by_key(|needle| std::cmp::Reverse(needle.len()));
    }

    /// `text` with every registered string replaced by `[REDACTED]`.
    #[must_use]
    pub fn scrub(&self, text: &str) -> String {
        let guard = match self.needles.read() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut out = text.to_owned();
        for needle in guard.iter() {
            if out.contains(needle.as_str()) {
                out = out.replace(needle.as_str(), REDACTED);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_and_display_hide_the_value() {
        let secret = Secret::new("sk_live_super_secret_value");
        assert_eq!(format!("{secret:?}"), "Secret([REDACTED])");
        assert_eq!(format!("{secret}"), "[REDACTED]");
        assert_eq!(secret.expose(), "sk_live_super_secret_value");
    }

    #[test]
    fn scrub_replaces_the_value_its_encoding_and_pem_lines() {
        let redactor = Redactor::new();
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxx\nyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\n-----END RSA PRIVATE KEY-----";
        redactor.register(&Secret::new(pem));
        redactor.register(&Secret::new("a secret/with+chars"));
        let scrubbed = redactor.scrub(
            "line MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxx and a%20secret%2Fwith%2Bchars and a secret/with+chars",
        );
        assert!(!scrubbed.contains("MIIEow"), "{scrubbed}");
        assert!(!scrubbed.contains("secret%2Fwith"), "{scrubbed}");
        assert!(!scrubbed.contains("secret/with"), "{scrubbed}");
        assert!(scrubbed.contains(REDACTED));
    }

    #[test]
    fn short_values_are_left_alone() {
        let redactor = Redactor::new();
        redactor.register(&Secret::new("abc"));
        assert!(redactor.is_empty());
        assert_eq!(redactor.scrub("abc def"), "abc def");
    }

    #[test]
    fn a_secret_containing_another_is_replaced_whole() {
        let redactor = Redactor::new();
        redactor.register(&Secret::new("token-1234"));
        redactor.register(&Secret::new("token-1234-extended"));
        assert_eq!(redactor.scrub("x token-1234-extended y"), "x [REDACTED] y");
    }
}
