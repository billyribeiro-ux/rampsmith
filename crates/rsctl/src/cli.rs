//! The command line (ADR-151).

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

use crate::report::Target;

/// Rampsmith's operator CLI.
#[derive(Debug, Parser)]
#[command(name = "rsctl", version, about, disable_help_subcommand = true)]
pub struct Cli {
    /// What to do.
    #[command(subcommand)]
    pub command: Command,
}

/// The commands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Check every founder input (LAUNCH.md section C) against its live service.
    ///
    /// Reads the documented environment variables only. Prints one line per input: PASS, FAIL
    /// with the reason, or SKIP naming the row whose input is missing. Never prints a secret.
    /// Exits 1 when any input that is present fails.
    Doctor(DoctorArgs),
    /// Generate, rotate and inspect master keys (`RAMPSMITH_MASTER_KEYS`, ADR-021).
    Keys {
        /// The key operation.
        #[command(subcommand)]
        action: KeysCommand,
    },
}

/// Options for `rsctl doctor`.
#[derive(Debug, Args)]
pub struct DoctorArgs {
    /// Which environment's inputs are being checked. Staging adds the C row 15 check.
    #[arg(long, short = 'e', value_enum, default_value = "production")]
    pub environment: Target,
    /// Check only this LAUNCH.md section C row (repeat for several).
    #[arg(long = "row", value_name = "N", value_parser = clap::value_parser!(u8).range(1..=15))]
    pub rows: Vec<u8>,
    /// Print one JSON document instead of text.
    #[arg(long)]
    pub json: bool,
    /// Also fail when a required input is missing (the default is to SKIP it).
    #[arg(long)]
    pub strict: bool,
    /// Seconds to wait for each request.
    #[arg(long, value_name = "SECONDS", default_value_t = 15, value_parser = clap::value_parser!(u64).range(1..=120))]
    pub timeout: u64,
    /// For `--environment staging`: the production app's public client id (`SHOPIFY_API_KEY`),
    /// so row 15 can prove staging uses its own app.
    #[arg(long, value_name = "ID")]
    pub production_shopify_api_key: Option<String>,
    /// For `--environment staging`: the production GitHub App id (`GITHUB_APP_ID`).
    #[arg(long, value_name = "ID")]
    pub production_github_app_id: Option<String>,
}

/// Where the current key ring comes from.
#[derive(Debug, Args)]
pub struct RingSource {
    /// Read the current ring from standard input (first line) instead of
    /// `RAMPSMITH_MASTER_KEYS`.
    #[arg(long)]
    pub stdin: bool,
}

/// Where the resulting ring goes.
#[derive(Debug, Args)]
pub struct RingSink {
    /// Write the ring to this new file (mode 0600, never overwritten) instead of standard
    /// output.
    #[arg(long, value_name = "FILE")]
    pub output: Option<PathBuf>,
}

/// The `rsctl keys` operations.
#[derive(Debug, Subcommand)]
pub enum KeysCommand {
    /// Print a new key ring with one fresh random key, once, to standard output.
    Generate {
        /// The key's id (1 to 32 of a-z, 0-9, `-`, `_`). Default: `k` and today's UTC date.
        #[arg(long)]
        id: Option<String>,
        /// Where the ring goes.
        #[command(flatten)]
        sink: RingSink,
    },
    /// Print the current ring with a fresh key in front. Old keys stay, so values sealed under
    /// them still open until they are re-wrapped and dropped.
    Rotate {
        /// The new key's id. Default: `k` and today's UTC date (`-2`, `-3`, ... on a clash).
        #[arg(long)]
        id: Option<String>,
        /// Where the current ring comes from.
        #[command(flatten)]
        source: RingSource,
        /// Where the new ring goes.
        #[command(flatten)]
        sink: RingSink,
    },
    /// Print the current ring without the named old keys. Only after every value they wrapped
    /// has been re-wrapped under the active key.
    Drop {
        /// An old key id to remove (repeat for several).
        #[arg(long = "id", value_name = "ID", required = true)]
        ids: Vec<String>,
        /// Where the current ring comes from.
        #[command(flatten)]
        source: RingSource,
        /// Where the new ring goes.
        #[command(flatten)]
        sink: RingSink,
    },
    /// List the key ids in the current ring, newest first. Ids are not secret.
    Ids {
        /// Where the current ring comes from.
        #[command(flatten)]
        source: RingSource,
    },
}
