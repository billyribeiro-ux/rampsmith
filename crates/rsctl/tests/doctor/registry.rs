//! The registry itself: every founder input in LAUNCH.md section C has a check, each check
//! stays inside the variables it declares, and the variable list has not drifted from the doc.

use std::collections::{BTreeMap, BTreeSet};

use rsctl::doctor::{self, CHECKS, CheckDef, Ctx, ProbeFuture};
use rsctl::report::{Outcome, SkipKind, Target};
use rsctl::vars::Var;

use crate::support::Rig;

fn launch_section_c() -> BTreeMap<u8, BTreeSet<String>> {
    let path = format!("{}/../../docs/LAUNCH.md", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
    let section = text
        .split("\n## C. ")
        .nth(1)
        .and_then(|rest| rest.split("\n## D. ").next())
        .expect("LAUNCH.md has a section C");
    let mut rows = BTreeMap::new();
    for line in section.lines().filter(|line| line.starts_with("| ")) {
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        // | # | Input | Needed for | Variables | How the code proves it works |
        let (Some(number), Some(variables)) = (cells.get(1), cells.get(4)) else {
            continue;
        };
        let Ok(number) = number.parse::<u8>() else {
            continue;
        };
        let names = variables
            .split('`')
            .skip(1)
            .step_by(2)
            .filter(|token| {
                token.len() > 2
                    && token.starts_with(|c: char| c.is_ascii_uppercase())
                    && token
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            })
            .map(str::to_owned)
            .collect();
        rows.insert(number, names);
    }
    rows
}

#[test]
fn the_variables_match_launch_section_c_rows_1_to_12_and_16_exactly() {
    let doc = launch_section_c();
    for row in (1..=12_u8).chain([16]) {
        let in_doc = doc
            .get(&row)
            .unwrap_or_else(|| panic!("LAUNCH.md section C has no row {row}"));
        let in_code: BTreeSet<String> = Var::ALL
            .iter()
            .filter(|var| var.row() == row)
            .map(|var| var.name().to_owned())
            .collect();
        assert_eq!(
            in_doc, &in_code,
            "row {row}: LAUNCH.md and rsctl's variable list disagree. A new founder input needs a \
             `Var` in crates/rsctl/src/vars.rs and a probe in crates/rsctl/src/doctor/"
        );
    }
}

#[test]
fn row_15_names_no_variables_of_its_own() {
    // "The same names as rows 1, 2 and 4": nothing new for rsctl to read.
    assert!(launch_section_c().get(&15).is_some_and(BTreeSet::is_empty));
}

#[test]
fn every_row_from_1_to_12_and_16_has_a_check_and_row_15_is_staging_only() {
    for row in (1..=12_u8).chain([16]) {
        assert!(
            CHECKS.iter().any(|def| def.row == row),
            "no check for C row {row}"
        );
    }
    let staging: Vec<_> = CHECKS.iter().filter(|def| def.staging_only).collect();
    assert_eq!(staging.len(), 1);
    assert_eq!(staging[0].row, 15);
    assert!(
        CHECKS
            .iter()
            .filter(|def| !def.staging_only)
            .all(|def| def.row <= 12 || def.row == 16)
    );
}

#[test]
fn every_variable_is_read_by_some_check() {
    let read: BTreeSet<Var> = CHECKS
        .iter()
        .flat_map(|def| def.reads.iter().copied())
        .collect();
    for var in Var::ALL {
        assert!(read.contains(var), "{} is read by no check", var.name());
    }
}

#[test]
fn check_ids_are_unique_and_reads_stay_in_the_checks_own_row_except_where_documented() {
    let ids: BTreeSet<&str> = CHECKS.iter().map(|def| def.id).collect();
    assert_eq!(ids.len(), CHECKS.len(), "duplicate check ids");
    // Documented cross-row reads (ADR-152):
    // - shopify.app exchanges the client credentials on development store A (row 3);
    // - shopify.partner-api compares the app's apiKey with SHOPIFY_API_KEY (row 1);
    // - staging.separate-apps compares rows 1 and 4 identifiers with production's.
    let allowed: BTreeMap<&str, Vec<Var>> = BTreeMap::from([
        ("shopify.app", vec![Var::ShopifyDevStoreDomain]),
        ("shopify.partner-api", vec![Var::ShopifyApiKey]),
        (
            "staging.separate-apps",
            vec![Var::ShopifyApiKey, Var::GithubAppId],
        ),
        // The backup and drill tokens (row 16) are proved on the buckets of row 6.
        (
            "r2.backup-token",
            vec![Var::R2AccountId, Var::R2BucketBackups],
        ),
        (
            "r2.drill-token",
            vec![Var::R2AccountId, Var::R2BucketBackups],
        ),
    ]);
    for def in CHECKS {
        for var in def.reads {
            let extra = allowed.get(def.id).is_some_and(|vars| vars.contains(var));
            assert!(
                var.row() == def.row || extra,
                "{} reads {} from row {}",
                def.id,
                var.name(),
                var.row()
            );
        }
    }
}

#[tokio::test]
async fn with_nothing_set_every_check_skips_naming_its_row() {
    let mut rig = Rig::new(&[]).await;
    rig.options.target = Target::Staging;
    let (report, ctx) = rig.report().await;
    assert_eq!(report.findings.len(), CHECKS.len());
    for finding in &report.findings {
        match &finding.outcome {
            Outcome::Skip(SkipKind::MissingInput, detail) => assert!(
                detail.contains(&format!("C row {}", finding.row)),
                "{} does not name its row: {detail}",
                finding.id
            ),
            other => panic!("{} should SKIP with nothing set, got {other:?}", finding.id),
        }
    }
    // A skip is not a failure; under --strict the missing required inputs are.
    assert_eq!(report.exit_code(false), 0);
    assert_eq!(report.exit_code(true), 1);
    let text = report.render_text(&ctx.redactor, true);
    assert!(
        text.lines().filter(|l| l.starts_with("SKIP")).count() == CHECKS.len(),
        "{text}"
    );
    assert!(
        rig.server.received_requests().await.unwrap().is_empty(),
        "no input, no request"
    );
}

#[tokio::test]
async fn production_runs_skip_the_staging_check_and_rows_filter() {
    let rig = Rig::new(&[]).await;
    let (report, _) = rig.report().await;
    assert!(report.findings.iter().all(|f| f.row != 15));

    let mut rig = Rig::new(&[]).await;
    rig.options.rows = vec![5, 12];
    let ctx = rig.ctx();
    let report = doctor::run(ctx).await;
    let rows: Vec<u8> = report.findings.iter().map(|f| f.row).collect();
    assert_eq!(rows, vec![5, 12]);
}

#[tokio::test]
async fn optional_inputs_and_row_11_do_not_fail_strict_runs() {
    let mut rig = Rig::new(&[]).await;
    rig.options.rows = vec![10, 11];
    let (report, _) = rig.report().await;
    assert_eq!(report.exit_code(true), 0, "{report:?}");
    for finding in &report.findings {
        assert!(!finding.required, "{} is optional", finding.id);
    }
}

fn boom(_ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async { panic!("PAYLOAD-WITH-A-SECRET") })
}

fn fine(_ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async { Outcome::pass("ok") })
}

static CRASHING: [CheckDef; 3] = [
    CheckDef {
        id: "fine.before",
        row: 1,
        required: true,
        staging_only: false,
        reads: &[],
        run: fine,
    },
    CheckDef {
        id: "crash",
        row: 2,
        required: true,
        staging_only: false,
        reads: &[],
        run: boom,
    },
    CheckDef {
        id: "fine.after",
        row: 3,
        required: true,
        staging_only: false,
        reads: &[],
        run: fine,
    },
];

#[tokio::test]
async fn a_probe_that_panics_fails_alone_and_its_payload_is_dropped() {
    let rig = Rig::new(&[]).await;
    let report = doctor::run_checks(rig.ctx(), &CRASHING).await;
    let ids: Vec<&str> = report.findings.iter().map(|f| f.id).collect();
    assert_eq!(
        ids,
        ["fine.before", "crash", "fine.after"],
        "registry order is kept"
    );
    assert_eq!(report.findings[0].outcome, Outcome::pass("ok"));
    assert_eq!(
        report.findings[1].outcome,
        Outcome::fail("the probe crashed (internal error)")
    );
    assert_eq!(report.findings[2].outcome, Outcome::pass("ok"));
    assert_eq!(report.exit_code(false), 1);
    let ctx = rig.ctx();
    assert!(!report.render_text(&ctx.redactor, false).contains("PAYLOAD"));
    assert!(!report.render_json(&ctx.redactor, false).contains("PAYLOAD"));
}
