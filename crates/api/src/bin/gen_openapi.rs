//! Writes the api's OpenAPI document to the file given as the only argument (ADR-009).

use std::error::Error;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn Error>> {
    let out: PathBuf = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: gen-openapi <output-file>")?;
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut json = api::openapi().to_pretty_json()?;
    json.push('\n');
    std::fs::write(out, json)?;
    Ok(())
}
