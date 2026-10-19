//! The `rsctl` binary: argument parsing, a runtime, and the process exit code. Everything
//! else is in the library so the tests can drive it.

use std::io::{self, Write as _};
use std::process::ExitCode;

use clap::Parser as _;
use rsctl::app::{self, Io, Runtime};
use rsctl::cli::Cli;

fn main() -> anyhow::Result<ExitCode> {
    install_panic_hook();
    let cli = Cli::parse();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();
    let code = runtime.block_on(app::run(
        cli,
        Runtime::process(),
        &mut Io {
            stdin: &mut stdin,
            stdout: &mut stdout,
            stderr: &mut stderr,
        },
    ));
    Ok(ExitCode::from(code))
}

/// A panic message can quote data. Print where it happened and nothing else.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let place = info
            .location()
            .map_or_else(String::new, |at| format!(" at {}:{}", at.file(), at.line()));
        let _ = writeln!(
            io::stderr(),
            "rsctl: internal error{place}; the details are withheld because they could contain a secret"
        );
    }));
}
