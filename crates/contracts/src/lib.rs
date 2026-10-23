//! Contracts between Rampsmith's Rust services, the `SvelteKit` web app and the TypeScript
//! engine (ADR-009).
//!
//! Every type here derives [`schemars::JsonSchema`]. `gen-schemas` writes those schemas to
//! `packages/contracts-ts/schemas/`, TypeScript types are generated from them, and CI
//! regenerates both and fails on any difference. Nothing in this crate is hand-mirrored.

pub mod email;
pub mod job;
pub mod pipeline;
pub mod problem;
mod registry;

pub use email::{EmailRecipient, EmailSend, EmailTemplate, UninstallExportInput};
pub use job::{JobError, ScanPage, ShopifyTokenRefresh};
pub use pipeline::{
    AiAltText, AuditData, PageState, PageType, ScanFinalize, ScanPageV2, ScanPlan,
    ShopifyApplyDataFix, ShopifyReadStore, ShopifyRevertDataFix, VerifyScan, Viewport,
    WebhookProcess,
};
pub use problem::{FieldError, Problem, ProblemCode};
pub use registry::{NamedSchema, schemas};
