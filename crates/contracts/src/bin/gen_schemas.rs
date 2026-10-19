//! Writes every contract's JSON Schema to the directory given as the only argument.
//!
//! Output is deterministic (sorted keys from `serde_json`, trailing newline), so CI can
//! regenerate into a temporary directory and diff against the committed files.

use std::error::Error;
use std::path::PathBuf;
use std::{env, fs};

fn main() -> Result<(), Box<dyn Error>> {
    let out: PathBuf = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: gen-schemas <output-directory>")?;
    fs::create_dir_all(&out)?;
    for named in contracts::schemas() {
        let mut json = serde_json::to_string_pretty(&named.schema)?;
        json.push('\n');
        fs::write(out.join(format!("{}.schema.json", named.name)), json)?;
    }
    Ok(())
}
