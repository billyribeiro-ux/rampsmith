//! What `rsctl doctor` prints: one line per input, PASS, FAIL with a reason, or SKIP naming
//! the missing row (ADR-151). Both renderings pass every line through the [`Redactor`].

use std::fmt::Write as _;

use serde::Serialize;

use crate::secret::Redactor;
use crate::vars::{Gap, Var, names};

/// Why a check did not run to a verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipKind {
    /// The input is not set: the founder has not added it yet.
    MissingInput,
    /// The input is set, but the vendor documents no way to check it without using it.
    NotVerifiable,
}

/// The result of one probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The input works.
    Pass(String),
    /// The input is present and does not work, or is incomplete.
    Fail(String),
    /// No verdict.
    Skip(SkipKind, String),
}

impl Outcome {
    /// A pass.
    #[must_use]
    pub fn pass(detail: impl Into<String>) -> Self {
        Self::Pass(detail.into())
    }

    /// A failure.
    #[must_use]
    pub fn fail(detail: impl Into<String>) -> Self {
        Self::Fail(detail.into())
    }

    /// A skip because the input is absent.
    #[must_use]
    pub fn missing(detail: impl Into<String>) -> Self {
        Self::Skip(SkipKind::MissingInput, detail.into())
    }

    /// A skip because the vendor offers no way to check the input.
    #[must_use]
    pub fn not_verifiable(detail: impl Into<String>) -> Self {
        Self::Skip(SkipKind::NotVerifiable, detail.into())
    }

    /// The outcome for an input that is not (fully) set.
    #[must_use]
    pub fn from_gap(gap: &Gap) -> Self {
        match gap {
            Gap::NoneSet { row, missing } => {
                Self::missing(format!("not set: {} (C row {row})", names(missing)))
            }
            Gap::Partial { row, missing } => Self::fail(format!(
                "C row {row} is incomplete: {} not set",
                names(missing)
            )),
        }
    }

    /// The outcome for an input that is missing because another row's input is.
    #[must_use]
    pub fn needs_row(row: u8, vars: &[Var], why: &str) -> Self {
        Self::missing(format!("needs C row {row} ({}) {why}", names(vars)))
    }

    const fn word(&self) -> &'static str {
        match self {
            Self::Pass(_) => "PASS",
            Self::Fail(_) => "FAIL",
            Self::Skip(..) => "SKIP",
        }
    }

    /// The text after the verdict.
    #[must_use]
    pub fn detail(&self) -> &str {
        match self {
            Self::Pass(d) | Self::Fail(d) | Self::Skip(_, d) => d,
        }
    }
}

/// A check's outcome with the check's identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// A stable id such as `r2.evidence`.
    pub id: &'static str,
    /// The LAUNCH.md section C row.
    pub row: u8,
    /// Whether `--strict` treats a missing input as a failure.
    pub required: bool,
    /// The verdict.
    pub outcome: Outcome,
}

/// Which environment the founder is checking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    /// The production environment's inputs.
    Production,
    /// The staging environment's inputs (C row 15).
    Staging,
}

impl Target {
    /// `production` or `staging`.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Staging => "staging",
        }
    }
}

/// The findings of one run.
#[derive(Debug, Clone)]
pub struct Report {
    /// What was checked.
    pub target: Target,
    /// One finding per check, in LAUNCH.md order.
    pub findings: Vec<Finding>,
}

/// Counts by verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Summary {
    /// Checks that passed.
    pub pass: usize,
    /// Checks that failed.
    pub fail: usize,
    /// Checks that gave no verdict.
    pub skip: usize,
}

#[derive(Serialize)]
struct JsonCheck<'a> {
    id: &'a str,
    row: u8,
    status: &'a str,
    detail: String,
    required: bool,
    skip_kind: Option<SkipKind>,
}

#[derive(Serialize)]
struct JsonReport<'a> {
    environment: Target,
    checks: Vec<JsonCheck<'a>>,
    summary: Summary,
    ok: bool,
}

impl Report {
    /// Counts by verdict.
    #[must_use]
    pub fn summary(&self) -> Summary {
        let count = |word: &str| {
            self.findings
                .iter()
                .filter(|f| f.outcome.word() == word)
                .count()
        };
        Summary {
            pass: count("PASS"),
            fail: count("FAIL"),
            skip: count("SKIP"),
        }
    }

    /// Whether the run succeeded: no failure, and with `strict` no required input missing.
    #[must_use]
    pub fn ok(&self, strict: bool) -> bool {
        self.findings.iter().all(|f| match &f.outcome {
            Outcome::Pass(_) => true,
            Outcome::Fail(_) => false,
            Outcome::Skip(kind, _) => !(strict && f.required && *kind == SkipKind::MissingInput),
        })
    }

    /// The process exit code: 0 on success, 1 otherwise.
    #[must_use]
    pub fn exit_code(&self, strict: bool) -> u8 {
        u8::from(!self.ok(strict))
    }

    /// The text report, one line per check and a summary.
    #[must_use]
    pub fn render_text(&self, redactor: &Redactor, strict: bool) -> String {
        let mut out = format!("rsctl doctor ({})\n", self.target.name());
        for finding in &self.findings {
            let line = format!(
                "{:<4}  C{:<3} {:<26} {}",
                finding.outcome.word(),
                finding.row,
                finding.id,
                finding.outcome.detail()
            );
            // Writing to a String cannot fail.
            let _ = writeln!(out, "{}", redactor.scrub(&line));
        }
        let s = self.summary();
        let _ = writeln!(
            out,
            "{} passed, {} failed, {} skipped{}",
            s.pass,
            s.fail,
            s.skip,
            if self.ok(strict) { "" } else { " (exit 1)" }
        );
        out
    }

    /// The report as one JSON document.
    #[must_use]
    pub fn render_json(&self, redactor: &Redactor, strict: bool) -> String {
        let checks = self
            .findings
            .iter()
            .map(|f| JsonCheck {
                id: f.id,
                row: f.row,
                status: f.outcome.word(),
                detail: redactor.scrub(f.outcome.detail()),
                required: f.required,
                skip_kind: match &f.outcome {
                    Outcome::Skip(kind, _) => Some(*kind),
                    _ => None,
                },
            })
            .collect();
        let document = JsonReport {
            environment: self.target,
            checks,
            summary: self.summary(),
            ok: self.ok(strict),
        };
        // Serializing owned strings and numbers cannot fail; the fallback keeps this total.
        let mut text =
            serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{\"ok\":false}".to_owned());
        text.push('\n');
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::Secret;

    fn finding(id: &'static str, row: u8, required: bool, outcome: Outcome) -> Finding {
        Finding {
            id,
            row,
            required,
            outcome,
        }
    }

    fn sample() -> Report {
        Report {
            target: Target::Production,
            findings: vec![
                finding(
                    "anthropic.models",
                    5,
                    true,
                    Outcome::pass("3 models listed"),
                ),
                finding(
                    "stripe.account",
                    11,
                    false,
                    Outcome::missing("not set: STRIPE_SECRET_KEY (C row 11)"),
                ),
                finding(
                    "shopify.automation-token",
                    2,
                    true,
                    Outcome::not_verifiable("present; no documented check"),
                ),
            ],
        }
    }

    #[test]
    fn a_run_with_only_passes_and_skips_succeeds() {
        let report = sample();
        assert_eq!(
            report.summary(),
            Summary {
                pass: 1,
                fail: 0,
                skip: 2
            }
        );
        assert!(report.ok(false));
        assert!(
            report.ok(true),
            "optional and unverifiable skips are fine under --strict"
        );
        assert_eq!(report.exit_code(false), 0);
    }

    #[test]
    fn a_failure_fails_the_run() {
        let mut report = sample();
        report
            .findings
            .push(finding("r2.backups", 6, true, Outcome::fail("HTTP 403")));
        assert!(!report.ok(false));
        assert_eq!(report.exit_code(false), 1);
    }

    #[test]
    fn strict_fails_on_a_missing_required_input_only() {
        let mut report = sample();
        report.findings.push(finding(
            "github.app",
            4,
            true,
            Outcome::missing("not set (C row 4)"),
        ));
        assert!(report.ok(false));
        assert!(!report.ok(true));
        assert_eq!(report.exit_code(true), 1);
    }

    #[test]
    fn the_text_report_has_one_line_per_check_and_a_summary() {
        let text = sample().render_text(&Redactor::new(), false);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 5, "{text}");
        assert!(lines[1].starts_with("PASS  C5"), "{text}");
        assert!(lines[2].starts_with("SKIP  C11"), "{text}");
        assert!(lines[2].contains("(C row 11)"));
        assert_eq!(lines[4], "1 passed, 0 failed, 2 skipped");
    }

    #[test]
    fn json_carries_the_same_facts_and_scrubs_secrets() {
        let redactor = Redactor::new();
        redactor.register(&Secret::new("sk-ant-very-secret"));
        let mut report = sample();
        report.findings.push(finding(
            "x",
            5,
            true,
            Outcome::fail("echo sk-ant-very-secret"),
        ));
        let json = report.render_json(&redactor, false);
        assert!(!json.contains("very-secret"), "{json}");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["environment"], "production");
        assert_eq!(value["summary"]["fail"], 1);
        assert_eq!(value["ok"], false);
        assert_eq!(value["checks"][1]["skip_kind"], "missing_input");
        assert_eq!(value["checks"][2]["skip_kind"], "not_verifiable");
        assert_eq!(value["checks"][0]["status"], "PASS");
    }

    #[test]
    fn gaps_become_skips_naming_the_row_or_failures_naming_what_is_missing() {
        let none = Outcome::from_gap(&Gap::NoneSet {
            row: 5,
            missing: vec![Var::AnthropicApiKey],
        });
        assert_eq!(
            none,
            Outcome::missing("not set: ANTHROPIC_API_KEY (C row 5)")
        );
        let part = Outcome::from_gap(&Gap::Partial {
            row: 6,
            missing: vec![Var::R2BucketBackups],
        });
        assert_eq!(
            part,
            Outcome::fail("C row 6 is incomplete: R2_BUCKET_BACKUPS not set")
        );
    }
}
