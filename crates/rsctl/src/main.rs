//! The `rsctl` binary: argument parsing, a runtime, and the process exit code. Everything
//! else is in the library so the tests can drive it.

use std::io;
use std::process::ExitCode;

use clap::Parser as _;
use rsctl::app::{self, Io, Runtime};
use rsctl::cli::Cli;

fn main() -> anyhow::Result<ExitCode> {
    app::install_panic_hook();
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
