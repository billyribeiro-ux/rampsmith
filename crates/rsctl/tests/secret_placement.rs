//! Where founder secrets live (ADR-092): Railway variables, or secrets of one GitHub
//! environment that only `main` can deploy to; never repository or organization secrets.
//!
//! Three things have to agree and this test keeps them equal: rsctl's list of founder secret
//! names (`founder_secret_names`), the `secrets-scope` job of `.github/workflows/ci.yml` that
//! fails when one of them exists at repository level, and `docs/FOUNDER_SETUP.md`, which tells
//! the founder where each goes. It also fails when a workflow starts to read a founder secret
//! it has no business with.

// Test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use rsctl::vars::founder_secret_names;

fn repo_file(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// Whether a workflow line starts a job: two spaces of indent, a name, a colon.
fn is_job_header(line: &str) -> bool {
    line.starts_with("  ")
        && !line.starts_with("   ")
        && line.trim_end().ends_with(':')
        && !line.trim_start().starts_with('#')
}

/// The lines of the job `name` in a workflow: from `  name:` to the next job (or the end).
fn job_block(workflow: &str, name: &str) -> Vec<String> {
    let header = format!("  {name}:");
    let mut lines = workflow.lines().skip_while(|line| *line != header);
    assert!(lines.next().is_some(), "no job `{name}`");
    lines
        .take_while(|line| !is_job_header(line))
        .map(str::to_owned)
        .collect()
}

/// `Both` and a bare `GH` meant a repository secret; `GH env` is an environment secret.
fn sends_to_a_repository_secret(destination: &str) -> bool {
    let environment = destination.starts_with("GH env");
    destination.starts_with("Both") || (destination.starts_with("GH") && !environment)
}

#[test]
fn the_ci_secrets_scope_job_lists_exactly_rsctls_founder_secret_names() {
    let ci = repo_file(".github/workflows/ci.yml");
    let job = job_block(&ci, "secrets-scope");
    let text = job.join("\n");

    // No environment (a job with one would see that environment's secrets, not the
    // repository's), and no token permissions at all.
    assert!(
        !text.contains("environment:"),
        "secrets-scope has an environment"
    );
    assert!(
        text.contains("permissions: {}"),
        "secrets-scope needs `permissions: {{}}`"
    );
    assert!(
        !text.contains("checkout"),
        "secrets-scope checks nothing out"
    );

    let mut listed = BTreeSet::new();
    for line in &job {
        let Some(rest) = line.trim().strip_prefix("SCOPE_") else {
            continue;
        };
        let (name, value) = rest
            .split_once(": ")
            .expect("SCOPE_NAME: ${{ secrets.NAME }}");
        assert_eq!(
            value,
            format!("${{{{ secrets.{name} }}}}"),
            "SCOPE_{name} must read the secret of the same name"
        );
        assert!(listed.insert(name.to_owned()), "{name} is listed twice");
    }
    let expected: BTreeSet<String> = founder_secret_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    assert_eq!(
        listed, expected,
        "ci.yml's secrets-scope and rsctl's founder secret names disagree. Add a new founder \
         secret to `Var` (crates/rsctl/src/vars.rs) and to the job, in the same change"
    );
}

/// Where each founder secret may be read as `secrets.NAME`: the workflows named here, and no
/// others. The scope jobs read every name to prove it is absent at repository level; the
/// environment jobs read their own secrets.
fn allowed_readers() -> BTreeMap<&'static str, Vec<&'static str>> {
    let mut allowed: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for name in founder_secret_names() {
        allowed.insert(name, vec!["ci.yml"]);
    }
    // Deploy secrets: secrets of the `staging` and `production` environments (ADR-185).
    for name in ["RAILWAY_TOKEN", "SHOPIFY_APP_AUTOMATION_TOKEN"] {
        allowed.insert(name, vec!["ci.yml", "deploy.yml", "release.yml"]);
    }
    // The restore drill's secrets: secrets of the `backup-drill` environment (ADR-092).
    for name in [
        "DRILL_R2_ACCESS_KEY_ID",
        "DRILL_R2_SECRET_ACCESS_KEY",
        "BACKUP_DRILL_AGE_KEY",
    ] {
        allowed.insert(name, vec!["ci.yml", "restore-drill.yml"]);
    }
    // Held by Railway services only; restore-drill.yml's scope job proves they are not in GitHub.
    for name in [
        "BACKUP_R2_ACCESS_KEY_ID",
        "BACKUP_R2_SECRET_ACCESS_KEY",
        "BACKUP_DB_PASSWORD",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "RAILWAY_API_TOKEN",
    ] {
        allowed.insert(name, vec!["ci.yml", "restore-drill.yml"]);
    }
    allowed
}

#[test]
fn only_the_listed_workflows_read_a_founder_secret() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.github/workflows");
    let allowed = allowed_readers();
    let mut files = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        files += 1;
        let file = path.file_name().unwrap().to_str().unwrap().to_owned();
        let text = std::fs::read_to_string(&path).unwrap();
        for (name, readers) in &allowed {
            let reads = text.contains(&format!("secrets.{name}"));
            assert!(
                !reads || readers.contains(&file.as_str()),
                "{file} reads secrets.{name}. A founder secret is read only by {readers:?}; if a \
                 workflow needs it, put it in a GitHub environment limited to main, add the \
                 workflow here, and say so in docs/FOUNDER_SETUP.md section 0"
            );
        }
    }
    assert!(files >= 5, "found only {files} workflows");
}

#[test]
fn backup_workflow_and_ssh_transport_are_gone() {
    // The nightly backup runs as a Railway cron service (ADR-090); GitHub holds no credential
    // that could write a backup, so there is no backup workflow to read a secret.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.github/workflows/backup.yml");
    assert!(!path.exists(), "backup.yml is back");
    for workflow in ["restore-drill.yml", "release.yml", "deploy.yml", "ci.yml"] {
        let text = repo_file(&format!(".github/workflows/{workflow}"));
        for forbidden in ["railway-ssh", "BACKUP_SOURCE", "infra/backup/gate.sh"] {
            assert!(!text.contains(forbidden), "{workflow} mentions {forbidden}");
        }
    }
}

#[test]
fn founder_setup_sends_no_founder_secret_to_a_repository_secret() {
    let guide = repo_file("docs/FOUNDER_SETUP.md");
    // Every "→ destination" is Railway (RW), or a GitHub *environment* secret (GH env) that the
    // guide limits to main. "GH" alone and "Both" meant a repository secret.
    for (number, line) in guide.lines().enumerate() {
        let Some((_, destination)) = line.rsplit_once(" → ") else {
            continue;
        };
        let destination = destination.trim_start();
        assert!(
            !sends_to_a_repository_secret(destination),
            "FOUNDER_SETUP.md line {}: `{}` sends a value to a repository secret",
            number + 1,
            line.trim()
        );
    }
    // Every founder secret is named in the guide, so it says where each goes.
    for name in founder_secret_names() {
        assert!(
            guide.contains(&format!("`{name}`")),
            "{name} is not in FOUNDER_SETUP.md"
        );
    }
    // The guide itself says repository secrets are never used.
    assert!(guide.contains("no repository or organization secrets"));
    // A GitHub environment secret is only for a workflow that needs it, on a main-only environment.
    for environment in ["staging", "production", "backup-drill"] {
        assert!(guide.contains(&format!("`{environment}`")), "{environment}");
    }
}

#[test]
fn launch_md_names_the_environment_secrets_and_the_row_16_inputs() {
    let launch = repo_file("docs/LAUNCH.md");
    for must in [
        "BACKUP_DRILL_READY",
        "backup-drill",
        "BACKUP_R2_ACCESS_KEY_ID",
        "DRILL_R2_ACCESS_KEY_ID",
        "secrets-scope",
    ] {
        assert!(launch.contains(must), "LAUNCH.md does not mention {must}");
    }
    assert!(
        !launch.contains("**GitHub Actions secrets** (for CI"),
        "LAUNCH.md still sends secrets to GitHub Actions secrets for CI"
    );
}
