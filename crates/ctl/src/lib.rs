//! `ctl`: the Rust worker process (PLAN §6, §10).
//!
//! In R0 it runs the `shopify.token_refresh` queue ([`token_refresh`]) and, in the one
//! instance that holds leadership, the lease reaper and partition maintenance ([`leader`]).
//! [`rewrap`] re-wraps stored secrets when the master key rotates; the operator command that
//! runs it lives in `rsctl`.

pub mod config;
pub mod leader;
pub mod rewrap;
pub mod startup;
pub mod token_refresh;
