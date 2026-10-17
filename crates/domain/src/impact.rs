//! Severity of a finding, as reported by axe-core.

use std::fmt;
use std::str::FromStr;

/// Severity of a finding. The spelling matches axe-core's `impact` field and the
/// `findings.impact` check constraint (PLAN §9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Impact {
    /// Annoyance that rarely blocks a task.
    Minor,
    /// Makes a task harder for some users.
    Moderate,
    /// Blocks a task for some users.
    Serious,
    /// Blocks a task for many users.
    Critical,
}

impl Impact {
    /// Every impact, least severe first.
    pub const ALL: [Self; 4] = [Self::Minor, Self::Moderate, Self::Serious, Self::Critical];

    /// Weight used in the published priority score (PLAN §11).
    #[must_use]
    pub const fn weight(self) -> u32 {
        match self {
            Self::Minor => 1,
            Self::Moderate => 2,
            Self::Serious => 4,
            Self::Critical => 8,
        }
    }

    /// The spelling stored in the database and returned by axe-core.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Minor => "minor",
            Self::Moderate => "moderate",
            Self::Serious => "serious",
            Self::Critical => "critical",
        }
    }
}

impl fmt::Display for Impact {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The input was not one of axe-core's four impact values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseImpactError {
    input: String,
}

impl fmt::Display for ParseImpactError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "unknown impact {:?}; expected minor, moderate, serious or critical",
            self.input
        )
    }
}

impl std::error::Error for ParseImpactError {}

impl FromStr for Impact {
    type Err = ParseImpactError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|impact| impact.as_str() == s)
            .ok_or_else(|| ParseImpactError {
                input: s.to_owned(),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_match_the_published_priority_formula() {
        // PLAN §11: critical 8, serious 4, moderate 2, minor 1.
        assert_eq!(Impact::Critical.weight(), 8);
        assert_eq!(Impact::Serious.weight(), 4);
        assert_eq!(Impact::Moderate.weight(), 2);
        assert_eq!(Impact::Minor.weight(), 1);
    }

    #[test]
    fn parses_axe_impact_strings() {
        assert_eq!("critical".parse::<Impact>(), Ok(Impact::Critical));
        assert_eq!("serious".parse::<Impact>(), Ok(Impact::Serious));
        assert_eq!("moderate".parse::<Impact>(), Ok(Impact::Moderate));
        assert_eq!("minor".parse::<Impact>(), Ok(Impact::Minor));
    }

    #[test]
    fn rejects_unknown_or_differently_cased_strings() {
        assert!("Critical".parse::<Impact>().is_err());
        assert!("".parse::<Impact>().is_err());
        assert!("blocker".parse::<Impact>().is_err());
    }

    #[test]
    fn round_trips_through_its_database_spelling() {
        for impact in Impact::ALL {
            assert_eq!(impact.as_str().parse::<Impact>(), Ok(impact));
        }
    }

    #[test]
    fn orders_from_least_to_most_severe() {
        assert!(Impact::Minor < Impact::Moderate);
        assert!(Impact::Moderate < Impact::Serious);
        assert!(Impact::Serious < Impact::Critical);
    }
}
