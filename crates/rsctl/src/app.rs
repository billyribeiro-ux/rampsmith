//! The commands behind `rsctl`, with their I/O passed in so tests can drive them (ADR-151).
//!
//! Exit codes: 0 success, 1 a check failed or an operation was refused, 2 the command could
//! not run (bad input, no key ring, an unusable output file). Standard output carries only the
//! result: the doctor report, a key ring, or key ids. Notes and errors go to standard error,
//! and every line printed there passes through the [`Redactor`].

use std::fs::OpenOptions;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::Arc;

use time::OffsetDateTime;
use zeroize::Zeroizing;

use crate::cli::{Cli, Command, DoctorArgs, KeysCommand, RingSink, RingSource, ShopsCommand};
use crate::doctor::{self, Clock, Ctx, Endpoints, Options};
use crate::keys::{self, Updated};
use crate::secret::{Redactor, Secret};
use crate::vars::{EnvSource, ProcessEnv, Var, Vars};

/// Success.
pub const EXIT_OK: u8 = 0;
/// A check failed, or an operation was refused.
pub const EXIT_FAILED: u8 = 1;
/// The command could not run.
pub const EXIT_UNUSABLE: u8 = 2;

/// Standard streams.
#[allow(missing_debug_implementations)]
pub struct Io<'a> {
    /// Standard input.
    pub stdin: &'a mut dyn BufRead,
    /// Standard output.
    pub stdout: &'a mut dyn Write,
    /// Standard error.
    pub stderr: &'a mut dyn Write,
}

/// Where the process gets its environment, vendor endpoints and time.
#[allow(missing_debug_implementations)]
pub struct Runtime {
    /// Environment variables.
    pub env: Arc<dyn EnvSource>,
    /// Vendor API origins.
    pub endpoints: Endpoints,
    /// The clock.
    pub clock: Clock,
}

impl Runtime {
    /// The real environment, the real vendors and the system clock.
    #[must_use]
    pub fn process() -> Self {
        Self {
            env: Arc::new(ProcessEnv),
            endpoints: Endpoints::default(),
            clock: Arc::new(OffsetDateTime::now_utc),
        }
    }
}

/// Replaces the default panic message, which prints the panic's payload, with the place of
/// the panic only. A payload can quote data (a failed `unwrap` on a value, a slice of a
/// request), and in this program that data may be a secret.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let notice = panic_notice(info.location().map(|at| (at.file(), at.line())));
        // A closed standard error leaves nowhere to report to.
        let _ = writeln!(std::io::stderr(), "{notice}");
    }));
}

/// The line the panic hook prints: where, and that the details are withheld.
#[must_use]
pub fn panic_notice(place: Option<(&str, u32)>) -> String {
    let place = place.map_or_else(String::new, |(file, line)| format!(" at {file}:{line}"));
    format!(
        "rsctl: internal error{place}; the details are withheld because they could contain a secret"
    )
}

/// Runs a parsed command line and returns the exit code.
pub async fn run(cli: Cli, runtime: Runtime, io: &mut Io<'_>) -> u8 {
    match cli.command {
        Command::Doctor(args) => doctor_command(&args, runtime, io).await,
        Command::Keys { action } => keys_command(&action, &runtime, io),
        Command::Shops { action } => match action {
            ShopsCommand::Redact(args) => crate::shops::redact_command(&args, &runtime, io).await,
        },
    }
}

/// Writes one line to standard error after scrubbing it.
fn note(io: &mut Io<'_>, redactor: &Redactor, text: &str) {
    // A closed standard error leaves nowhere to report to.
    let _ = writeln!(io.stderr, "{}", redactor.scrub(text));
}

async fn doctor_command(args: &DoctorArgs, runtime: Runtime, io: &mut Io<'_>) -> u8 {
    let options = Options {
        target: args.environment,
        rows: args.rows.clone(),
        production_shopify_api_key: args.production_shopify_api_key.clone(),
        production_github_app_id: args.production_github_app_id.clone(),
        timeout: std::time::Duration::from_secs(args.timeout),
    };
    let ctx = match Ctx::new(runtime.env, runtime.endpoints, options, runtime.clock) {
        Ok(ctx) => Arc::new(ctx),
        Err(error) => {
            note(
                io,
                &Redactor::new(),
                &format!("rsctl: cannot start the HTTP client: {error}"),
            );
            return EXIT_UNUSABLE;
        }
    };
    let report = doctor::run(Arc::clone(&ctx)).await;
    let text = if args.json {
        report.render_json(&ctx.redactor, args.strict)
    } else {
        report.render_text(&ctx.redactor, args.strict)
    };
    if io.stdout.write_all(text.as_bytes()).is_err() || io.stdout.flush().is_err() {
        return EXIT_UNUSABLE;
    }
    report.exit_code(args.strict)
}

fn keys_command(action: &KeysCommand, runtime: &Runtime, io: &mut Io<'_>) -> u8 {
    let now = (runtime.clock)();
    match action {
        KeysCommand::Generate { id, sink } => {
            let redactor = Redactor::new();
            match keys::generate(now, id.as_deref()) {
                Ok(made) => finish(io, &redactor, &made, sink, |made| {
                    format!(
                        "rsctl: generated a key ring with key `{}`. It is printed once and kept nowhere else: store it as RAMPSMITH_MASTER_KEYS now.",
                        made.active
                    )
                }),
                Err(error) => refuse(io, &redactor, &error.to_string()),
            }
        }
        KeysCommand::Rotate { id, source, sink } => with_ring(
            runtime,
            io,
            source,
            |current, io, redactor| match keys::rotate(current, now, id.as_deref()) {
                Ok(updated) => finish(io, redactor, &updated, sink, |updated| {
                    format!(
                        "rsctl: new active key `{}`; older keys kept: {}. Set this ring as RAMPSMITH_MASTER_KEYS everywhere, re-wrap what the old keys sealed, then remove them with `rsctl keys drop`.",
                        updated.active,
                        list(&updated.kept)
                    )
                }),
                Err(error) => refuse(io, redactor, &error.to_string()),
            },
        ),
        KeysCommand::Drop { ids, source, sink } => with_ring(
            runtime,
            io,
            source,
            |current, io, redactor| match keys::drop_keys(current, ids) {
                Ok(updated) => finish(io, redactor, &updated, sink, |updated| {
                    format!(
                        "rsctl: removed {}; active key `{}`, older keys kept: {}. Drop a key only after nothing is still sealed under it.",
                        ids.join(", "),
                        updated.active,
                        list(&updated.kept)
                    )
                }),
                Err(error) => refuse(io, redactor, &error.to_string()),
            },
        ),
        KeysCommand::Ids { source } => {
            with_ring(
                runtime,
                io,
                source,
                |current, io, redactor| match keys::ids(current) {
                    Ok(ids) => {
                        let text = ids.iter().fold(String::new(), |mut out, id| {
                            out.push_str(id);
                            out.push('\n');
                            out
                        });
                        if io.stdout.write_all(text.as_bytes()).is_err() {
                            return EXIT_UNUSABLE;
                        }
                        EXIT_OK
                    }
                    Err(error) => refuse(io, redactor, &error.to_string()),
                },
            )
        }
    }
}

fn list(ids: &[String]) -> String {
    if ids.is_empty() {
        "none".to_owned()
    } else {
        ids.join(", ")
    }
}

fn refuse(io: &mut Io<'_>, redactor: &Redactor, reason: &str) -> u8 {
    note(io, redactor, &format!("rsctl: {reason}"));
    EXIT_FAILED
}

/// Reads the current ring (standard input or `RAMPSMITH_MASTER_KEYS`), registers it and every
/// key in it with a redactor for this command's messages, and hands it to `body`.
fn with_ring(
    runtime: &Runtime,
    io: &mut Io<'_>,
    source: &RingSource,
    body: impl FnOnce(&str, &mut Io<'_>, &Redactor) -> u8,
) -> u8 {
    let redactor = Redactor::new();
    let current = match read_ring(runtime, io, source) {
        Ok(current) => current,
        Err(reason) => return refuse_unusable(io, &redactor, reason),
    };
    redactor.register(&Secret::new(current.as_str()));
    for entry in current.split(',') {
        if let Some((_, key)) = entry.split_once(':') {
            redactor.register(&Secret::new(key.trim()));
        }
    }
    body(current.as_str(), io, &redactor)
}

fn refuse_unusable(io: &mut Io<'_>, redactor: &Redactor, reason: &str) -> u8 {
    note(io, redactor, &format!("rsctl: {reason}"));
    EXIT_UNUSABLE
}

fn read_ring(
    runtime: &Runtime,
    io: &mut Io<'_>,
    source: &RingSource,
) -> Result<Zeroizing<String>, &'static str> {
    if source.stdin {
        let mut line = Zeroizing::new(String::new());
        loop {
            line.clear();
            let read = io
                .stdin
                .read_line(&mut line)
                .map_err(|_| "could not read the key ring from standard input")?;
            if read == 0 {
                return Err("standard input held no key ring");
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                return Ok(Zeroizing::new(trimmed.to_owned()));
            }
        }
    }
    Vars::new(Arc::clone(&runtime.env))
        .get(Var::RampsmithMasterKeys)
        .map(Zeroizing::new)
        .ok_or("no current key ring: set RAMPSMITH_MASTER_KEYS, or pass --stdin and pipe it in")
}

/// Emits the ring where `sink` says, then the explanatory note on standard error.
fn finish(
    io: &mut Io<'_>,
    redactor: &Redactor,
    updated: &Updated,
    sink: &RingSink,
    message: impl FnOnce(&Updated) -> String,
) -> u8 {
    if let Some(path) = &sink.output {
        if let Err(reason) = write_new_file(path, updated.ring.expose()) {
            return refuse_unusable(io, redactor, &reason);
        }
        note(
            io,
            redactor,
            &format!("rsctl: wrote the ring to {}", path.display()),
        );
    } else {
        let wrote =
            writeln!(io.stdout, "{}", updated.ring.expose()).and_then(|()| io.stdout.flush());
        if wrote.is_err() {
            return EXIT_UNUSABLE;
        }
    }
    note(io, redactor, &message(updated));
    EXIT_OK
}

/// Creates `path`, which must not exist, readable by its owner only, holding `ring` and a
/// newline.
fn write_new_file(path: &Path, ring: &str) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::AlreadyExists => {
            format!(
                "{} already exists; rsctl never overwrites a key file",
                path.display()
            )
        }
        kind => format!("cannot create {}: {kind}", path.display()),
    })?;
    writeln!(file, "{ring}")
        .and_then(|()| file.flush())
        .map_err(|_| format!("cannot write {}", path.display()))
}
