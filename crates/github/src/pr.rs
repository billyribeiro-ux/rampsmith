//! The fix pull-request builder (PLAN §15 "Pull requests", ADR-124). Pure: it turns a batch of
//! fixes into pull-request plans, commit messages, bodies and the verification check run, and
//! never touches the network.
//!
//! Splitting rules, all deterministic:
//! 1. Fixes that edit the same file stay in the same pull request, in batch order, because
//!    each fix's patch is computed on top of the previous one (the patch chain).
//! 2. Those groups are packed first-fit, in batch order, into pull requests of at most 20
//!    files and 400 changed lines.
//! 3. A group that alone exceeds the cap cannot be split without breaking a fix, so it gets a
//!    pull request of its own, marked `over_cap`, whose body says why it is larger.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::{self, Write as _};

use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};
use url::Url;

use crate::diff::changed_lines;
use crate::guard::{BranchRejection, ThemePath, WritableBranch};
use crate::markdown::{code_span, escape_text, one_line, truncate};
use crate::types::{BatchId, FixId, Sha, WcagCriterion};

/// Longest commit subject summary, in characters, after whitespace is collapsed.
pub const MAX_SUMMARY_CHARS: usize = 100;

/// Longest finding text kept in a commit body or pull request body, in characters.
pub const MAX_FINDING_CHARS: usize = 300;

/// The Git file mode of a changed file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FileMode {
    /// `100644`, a regular file: every theme file.
    #[default]
    Regular,
    /// `100755`, an executable file, kept when a fix edits one.
    Executable,
}

impl FileMode {
    /// The mode as GitHub's create-a-tree endpoint takes it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Regular => "100644",
            Self::Executable => "100755",
        }
    }
}

/// One file as a fix changes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePatch {
    /// The file, inside the theme directories.
    pub path: ThemePath,
    /// Its mode, kept as it is in the repository.
    pub mode: FileMode,
    /// The content the fix starts from: the base branch's content, or the previous fix's
    /// result when an earlier fix in the batch edits the same file.
    pub before: String,
    /// The content after the fix.
    pub after: String,
}

/// One approved fix and its evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fix {
    /// The fix's id, linked from the commit trailer.
    pub id: FixId,
    /// Rampsmith's one-line description of the change, such as "add accessible name to cart
    /// icon link". It becomes the commit subject.
    pub summary: String,
    /// The finding the fix resolves. It may quote storefront text, so it is treated as
    /// untrusted.
    pub finding: String,
    /// The WCAG 2.2 success criterion.
    pub criterion: WcagCriterion,
    /// The before and after evidence inside the app, which requires sign-in.
    pub evidence_url: Url,
    /// The files it changes.
    pub files: Vec<FilePatch>,
}

/// The fixes approved together, in the order their commits are made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Batch {
    /// The batch id, which names the head branch.
    pub id: BatchId,
    /// The fixes.
    pub fixes: Vec<Fix>,
}

/// The reviewable-size cap of PLAN §15.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrLimits {
    /// Most files one pull request changes.
    pub max_files: usize,
    /// Most changed lines (additions plus deletions) in one pull request.
    pub max_changed_lines: u32,
}

impl Default for PrLimits {
    /// 20 files and 400 changed lines (PLAN §15).
    fn default() -> Self {
        Self {
            max_files: 20,
            max_changed_lines: 400,
        }
    }
}

/// A file's content after one commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    /// The file.
    pub path: ThemePath,
    /// Its mode.
    pub mode: FileMode,
    /// The full new content, which becomes a blob.
    pub content: String,
}

/// One commit: one fix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitPlan {
    /// The fix.
    pub fix_id: FixId,
    /// The full commit message, ending with the `Rampsmith-Fix` trailer.
    pub message: String,
    /// The files as this commit leaves them.
    pub changes: Vec<FileChange>,
}

/// One pull request to open or update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestPlan {
    /// The head branch, under `rampsmith/` and never the connected branch.
    pub head: WritableBranch,
    /// This plan's number, from 1.
    pub part: usize,
    /// How many pull requests the batch became.
    pub parts: usize,
    /// The title.
    pub title: String,
    /// The Markdown body.
    pub body: String,
    /// The commits, one per fix, in batch order.
    pub commits: Vec<CommitPlan>,
    /// Files changed.
    pub files: usize,
    /// Changed lines, base to head.
    pub changed_lines: u32,
    /// True only when one indivisible group of fixes exceeds the cap on its own.
    pub over_cap: bool,
}

/// Why a batch cannot become pull requests. Messages carry ids and rule names, never file
/// content.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlanError {
    /// The batch has no fixes.
    #[error("the batch has no fixes")]
    EmptyBatch,
    /// A fix changes no files.
    #[error("fix {0} changes no files")]
    EmptyFix(FixId),
    /// Two fixes share an id.
    #[error("fix {0} appears twice in the batch")]
    DuplicateFix(FixId),
    /// A fix lists the same file twice.
    #[error("fix {fix} lists {path} twice")]
    DuplicatePath {
        /// The fix.
        fix: FixId,
        /// The file.
        path: ThemePath,
    },
    /// A file's before and after are identical; recipes are idempotent, so a no-op is not a
    /// fix.
    #[error("fix {fix} does not change {path}")]
    NoChange {
        /// The fix.
        fix: FixId,
        /// The file.
        path: ThemePath,
    },
    /// A fix's before does not equal the previous fix's after for the same file.
    #[error("fix {fix} does not start from the previous fix's result for {path}")]
    BrokenChain {
        /// The fix.
        fix: FixId,
        /// The file.
        path: ThemePath,
    },
    /// The summary is empty, longer than [`MAX_SUMMARY_CHARS`] after collapsing whitespace, or
    /// has characters a commit subject must not carry.
    #[error("fix {0} has an empty, overlong or unsafe summary")]
    Summary(FixId),
    /// The evidence link is not `https`, or carries credentials that the body would publish.
    #[error("fix {0} has an evidence link that is not https or carries credentials")]
    EvidenceUrl(FixId),
    /// The head branch was refused by the branch guard.
    #[error(transparent)]
    Branch(#[from] BranchRejection),
}

/// Whether `summary` is safe in a commit subject. The summary is Rampsmith's own wording for the
/// recipe (a static phrase such as "add accessible name to cart icon link"), but the check does
/// not rely on that: only letters, digits, spaces and `- _ . , ' ( ) / &` are allowed, so a
/// summary can never carry `[skip ci]`, `skip-checks: true`, a closing keyword with a `#`
/// reference, an `@` mention, a trailer, a link or Markdown (integration audit M2).
fn summary_is_safe(summary: &str) -> bool {
    summary.chars().all(|c| {
        c.is_alphanumeric()
            || matches!(
                c,
                ' ' | '-' | '_' | '.' | ',' | '\'' | '(' | ')' | '/' | '&'
            )
    })
}

/// The commit message for one fix: `fix(a11y): <summary> [WCAG <criterion>]` and the
/// `Rampsmith-Fix` trailer alone in the last paragraph, where Git reads trailers.
///
/// The message carries no finding text. A finding can quote storefront text an attacker
/// controls, and a commit message is read by Git hosts as instructions (`[skip ci]`, closing
/// keywords, `@` mentions), so untrusted text goes only into the pull request body, inside code
/// spans (integration audit M2). The summary is checked by [`summary_is_safe`].
pub fn commit_message(fix: &Fix) -> Result<String, PlanError> {
    let summary = one_line(&fix.summary);
    if summary.is_empty()
        || summary.chars().count() > MAX_SUMMARY_CHARS
        || !summary_is_safe(&summary)
    {
        return Err(PlanError::Summary(fix.id.clone()));
    }
    Ok(format!(
        "fix(a11y): {summary} [WCAG {}]\n\nRampsmith-Fix: {}\n",
        fix.criterion, fix.id
    ))
}

fn validate(batch: &Batch) -> Result<(), PlanError> {
    if batch.fixes.is_empty() {
        return Err(PlanError::EmptyBatch);
    }
    let mut ids = BTreeSet::new();
    let mut latest: HashMap<&ThemePath, &str> = HashMap::new();
    for fix in &batch.fixes {
        if !ids.insert(&fix.id) {
            return Err(PlanError::DuplicateFix(fix.id.clone()));
        }
        if fix.files.is_empty() {
            return Err(PlanError::EmptyFix(fix.id.clone()));
        }
        let url = &fix.evidence_url;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err(PlanError::EvidenceUrl(fix.id.clone()));
        }
        commit_message(fix)?;
        let mut seen = BTreeSet::new();
        for file in &fix.files {
            if !seen.insert(&file.path) {
                return Err(PlanError::DuplicatePath {
                    fix: fix.id.clone(),
                    path: file.path.clone(),
                });
            }
            if file.before == file.after {
                return Err(PlanError::NoChange {
                    fix: fix.id.clone(),
                    path: file.path.clone(),
                });
            }
            if latest
                .get(&file.path)
                .is_some_and(|prev| *prev != file.before)
            {
                return Err(PlanError::BrokenChain {
                    fix: fix.id.clone(),
                    path: file.path.clone(),
                });
            }
        }
        for file in &fix.files {
            latest.insert(&file.path, &file.after);
        }
    }
    Ok(())
}

/// Labels each fix with its group: fixes sharing a file share a label, the lowest index in
/// the group.
fn group_fixes(batch: &Batch) -> Vec<usize> {
    let mut label: Vec<usize> = Vec::with_capacity(batch.fixes.len());
    let mut first_fix: HashMap<&ThemePath, usize> = HashMap::new();
    for (index, fix) in batch.fixes.iter().enumerate() {
        let joined: BTreeSet<usize> = fix
            .files
            .iter()
            .filter_map(|f| first_fix.get(&f.path).and_then(|&j| label.get(j)).copied())
            .collect();
        let target = joined.first().copied().unwrap_or(index);
        for l in &mut label {
            if joined.contains(l) {
                *l = target;
            }
        }
        label.push(target);
        for file in &fix.files {
            first_fix.entry(&file.path).or_insert(index);
        }
    }
    label
}

struct Group {
    fixes: Vec<usize>,
    files: usize,
    lines: u32,
}

fn groups(batch: &Batch) -> Vec<Group> {
    // First `before` and last `after` per file across the batch: the net change.
    let mut net: BTreeMap<&ThemePath, (&str, &str)> = BTreeMap::new();
    for fix in &batch.fixes {
        for file in &fix.files {
            net.entry(&file.path)
                .and_modify(|e| e.1 = file.after.as_str())
                .or_insert((file.before.as_str(), file.after.as_str()));
        }
    }
    let mut by_label: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (index, label) in group_fixes(batch).into_iter().enumerate() {
        by_label.entry(label).or_default().push(index);
    }
    by_label
        .into_values()
        .map(|fixes| {
            let paths: BTreeSet<&ThemePath> = fixes
                .iter()
                .filter_map(|&i| batch.fixes.get(i))
                .flat_map(|f| f.files.iter().map(|p| &p.path))
                .collect();
            let lines = paths
                .iter()
                .filter_map(|p| net.get(p))
                .map(|(before, after)| changed_lines(before, after))
                .fold(0_u32, u32::saturating_add);
            Group {
                fixes,
                files: paths.len(),
                lines,
            }
        })
        .collect()
}

struct Bin {
    fixes: Vec<usize>,
    files: usize,
    lines: u32,
    over_cap: bool,
}

fn pack(groups: Vec<Group>, limits: PrLimits) -> Vec<Bin> {
    let mut bins: Vec<Bin> = Vec::new();
    for group in groups {
        if group.files > limits.max_files || group.lines > limits.max_changed_lines {
            bins.push(Bin {
                fixes: group.fixes,
                files: group.files,
                lines: group.lines,
                over_cap: true,
            });
            continue;
        }
        let fits = bins.iter_mut().find(|b| {
            !b.over_cap
                && b.files + group.files <= limits.max_files
                && b.lines.saturating_add(group.lines) <= limits.max_changed_lines
        });
        match fits {
            Some(bin) => {
                bin.fixes.extend(group.fixes);
                bin.files += group.files;
                bin.lines = bin.lines.saturating_add(group.lines);
            }
            None => bins.push(Bin {
                fixes: group.fixes,
                files: group.files,
                lines: group.lines,
                over_cap: false,
            }),
        }
    }
    for bin in &mut bins {
        bin.fixes.sort_unstable();
    }
    bins
}

/// Splits `batch` into pull requests against `connected_branch` (the branch Shopify syncs to
/// the live theme), applying `limits`.
pub fn plan_pull_requests(
    batch: &Batch,
    connected_branch: &str,
    limits: PrLimits,
) -> Result<Vec<PullRequestPlan>, PlanError> {
    validate(batch)?;
    let bins = pack(groups(batch), limits);
    let parts = bins.len();
    let mut plans = Vec::with_capacity(parts);
    for (index, bin) in bins.into_iter().enumerate() {
        let part = index + 1;
        let head =
            WritableBranch::for_batch(&batch.id, (parts > 1).then_some(part), connected_branch)?;
        let fixes: Vec<&Fix> = bin
            .fixes
            .iter()
            .filter_map(|&i| batch.fixes.get(i))
            .collect();
        let commits = fixes
            .iter()
            .map(|fix| {
                Ok(CommitPlan {
                    fix_id: fix.id.clone(),
                    message: commit_message(fix)?,
                    changes: fix
                        .files
                        .iter()
                        .map(|f| FileChange {
                            path: f.path.clone(),
                            mode: f.mode,
                            content: f.after.clone(),
                        })
                        .collect(),
                })
            })
            .collect::<Result<Vec<_>, PlanError>>()?;
        let title = title(fixes.len(), part, parts);
        let body = body(&batch.id, &fixes, part, parts, bin.over_cap, limits);
        plans.push(PullRequestPlan {
            head,
            part,
            parts,
            title,
            body,
            commits,
            files: bin.files,
            changed_lines: bin.lines,
            over_cap: bin.over_cap,
        });
    }
    Ok(plans)
}

fn title(fixes: usize, part: usize, parts: usize) -> String {
    let noun = if fixes == 1 { "fix" } else { "fixes" };
    let title = format!("fix(a11y): {fixes} accessibility {noun} from Rampsmith");
    if parts > 1 {
        format!("{title} (part {part} of {parts})")
    } else {
        title
    }
}

/// Appends formatted text. Writing to a `String` cannot fail.
fn push(out: &mut String, args: fmt::Arguments<'_>) {
    let _ = out.write_fmt(args);
}

fn body(
    batch: &BatchId,
    fixes: &[&Fix],
    part: usize,
    parts: usize,
    over_cap: bool,
    limits: PrLimits,
) -> String {
    let mut body = String::from(
        "Rampsmith prepared these changes to fix accessibility issues it found on your \
         storefront. Each fix is its own commit, so you can review them one at a time.\n\n",
    );
    if parts > 1 {
        push(
            &mut body,
            format_args!(
                "This is part {part} of {parts} of batch `{batch}`. The parts change different \
                 files, so they can be merged in any order.\n\n"
            ),
        );
    }
    if over_cap {
        push(
            &mut body,
            format_args!(
                "> This pull request is larger than the usual limit of {} files and {} changed \
                 lines because its fixes edit the same files and cannot be split without \
                 breaking one of them.\n\n",
                limits.max_files, limits.max_changed_lines
            ),
        );
    }
    body.push_str("## Fixes\n");
    for (n, fix) in fixes.iter().enumerate() {
        let changes: Vec<String> = fix
            .files
            .iter()
            .map(|f| {
                let lines = changed_lines(&f.before, &f.after);
                let unit = if lines == 1 { "line" } else { "lines" };
                format!("`{}` ({lines} changed {unit})", f.path)
            })
            .collect();
        push(
            &mut body,
            format_args!(
                "\n### {}. {}\n\n\
                 - **Finding:** {}\n\
                 - **WCAG 2.2 success criterion:** {}\n\
                 - **Change:** {}\n\
                 - **Evidence:** <{}> (sign-in required)\n\
                 - **Commit trailer:** `Rampsmith-Fix: {}`\n",
                n + 1,
                escape_text(&one_line(&fix.summary)),
                code_span(&truncate(&one_line(&fix.finding), MAX_FINDING_CHARS)),
                fix.criterion,
                changes.join(", "),
                fix.evidence_url,
                fix.id,
            ),
        );
    }
    body.push_str(
        "\n## How to undo\n\n\
         - Before merging: close this pull request. Nothing changes on the connected branch \
         or the live theme.\n\
         - After merging: open this pull request on GitHub and select **Revert**, then merge \
         the pull request GitHub creates. Shopify syncs the reverted files to the connected \
         theme.\n\
         - One fix only: run `git revert <commit>` on the commit whose `Rampsmith-Fix` \
         trailer names that fix, and merge the result through your usual review.\n\n\
         Automated checks find only part of all accessibility issues. The Rampsmith app \
         lists what they cannot detect.\n",
    );
    body
}

/// The name of the check run on every fix pull request (PLAN §15).
pub const CHECK_RUN_NAME: &str = "Rampsmith verification";

/// The result of verifying a fix branch on the preview theme (PLAN §12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verification {
    /// The preview scan no longer finds the fixed findings and found nothing new.
    Passed {
        /// Findings that no longer appear.
        resolved: u32,
    },
    /// Some fixed findings remain, or new issues appeared.
    Failed {
        /// Findings these fixes target that still appear.
        unresolved: u32,
        /// Issues found on the preview that the live theme does not have.
        new_issues: u32,
    },
    /// No unpublished theme is connected to `rampsmith/preview`, so nothing was scanned.
    NoPreviewTheme,
}

/// A check run conclusion GitHub accepts (checked on
/// <https://docs.github.com/en/rest/checks/runs> on 2026-10-17).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Conclusion {
    /// Verification passed.
    Success,
    /// Verification failed.
    Failure,
    /// Nothing to verify against.
    Neutral,
}

/// A check run's output panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CheckOutput {
    /// The title.
    pub title: String,
    /// The Markdown summary.
    pub summary: String,
}

/// The body of a create-a-check-run or update-a-check-run request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CheckRun {
    /// Always [`CHECK_RUN_NAME`].
    pub name: &'static str,
    /// The head commit of the fix branch.
    pub head_sha: Sha,
    /// Always `completed`: a check run is created once the result is known.
    pub status: &'static str,
    /// The result.
    pub conclusion: Conclusion,
    /// When verification finished, `YYYY-MM-DDTHH:MM:SSZ`.
    pub completed_at: String,
    /// The verification page inside the app.
    pub details_url: String,
    /// The batch id.
    pub external_id: String,
    /// The output panel.
    pub output: CheckOutput,
}

/// The "Rampsmith verification" check run for a fix branch.
pub fn verification_check_run(
    head_sha: Sha,
    batch: &BatchId,
    verification: Verification,
    details_url: &Url,
    completed_at: OffsetDateTime,
) -> Result<CheckRun, time::error::Format> {
    let (conclusion, title, summary) = match verification {
        Verification::Passed { resolved } => (
            Conclusion::Success,
            format!("{resolved} findings no longer appear on the preview theme"),
            format!(
                "Rampsmith scanned the unpublished theme connected to `rampsmith/preview` with \
                 these fixes applied. The {resolved} findings they target no longer appear, and \
                 the scan found no new issues. Automated checks find only part of all \
                 accessibility issues."
            ),
        ),
        Verification::Failed {
            unresolved,
            new_issues,
        } => (
            Conclusion::Failure,
            format!("{unresolved} findings remain and {new_issues} new issues appeared"),
            format!(
                "Rampsmith scanned the unpublished theme connected to `rampsmith/preview` with \
                 these fixes applied. {unresolved} of the findings they target still appear, \
                 and {new_issues} issues appeared that the live theme does not have. Open the \
                 details in Rampsmith before merging."
            ),
        ),
        Verification::NoPreviewTheme => (
            Conclusion::Neutral,
            "No preview theme is connected".to_owned(),
            "Nothing was scanned before merging. To verify fixes first, connect an unpublished \
             theme to the `rampsmith/preview` branch in Shopify. After you merge, Rampsmith \
             scans the live theme and reopens any finding that remains."
                .to_owned(),
        ),
    };
    let completed_at = completed_at
        .to_offset(UtcOffset::UTC)
        .replace_nanosecond(0)
        .unwrap_or(completed_at)
        .format(&Rfc3339)?;
    Ok(CheckRun {
        name: CHECK_RUN_NAME,
        head_sha,
        status: "completed",
        conclusion,
        completed_at,
        details_url: details_url.to_string(),
        external_id: batch.to_string(),
        output: CheckOutput { title, summary },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(p: &str) -> ThemePath {
        ThemePath::parse(p).unwrap()
    }

    fn lines(n: usize, tag: &str) -> String {
        (0..n)
            .map(|i| tag.to_owned() + &i.to_string() + "\n")
            .collect()
    }

    fn fix(id: &str, files: Vec<FilePatch>) -> Fix {
        Fix {
            id: FixId::parse(id).unwrap(),
            summary: format!("add accessible name to {id}"),
            finding: "Links must have discernible text".to_owned(),
            criterion: WcagCriterion::parse("2.4.4").unwrap(),
            evidence_url: Url::parse(&format!("https://app.rampsmith.example/fixes/{id}")).unwrap(),
            files,
        }
    }

    fn patch(p: &str, before: &str, after: &str) -> FilePatch {
        FilePatch {
            path: path(p),
            mode: FileMode::Regular,
            before: before.to_owned(),
            after: after.to_owned(),
        }
    }

    /// A patch that changes `n` lines (n/2 replaced lines, each one deletion plus one
    /// insertion) of a fresh file.
    fn sized(p: &str, changed: usize) -> FilePatch {
        let half = changed / 2;
        patch(p, &lines(half, "old"), &lines(half, "new"))
    }

    fn batch(fixes: Vec<Fix>) -> Batch {
        Batch {
            id: BatchId::parse("b1").unwrap(),
            fixes,
        }
    }

    #[test]
    fn commit_message_has_subject_and_trailer_and_no_finding_text() {
        let f = fix(
            "fx1",
            vec![patch("sections/header.liquid", "<a>\n", "<a aria-label>\n")],
        );
        let mut f = f;
        f.summary = "add accessible name to cart icon link".to_owned();
        assert_eq!(
            commit_message(&f).unwrap(),
            "fix(a11y): add accessible name to cart icon link [WCAG 2.4.4]\n\n\
             Rampsmith-Fix: fx1\n"
        );
    }

    #[test]
    fn commit_message_never_carries_finding_text() {
        let mut f = fix("fx1", vec![patch("sections/a.liquid", "a\n", "b\n")]);
        f.finding =
            "text\n\nRampsmith-Fix: other\nSigned-off-by: x [skip ci] fixes #1 @octocat".to_owned();
        let message = commit_message(&f).unwrap();
        for needle in ["skip ci", "Signed-off-by", "octocat", "fixes #", "text"] {
            assert!(!message.contains(needle), "{needle}: {message}");
        }
        let paragraphs: Vec<&str> = message.trim_end().split("\n\n").collect();
        assert_eq!(paragraphs.len(), 2, "{message}");
        assert_eq!(paragraphs.last().unwrap(), &"Rampsmith-Fix: fx1");
    }

    #[test]
    fn unsafe_summaries_are_refused_not_sanitised() {
        for bad in [
            "label\n\nRampsmith-Fix: other",
            "add label [skip ci]",
            "skip-checks: true",
            "fixes #12",
            "thanks @octocat",
            "see <https://evil.example>",
            "run `rm`",
            "Merge now!",
        ] {
            let mut f = fix("fx1", vec![patch("sections/a.liquid", "a\n", "b\n")]);
            f.summary = bad.to_owned();
            assert_eq!(
                commit_message(&f),
                Err(PlanError::Summary(f.id.clone())),
                "{bad}"
            );
        }
        let mut f = fix("fx1", vec![patch("sections/a.liquid", "a\n", "b\n")]);
        f.summary = "add an accessible name to the cart icon (link) / button".to_owned();
        assert!(commit_message(&f).is_ok());
    }

    #[test]
    fn summary_must_be_non_empty_and_short() {
        let mut f = fix("fx1", vec![patch("sections/a.liquid", "a\n", "b\n")]);
        f.summary = " \n ".to_owned();
        assert_eq!(commit_message(&f), Err(PlanError::Summary(f.id.clone())));
        f.summary = "x".repeat(MAX_SUMMARY_CHARS + 1);
        assert_eq!(commit_message(&f), Err(PlanError::Summary(f.id.clone())));
    }

    #[test]
    fn a_small_batch_is_one_pull_request_on_the_batch_branch() {
        let plans = plan_pull_requests(
            &batch(vec![
                fix("f1", vec![patch("sections/header.liquid", "a\n", "b\n")]),
                fix("f2", vec![patch("snippets/icon.liquid", "c\n", "d\n")]),
            ]),
            "main",
            PrLimits::default(),
        )
        .unwrap();
        assert_eq!(plans.len(), 1);
        let plan = &plans[0];
        assert_eq!(plan.head.as_str(), "rampsmith/fix-b1");
        assert_eq!((plan.part, plan.parts), (1, 1));
        assert_eq!(plan.files, 2);
        assert_eq!(plan.changed_lines, 4);
        assert!(!plan.over_cap);
        assert_eq!(
            plan.title,
            "fix(a11y): 2 accessibility fixes from Rampsmith"
        );
        let ids: Vec<&str> = plan.commits.iter().map(|c| c.fix_id.as_str()).collect();
        assert_eq!(ids, ["f1", "f2"]);
        assert_eq!(plan.commits[0].changes[0].content, "b\n");
    }

    #[test]
    fn batches_split_at_twenty_files() {
        let fixes: Vec<Fix> = (0..25)
            .map(|i| {
                fix(
                    &format!("f{i}"),
                    vec![patch(&format!("snippets/s{i}.liquid"), "a\n", "b\n")],
                )
            })
            .collect();
        let plans = plan_pull_requests(&batch(fixes), "main", PrLimits::default()).unwrap();
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].files, 20);
        assert_eq!(plans[1].files, 5);
        assert_eq!(plans[0].head.as_str(), "rampsmith/fix-b1-1");
        assert_eq!(plans[1].head.as_str(), "rampsmith/fix-b1-2");
        assert_eq!(
            plans[1].title,
            "fix(a11y): 5 accessibility fixes from Rampsmith (part 2 of 2)"
        );
        assert!(plans[0].body.contains("part 1 of 2 of batch `b1`"));
    }

    #[test]
    fn batches_split_at_four_hundred_changed_lines() {
        let fixes = vec![
            fix("f1", vec![sized("sections/a.liquid", 300)]),
            fix("f2", vec![sized("sections/b.liquid", 200)]),
            fix("f3", vec![sized("sections/c.liquid", 100)]),
        ];
        let plans = plan_pull_requests(&batch(fixes), "main", PrLimits::default()).unwrap();
        // First fit: f1 (300) + f3 (100) = 400 fills part 1; f2 (200) is part 2.
        assert_eq!(plans.len(), 2);
        let ids = |p: &PullRequestPlan| -> Vec<String> {
            p.commits.iter().map(|c| c.fix_id.to_string()).collect()
        };
        assert_eq!(ids(&plans[0]), ["f1", "f3"]);
        assert_eq!(plans[0].changed_lines, 400);
        assert_eq!(ids(&plans[1]), ["f2"]);
        assert!(
            plans
                .iter()
                .all(|p| p.changed_lines <= 400 && p.files <= 20)
        );
    }

    #[test]
    fn fixes_that_share_a_file_stay_together_in_order() {
        let fixes = vec![
            fix("f1", vec![patch("sections/a.liquid", "1\n", "2\n")]),
            fix("f2", vec![sized("sections/b.liquid", 398)]),
            fix(
                "f3",
                vec![
                    patch("sections/a.liquid", "2\n", "3\n"),
                    patch("sections/c.liquid", "x\n", "y\n"),
                ],
            ),
            fix("f4", vec![patch("sections/c.liquid", "y\n", "z\n")]),
        ];
        let plans = plan_pull_requests(&batch(fixes), "main", PrLimits::default()).unwrap();
        assert_eq!(plans.len(), 2);
        let ids: Vec<&str> = plans[0].commits.iter().map(|c| c.fix_id.as_str()).collect();
        assert_eq!(ids, ["f1", "f3", "f4"]);
        // Net change per file: a 1->3 (2 lines), c x->z (2 lines).
        assert_eq!(plans[0].changed_lines, 4);
        assert_eq!(plans[0].files, 2);
        assert_eq!(plans[1].commits[0].fix_id.as_str(), "f2");
    }

    #[test]
    fn an_indivisible_group_over_the_cap_gets_its_own_marked_pull_request() {
        let locales: Vec<FilePatch> = (0..25)
            .map(|i| patch(&format!("locales/l{i}.json"), "{}\n", "{\"a\":1}\n"))
            .collect();
        let fixes = vec![
            fix("small", vec![patch("sections/x.liquid", "a\n", "b\n")]),
            fix("labels", locales),
            fix("small2", vec![patch("sections/y.liquid", "a\n", "b\n")]),
        ];
        let plans = plan_pull_requests(&batch(fixes), "main", PrLimits::default()).unwrap();
        assert_eq!(plans.len(), 2);
        assert!(!plans[0].over_cap);
        assert_eq!(plans[0].commits.len(), 2);
        assert!(plans[1].over_cap);
        assert_eq!(plans[1].files, 25);
        assert!(
            plans[1]
                .body
                .contains("larger than the usual limit of 20 files")
        );
        assert!(!plans[0].body.contains("larger than the usual limit"));
    }

    #[test]
    fn planning_is_deterministic() {
        let make = || {
            batch(
                (0..30)
                    .map(|i| {
                        fix(
                            &format!("f{i}"),
                            vec![sized(&format!("snippets/s{i}.liquid"), 2 * (i % 7) + 2)],
                        )
                    })
                    .collect(),
            )
        };
        let a = plan_pull_requests(&make(), "main", PrLimits::default()).unwrap();
        let b = plan_pull_requests(&make(), "main", PrLimits::default()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn invalid_batches_are_rejected() {
        let limits = PrLimits::default();
        assert_eq!(
            plan_pull_requests(&batch(vec![]), "main", limits),
            Err(PlanError::EmptyBatch)
        );
        let empty = fix("f1", vec![]);
        assert_eq!(
            plan_pull_requests(&batch(vec![empty]), "main", limits),
            Err(PlanError::EmptyFix(FixId::parse("f1").unwrap()))
        );
        let p = || patch("sections/a.liquid", "a\n", "b\n");
        assert!(matches!(
            plan_pull_requests(
                &batch(vec![fix("f1", vec![p()]), fix("f1", vec![p()])]),
                "main",
                limits
            ),
            Err(PlanError::DuplicateFix(_))
        ));
        assert!(matches!(
            plan_pull_requests(&batch(vec![fix("f1", vec![p(), p()])]), "main", limits),
            Err(PlanError::DuplicatePath { .. })
        ));
        let noop = patch("sections/a.liquid", "a\n", "a\n");
        assert!(matches!(
            plan_pull_requests(&batch(vec![fix("f1", vec![noop])]), "main", limits),
            Err(PlanError::NoChange { .. })
        ));
        let broken = vec![
            fix("f1", vec![patch("sections/a.liquid", "a\n", "b\n")]),
            fix("f2", vec![patch("sections/a.liquid", "a\n", "c\n")]),
        ];
        assert!(matches!(
            plan_pull_requests(&batch(broken), "main", limits),
            Err(PlanError::BrokenChain { .. })
        ));
        let mut insecure = fix("f1", vec![p()]);
        insecure.evidence_url = Url::parse("http://app.rampsmith.example/x").unwrap();
        assert!(matches!(
            plan_pull_requests(&batch(vec![insecure]), "main", limits),
            Err(PlanError::EvidenceUrl(_))
        ));
        let mut with_credentials = fix("f1", vec![p()]);
        with_credentials.evidence_url =
            Url::parse("https://user:token@app.rampsmith.example/x").unwrap();
        assert!(matches!(
            plan_pull_requests(&batch(vec![with_credentials]), "main", limits),
            Err(PlanError::EvidenceUrl(_))
        ));
    }

    #[test]
    fn a_batch_branch_equal_to_the_connected_branch_is_refused() {
        let b = batch(vec![fix(
            "f1",
            vec![patch("sections/a.liquid", "a\n", "b\n")],
        )]);
        assert_eq!(
            plan_pull_requests(&b, "rampsmith/fix-b1", PrLimits::default()),
            Err(PlanError::Branch(BranchRejection::Connected))
        );
    }

    #[test]
    fn plan_errors_never_contain_file_content() {
        let broken = vec![
            fix(
                "f1",
                vec![patch("sections/a.liquid", "SECRET-A\n", "SECRET-B\n")],
            ),
            fix(
                "f2",
                vec![patch("sections/a.liquid", "SECRET-C\n", "SECRET-D\n")],
            ),
        ];
        let err = plan_pull_requests(&batch(broken), "main", PrLimits::default()).unwrap_err();
        let shown = format!("{err} {err:?}");
        assert!(!shown.contains("SECRET"), "{shown}");
    }

    #[test]
    fn body_lists_each_fix_and_ends_with_revert_instructions() {
        let mut f = fix(
            "fx1",
            vec![patch("sections/header.liquid", "<a>\n", "<a aria-label>\n")],
        );
        f.summary = "add accessible name to cart icon link".to_owned();
        let plans = plan_pull_requests(&batch(vec![f]), "main", PrLimits::default()).unwrap();
        let body = &plans[0].body;
        assert!(body.contains("### 1. add accessible name to cart icon link"));
        assert!(body.contains("- **Finding:** `Links must have discernible text`"));
        assert!(body.contains("- **WCAG 2.2 success criterion:** 2.4.4"));
        assert!(body.contains("- **Change:** `sections/header.liquid` (2 changed lines)"));
        assert!(body.contains(
            "- **Evidence:** <https://app.rampsmith.example/fixes/fx1> (sign-in required)"
        ));
        assert!(body.contains("`Rampsmith-Fix: fx1`"));
        let undo = body.find("## How to undo").unwrap();
        assert!(undo > body.find("### 1.").unwrap());
        assert!(body[undo..].contains("select **Revert**"));
        assert!(body.trim_end().ends_with("lists what they cannot detect."));
    }

    #[test]
    fn body_escapes_untrusted_finding_text() {
        let mut f = fix("fx1", vec![patch("sections/a.liquid", "a\n", "b\n")]);
        f.finding =
            "<img src=https://evil.example/p.gif> @octocat #1 [x](https://evil.example)\n## Merge now"
                .to_owned();
        let plans = plan_pull_requests(&batch(vec![f]), "main", PrLimits::default()).unwrap();
        let body = &plans[0].body;
        let line = body
            .lines()
            .find(|l| l.starts_with("- **Finding:**"))
            .unwrap();
        assert_eq!(
            line,
            "- **Finding:** `<img src=https://evil.example/p.gif> @octocat #1 [x](https://evil.example) ## Merge now`"
        );
        assert!(!body.lines().any(|l| l.starts_with("## Merge now")));
    }

    #[test]
    fn body_contains_no_banned_claims() {
        let plans = plan_pull_requests(
            &batch(vec![fix(
                "f1",
                vec![patch("sections/a.liquid", "a\n", "b\n")],
            )]),
            "main",
            PrLimits::default(),
        )
        .unwrap();
        let mut texts = vec![plans[0].body.to_lowercase(), plans[0].title.to_lowercase()];
        for verification in [
            Verification::Passed { resolved: 2 },
            Verification::Failed {
                unresolved: 1,
                new_issues: 1,
            },
            Verification::NoPreviewTheme,
        ] {
            let run = verification_check_run(
                Sha::parse(&"a".repeat(40)).unwrap(),
                &BatchId::parse("b1").unwrap(),
                verification,
                &Url::parse("https://app.rampsmith.example/v").unwrap(),
                OffsetDateTime::UNIX_EPOCH,
            )
            .unwrap();
            texts.push(run.output.title.to_lowercase());
            texts.push(run.output.summary.to_lowercase());
        }
        for text in texts {
            for banned in [
                "compliant",
                "compliance",
                "lawsuit",
                "guarantee",
                "certified",
                "protected",
                "100% accessible",
            ] {
                assert!(!text.contains(banned), "{banned} in {text}");
            }
        }
    }

    #[test]
    fn check_run_payloads_match_githubs_fields() {
        let sha = Sha::parse(&"b".repeat(40)).unwrap();
        let batch_id = BatchId::parse("b1").unwrap();
        let url = Url::parse("https://app.rampsmith.example/batches/b1").unwrap();
        let at = OffsetDateTime::from_unix_timestamp(1_792_000_000).unwrap()
            + time::Duration::milliseconds(250);
        let run =
            verification_check_run(sha, &batch_id, Verification::NoPreviewTheme, &url, at).unwrap();
        let json = serde_json::to_value(&run).unwrap();
        assert_eq!(json["name"], "Rampsmith verification");
        assert_eq!(json["head_sha"], "b".repeat(40));
        assert_eq!(json["status"], "completed");
        assert_eq!(json["conclusion"], "neutral");
        assert_eq!(json["completed_at"], "2026-10-14T17:46:40Z");
        assert_eq!(
            json["details_url"],
            "https://app.rampsmith.example/batches/b1"
        );
        assert_eq!(json["external_id"], "b1");
        assert_eq!(json["output"]["title"], "No preview theme is connected");
        let conclusion = |v| {
            verification_check_run(Sha::parse(&"b".repeat(40)).unwrap(), &batch_id, v, &url, at)
                .unwrap()
                .conclusion
        };
        assert_eq!(
            conclusion(Verification::Passed { resolved: 1 }),
            Conclusion::Success
        );
        assert_eq!(
            conclusion(Verification::Failed {
                unresolved: 1,
                new_issues: 0
            }),
            Conclusion::Failure
        );
    }
}
