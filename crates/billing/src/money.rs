//! Money as integer minor units plus an ISO 4217 currency (PLAN §8). No floating point
//! anywhere: decimal strings from Shopify are converted digit by digit.

use std::fmt;
use std::str::FromStr;

/// A money value could not be built or parsed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MoneyError {
    /// The currency is not three ASCII letters.
    #[error("{0:?} is not an ISO 4217 alphabetic currency code")]
    InvalidCurrency(String),
    /// The amount is not a plain decimal number such as `79` or `79.00`.
    #[error("{0:?} is not a decimal amount")]
    InvalidAmount(String),
    /// The amount has non-zero digits below the currency's minor unit, such as `79.001` USD.
    #[error("{amount:?} is more precise than the minor unit of {currency}")]
    TooPrecise {
        /// The amount as received.
        amount: String,
        /// The currency it was given in.
        currency: Currency,
    },
    /// The amount does not fit in 64-bit minor units.
    #[error("{0:?} is too large")]
    Overflow(String),
}

/// An ISO 4217 alphabetic currency code, stored upper-case.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Currency([u8; 3]);

impl Currency {
    /// US dollars: the only currency Shopify App Pricing prices plans in.
    pub const USD: Self = Self(*b"USD");

    /// Parses a three-letter code, accepting either case.
    pub fn new(code: &str) -> Result<Self, MoneyError> {
        match code.as_bytes() {
            [a, b, c] if code.bytes().all(|byte| byte.is_ascii_alphabetic()) => Ok(Self([
                a.to_ascii_uppercase(),
                b.to_ascii_uppercase(),
                c.to_ascii_uppercase(),
            ])),
            _ => Err(MoneyError::InvalidCurrency(code.to_owned())),
        }
    }

    /// The upper-case code, such as `USD`.
    #[must_use]
    pub fn code(&self) -> &str {
        // Construction guarantees three ASCII letters, so this never falls back.
        std::str::from_utf8(&self.0).unwrap_or("XXX")
    }

    /// Digits after the decimal point in the currency's minor unit, per the ISO 4217 list
    /// maintained by SIX (<https://www.six-group.com/en/products-services/financial-information/data-standards.html>).
    #[must_use]
    pub const fn minor_unit_exponent(self) -> u32 {
        match &self.0 {
            b"BIF" | b"CLP" | b"DJF" | b"GNF" | b"ISK" | b"JPY" | b"KMF" | b"KRW" | b"PYG"
            | b"RWF" | b"UGX" | b"UYI" | b"VND" | b"VUV" | b"XAF" | b"XOF" | b"XPF" => 0,
            b"BHD" | b"IQD" | b"JOD" | b"KWD" | b"LYD" | b"OMR" | b"TND" => 3,
            b"CLF" | b"UYW" => 4,
            _ => 2,
        }
    }
}

impl fmt::Debug for Currency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Currency({})", self.code())
    }
}

impl fmt::Display for Currency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl FromStr for Currency {
    type Err = MoneyError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::new(s)
    }
}

/// An amount in the currency's minor units: cents for USD.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Money {
    minor_units: i64,
    currency: Currency,
}

impl Money {
    /// An amount already in minor units.
    #[must_use]
    pub const fn new(minor_units: i64, currency: Currency) -> Self {
        Self {
            minor_units,
            currency,
        }
    }

    /// US cents.
    #[must_use]
    pub const fn usd_cents(cents: i64) -> Self {
        Self::new(cents, Currency::USD)
    }

    /// The amount in minor units.
    #[must_use]
    pub const fn minor_units(self) -> i64 {
        self.minor_units
    }

    /// The currency.
    #[must_use]
    pub const fn currency(self) -> Currency {
        self.currency
    }

    /// Whether the amount is exactly zero.
    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.minor_units == 0
    }

    /// Parses a decimal string such as Shopify's `Decimal` scalar (`"29.00"`) into exact minor
    /// units. Trailing zeros below the minor unit are accepted; any other extra precision is
    /// an error rather than a rounding.
    pub fn parse_decimal(amount: &str, currency: Currency) -> Result<Self, MoneyError> {
        let invalid = || MoneyError::InvalidAmount(amount.to_owned());
        let (negative, unsigned) = match amount.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, amount),
        };
        let (whole, fraction) = match unsigned.split_once('.') {
            Some((whole, fraction)) => (whole, fraction),
            None => (unsigned, ""),
        };
        let digits_only = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
        if whole.is_empty()
            || !digits_only(whole)
            || !digits_only(fraction)
            || (unsigned.contains('.') && fraction.is_empty())
        {
            return Err(invalid());
        }

        let exponent = currency.minor_unit_exponent();
        let exponent_len = usize::try_from(exponent).map_err(|_| invalid())?;
        let (kept, dropped) = fraction.split_at(fraction.len().min(exponent_len));
        if dropped.bytes().any(|byte| byte != b'0') {
            return Err(MoneyError::TooPrecise {
                amount: amount.to_owned(),
                currency,
            });
        }

        let overflow = || MoneyError::Overflow(amount.to_owned());
        // Accumulate with the final sign so that i64::MIN itself is representable.
        let sign: i64 = if negative { -1 } else { 1 };
        let mut minor: i64 = 0;
        let padding = exponent_len.saturating_sub(kept.len());
        for byte in whole
            .bytes()
            .chain(kept.bytes())
            .chain(std::iter::repeat_n(b'0', padding))
        {
            let digit = i64::from(byte - b'0') * sign;
            minor = minor
                .checked_mul(10)
                .and_then(|value| value.checked_add(digit))
                .ok_or_else(overflow)?;
        }
        Ok(Self::new(minor, currency))
    }
}

impl fmt::Display for Money {
    /// `79.00 USD`, with as many decimals as the currency's minor unit.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let exponent = self.currency.minor_unit_exponent();
        let scale = 10_u64.pow(exponent);
        let magnitude = self.minor_units.unsigned_abs();
        let sign = if self.minor_units < 0 { "-" } else { "" };
        let whole = magnitude / scale;
        if exponent == 0 {
            write!(f, "{sign}{whole} {}", self.currency)
        } else {
            let fraction = magnitude % scale;
            let width = usize::try_from(exponent).map_err(|_| fmt::Error)?;
            write!(f, "{sign}{whole}.{fraction:0width$} {}", self.currency)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usd(amount: &str) -> Result<Money, MoneyError> {
        Money::parse_decimal(amount, Currency::USD)
    }

    #[test]
    fn currency_codes_are_three_letters_and_upper_cased() {
        assert_eq!(Currency::new("usd").unwrap(), Currency::USD);
        assert_eq!(Currency::new("EUR").unwrap().code(), "EUR");
        for bad in ["", "US", "USDD", "U5D", "€UR", "us "] {
            assert_eq!(
                Currency::new(bad),
                Err(MoneyError::InvalidCurrency(bad.to_owned())),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn minor_unit_exponents_follow_iso_4217() {
        assert_eq!(Currency::USD.minor_unit_exponent(), 2);
        assert_eq!(Currency::new("JPY").unwrap().minor_unit_exponent(), 0);
        assert_eq!(Currency::new("KWD").unwrap().minor_unit_exponent(), 3);
        assert_eq!(Currency::new("EUR").unwrap().minor_unit_exponent(), 2);
    }

    #[test]
    fn parses_shopify_decimal_strings_exactly() {
        assert_eq!(usd("29.00").unwrap(), Money::usd_cents(2900));
        assert_eq!(usd("79").unwrap(), Money::usd_cents(7900));
        assert_eq!(usd("79.9").unwrap(), Money::usd_cents(7990));
        assert_eq!(usd("0.01").unwrap(), Money::usd_cents(1));
        assert_eq!(usd("4990.000").unwrap(), Money::usd_cents(499_000));
        assert_eq!(usd("-1.50").unwrap(), Money::usd_cents(-150));
        assert_eq!(usd("0").unwrap(), Money::usd_cents(0));
        let yen = Money::parse_decimal("1200", Currency::new("JPY").unwrap()).unwrap();
        assert_eq!(yen.minor_units(), 1200);
        let dinar = Money::parse_decimal("1.5", Currency::new("KWD").unwrap()).unwrap();
        assert_eq!(dinar.minor_units(), 1500);
    }

    #[test]
    fn rejects_malformed_amounts() {
        for bad in [
            "", "-", ".5", "5.", "1,000.00", "1e3", " 1.00", "1.00 ", "--1", "+1", "NaN",
        ] {
            assert_eq!(
                usd(bad),
                Err(MoneyError::InvalidAmount(bad.to_owned())),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn rejects_precision_below_the_minor_unit_instead_of_rounding() {
        assert_eq!(
            usd("79.001"),
            Err(MoneyError::TooPrecise {
                amount: "79.001".to_owned(),
                currency: Currency::USD
            })
        );
        let yen = Currency::new("JPY").unwrap();
        assert!(matches!(
            Money::parse_decimal("1.5", yen),
            Err(MoneyError::TooPrecise { .. })
        ));
    }

    #[test]
    fn rejects_amounts_that_overflow_i64_minor_units() {
        assert_eq!(
            usd("92233720368547758.08"),
            Err(MoneyError::Overflow("92233720368547758.08".to_owned()))
        );
        assert_eq!(usd("92233720368547758.07").unwrap().minor_units(), i64::MAX);
        assert_eq!(
            usd("-92233720368547758.08").unwrap().minor_units(),
            i64::MIN
        );
    }

    #[test]
    fn displays_with_the_currency_minor_unit() {
        assert_eq!(Money::usd_cents(7900).to_string(), "79.00 USD");
        assert_eq!(Money::usd_cents(5).to_string(), "0.05 USD");
        assert_eq!(Money::usd_cents(-150).to_string(), "-1.50 USD");
        assert_eq!(
            Money::new(1200, Currency::new("JPY").unwrap()).to_string(),
            "1200 JPY"
        );
        assert_eq!(
            Money::new(1500, Currency::new("KWD").unwrap()).to_string(),
            "1.500 KWD"
        );
        assert_eq!(format!("{:?}", Currency::USD), "Currency(USD)");
    }
}
