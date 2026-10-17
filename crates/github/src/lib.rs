//! The Rampsmith GitHub App (PLAN §15): App JWTs, installation tokens, webhook verification
//! and parsing, the theme and branch guards, the fix pull-request builder, and the REST calls
//! that push fix branches, open pull requests and report the verification check run.
//!
//! Security properties, each covered by named tests (ADR-121 to ADR-126):
//! - The App private key, App JWTs, installation tokens and webhook secrets are held in
//!   `secrecy` types or redacting wrappers: no `Display`, a placeholder `Debug`, no
//!   `Serialize`, and never in an error message, span or metric.
//! - Installation tokens live in memory only, cached per installation and scope and refreshed
//!   five minutes before `expires_at`.
//! - Webhook signatures are verified over the raw body in constant time before any parsing.
//! - Reads and writes are limited to Shopify theme directories by [`ThemePath`]; symlinks are
//!   never read; writes go only to `rampsmith/` branches that are not the connected branch, and
//!   a ref is forced only for a re-derive.
//! - The client pins the REST API version, never follows redirects, refuses plain `http`
//!   outside loopback, bounds response sizes, and maps 401, 403, 404, 409, 422 and rate limits
//!   to typed errors.
//! - Untrusted finding text reaches commits and pull-request bodies only through escaping
//!   that blocks trailer injection, HTML, links, mentions and references.

mod app;
mod client;
mod clock;
mod diff;
mod error;
mod guard;
mod markdown;
mod pr;
mod repo;
mod token;
mod types;
mod webhook;

pub use app::{
    AppCredentials, AppIssuer, AppJwt, AppPrivateKey, JWT_BACKDATE, JWT_EXPIRES_IN, KeyError,
};
pub use client::{ACCEPT_JSON, ACCEPT_RAW, API_VERSION, AppInfo, ClientConfig, GitHub};
pub use clock::{Clock, SystemClock};
pub use diff::changed_lines;
pub use error::{DecodeError, GitHubError, RateLimitKind, TransportKind};
pub use guard::{
    BRANCH_PREFIX, BranchName, BranchRejection, MAX_BRANCH_BYTES, MAX_PATH_BYTES, PathRejection,
    RefUpdate, StructureError, TEMPLATE_SUBDIRECTORIES, THEME_DIRECTORIES, ThemePath,
    ThemeRequirement, WritableBranch, check_theme_structure,
};
pub use pr::{
    Batch, CHECK_RUN_NAME, CheckOutput, CheckRun, CommitPlan, Conclusion, FileChange, FileMode,
    FilePatch, Fix, MAX_FINDING_CHARS, MAX_SUMMARY_CHARS, PlanError, PrLimits, PullRequestPlan,
    Verification, commit_message, plan_pull_requests, verification_check_run,
};
pub use repo::{PullRequest, Repository, RepositoryTree, ThemeFile, TreeEntry};
pub use token::{
    Access, InstallationToken, MAX_TOKEN_REPOSITORIES, Permission, TOKEN_REFRESH_SKEW, TokenScope,
};
pub use types::{
    BatchId, CheckRunId, FixId, IdError, InstallationId, RepoRef, RepositoryId, Sha, WcagCriterion,
};
pub use webhook::{
    Account, DELIVERY_HEADER, Delivery, DeliveryId, EVENT_HEADER, Event, GitRefInfo, Installation,
    InstallationAction, InstallationEvent, InstallationRef, InstallationRepositoriesAction,
    InstallationRepositoriesEvent, MAX_WEBHOOK_BYTES, PullRequestAction, PullRequestEvent,
    PullRequestInfo, PushCommit, PushEvent, RepositoryInfo, RepositorySelection, RepositorySummary,
    SIGNATURE_HEADER, WebhookError, WebhookVerifier,
};
