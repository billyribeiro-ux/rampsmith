//! `ctl`: the Rust worker process (PLAN §6, §10).
//!
//! In R0 it runs the `shopify.token_refresh` queue ([`token_refresh`]) and, in the one
//! instance that holds leadership, the lease reaper and partition maintenance ([`leader`]).

pub mod config;
pub mod leader;
pub mod startup;
pub mod token_refresh;
