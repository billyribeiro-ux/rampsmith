//! Tenant-scoped repositories. Every function takes `&mut TenantTx` and filters by its
//! tenant in SQL, on top of row-level security (ADR-006). The isolation suite in
//! `tests/tenancy.rs` calls each one across the tenant boundary. The one exception is
//! [`identity`], whose rows belong to people rather than tenants (ADR-024).

pub mod app_views;
pub mod audit;
pub mod data_fixes;
pub mod findings;
pub mod fixes;
pub mod identity;
pub mod jobs;
pub mod occurrences;
pub mod redact;
pub mod scan_inputs;
pub mod scans;
pub mod shop_billing;
pub mod shopify;
pub mod sites;
pub mod tenants;
pub mod webhooks;
