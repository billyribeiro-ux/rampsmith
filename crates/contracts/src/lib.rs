//! Contracts between Rampsmith's Rust services, the `SvelteKit` web app and the TypeScript
//! engine (ADR-009).
//!
//! Every type here derives [`schemars::JsonSchema`]. `gen-schemas` writes those schemas to
//! `packages/contracts-ts/schemas/`, TypeScript types are generated from them, and CI
//! regenerates both and fails on any difference. Nothing in this crate is hand-mirrored.

pub mod job;
pub mod problem;
mod registry;

pub use job::{JobError, ShopifyTokenRefresh};
pub use problem::{FieldError, Problem, ProblemCode};
pub use registry::{NamedSchema, schemas};
