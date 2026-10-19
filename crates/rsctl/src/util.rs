//! Small pure helpers shared by the probes.

use std::fmt::Write as _;

use sha2::{Digest, Sha256};
use time::OffsetDateTime;

/// AWS's `UriEncode` (also fine for any RFC 3986 percent-encoding): every byte except the
/// unreserved characters `A-Z a-z 0-9 - _ . ~` becomes `%XX` in upper-case hex. A `/` is kept
/// unless `encode_slash` is set.
#[must_use]
pub fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(char::from(byte));
            }
            b'/' if !encode_slash => out.push('/'),
            _ => {
                // Writing to a String cannot fail.
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

/// Decodes `%XX` escapes (W3C Baggage values, as `OTEL_EXPORTER_OTLP_HEADERS` uses). A `+`
/// stays a plus. Returns `None` for a bad escape or non-UTF-8 output.
#[must_use]
pub fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&byte) = bytes.get(i) {
        if byte == b'%' {
            let hi = bytes.get(i + 1).copied().and_then(hex_value)?;
            let lo = bytes.get(i + 2).copied().and_then(hex_value)?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(byte);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Lower-case hex.
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // Writing to a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Lower-case hex SHA-256.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// A vendor-supplied identifier made safe to print: only `A-Z a-z 0-9 _ - . : /` survive
/// (anything else becomes `_`), cut to 64 characters. Probes print vendor error codes through
/// this and never print vendor free text.
#[must_use]
pub fn safe_token(input: &str) -> String {
    input
        .chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '/') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// `YYYYMMDDTHHMMSSZ`, as `SigV4`'s `x-amz-date` and the probe object names use.
#[must_use]
pub fn compact_timestamp(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    )
}

/// `YYYYMMDD`.
#[must_use]
pub fn compact_date(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    format!("{:04}{:02}{:02}", at.year(), u8::from(at.month()), at.day())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_encode_follows_the_aws_rules() {
        assert_eq!(uri_encode("AZaz09-_.~", true), "AZaz09-_.~");
        assert_eq!(uri_encode("a b/c", false), "a%20b/c");
        assert_eq!(uri_encode("a b/c", true), "a%20b%2Fc");
        assert_eq!(uri_encode("ops@example.com", true), "ops%40example.com");
        assert_eq!(uri_encode("ሴ", false), "%E1%88%B4");
        assert_eq!(uri_encode("$", false), "%24");
    }

    #[test]
    fn percent_decode_round_trips_and_rejects_bad_escapes() {
        assert_eq!(
            percent_decode("Basic%20abc+def=").as_deref(),
            Some("Basic abc+def=")
        );
        assert_eq!(percent_decode("%E1%88%B4").as_deref(), Some("ሴ"));
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%4"), None);
        assert_eq!(percent_decode("%FF"), None);
    }

    #[test]
    fn hashes_and_hex() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }

    #[test]
    fn safe_token_keeps_codes_and_drops_everything_else() {
        assert_eq!(
            safe_token("invalid-input-response"),
            "invalid-input-response"
        );
        assert_eq!(safe_token("sk_live_abc def\n<x>"), "sk_live_abc_def__x_");
        assert_eq!(safe_token(&"a".repeat(200)).len(), 64);
    }

    #[test]
    fn timestamps_are_compact_utc() {
        let at = OffsetDateTime::from_unix_timestamp(1_440_938_160).unwrap();
        assert_eq!(compact_timestamp(at), "20150830T123600Z");
        assert_eq!(compact_date(at), "20150830");
    }
}
