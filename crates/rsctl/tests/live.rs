//! The live checks: every `rsctl doctor` probe against the real vendor, one trial per probe
//! (LAUNCH.md section E, ADR-155).
//!
//! A trial runs whenever an input it reads is present. Otherwise it is marked ignored, its
//! name says `skipped_C_row_<n>`, and a notice naming the row and the variables goes to
//! standard error. A skipped trial that is forced to run fails: it never passes silently.
//! Run them live (`--no-tests=pass` because, with no input set, every trial is skipped):
//!
//! ```text
//! cargo nextest run -p rampsmith-rsctl --test live --no-tests=pass
//! cargo test -p rampsmith-rsctl --test live
//! ```
//!
//! The same probes run from `rsctl doctor`; this binary is the test-runner form of it.

// Test code: PLAN §8 denies these lints outside tests only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::print_stderr,
    unreachable_pub,
    dead_code
)]

use std::sync::Arc;

use libtest_mimic::{Arguments, Completion, Failed, Trial};
use rsctl::doctor::Endpoints;
use rsctl::vars::{EnvSource, ProcessEnv};

#[path = "live_plan/plan.rs"]
mod plan;

use plan::{Plan, Verdict};

fn trial(plan: Plan, env: Arc<dyn EnvSource>) -> Trial {
    let skipped = plan.skip.is_some();
    let name = plan.name.clone();
    Trial::ignorable_test(name, move || {
        if let Some(notice) = plan.skip.clone() {
            // Only a forced run (--include-ignored, --run-ignored) gets here. Nothing was
            // checked, and a test runner would count a quiet return as a pass.
            return Err(Failed::from(format!(
                "{notice}. This trial was forced to run without its input, so it proves nothing: set the input, or do not force skipped trials to run"
            )));
        }
        match plan::execute(&plan, env, Endpoints::default()) {
            Verdict::Passed(detail) => {
                eprintln!("rsctl live: PASS C row {} {}: {detail}", plan.row, plan.id);
                Ok(Completion::Completed)
            }
            Verdict::Ignored(reason) => Ok(Completion::ignored_with(reason)),
            Verdict::Failed(reason) => Err(Failed::from(reason)),
        }
    })
    .with_ignored_flag(skipped)
}

fn main() {
    let args = Arguments::from_args();
    let env: Arc<dyn EnvSource> = Arc::new(ProcessEnv);
    let plans = plan::plan(&env);
    if !args.list {
        for plan in &plans {
            if let Some(notice) = &plan.skip {
                eprintln!("rsctl live: SKIP {} ({notice})", plan.id);
            }
        }
    }
    let trials = plans
        .into_iter()
        .map(|plan| trial(plan, Arc::clone(&env)))
        .collect();
    libtest_mimic::run(&args, trials).exit();
}
