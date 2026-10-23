//! Contracts between Rampsmith's Rust services, the `SvelteKit` web app and the TypeScript
//! engine (ADR-009).
//!
//! Every type here derives [`schemars::JsonSchema`]. `gen-schemas` writes those schemas to
//! `packages/contracts-ts/schemas/`, TypeScript types are generated from them, and CI
//! regenerates both and fails on any difference. Nothing in this crate is hand-mirrored.

pub mod email;
pub mod free_scan;
pub mod github;
pub mod job;
pub mod pipeline;
pub mod problem;
mod registry;

pub use email::{EmailRecipient, EmailSend, EmailTemplate, UninstallExportInput};
pub use free_scan::{
    FreeScanExample, FreeScanFailure, FreeScanResult, FreeScanRun, MAX_EXAMPLES,
    MAX_FAILURE_GROUPS, MAX_PAGES, MAX_SNIPPET_CHARS,
};
pub use github::{
    CodeFixPatch, GithubCheckRepository, GithubOpenPullRequest, GithubPlanBatch,
    GithubProcessEvent, GithubSyncInstallation, GithubSyncPullRequest,
};
pub use job::{JobError, ShopifyTokenRefresh};
pub use pipeline::{
    AiAltText, AuditData, PageState, PageType, ScanFinalize, ScanPageV2, ScanPlan,
    ShopifyApplyDataFix, ShopifyReadStore, ShopifyRevertDataFix, VerifyScan, Viewport,
    WebhookProcess,
};
pub use problem::{FieldError, Problem, ProblemCode};
pub use registry::{NamedSchema, schemas};
