mod analysis;
mod domain_facts;
mod error_contract;
mod state_evidence;

use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    protocol_version: u8,
    files: Vec<Source>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    path: String,
    source: String,
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--state-exposure-version") {
        println!(
            "{}",
            json!({"extractor": "0.0.0", "syn": "3.0.5", "protocol_version": 2})
        );
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--error-contract-version") {
        println!(
            "{}",
            json!({"extractor": "0.0.0", "syn": "3.0.5", "protocol_version": 3})
        );
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--domain-facts-version") {
        println!(
            "{}",
            json!({"extractor": "0.0.0", "syn": "3.0.5", "protocol_version": 7})
        );
        return Ok(());
    }
    let mut input = String::new();
    io::stdin()
        .take(8 * 1024 * 1024 + 1)
        .read_to_string(&mut input)?;
    if input.len() > 8 * 1024 * 1024 {
        return Err("input exceeds the spike's 8 MiB limit".into());
    }
    let value: serde_json::Value = serde_json::from_str(&input)?;
    if value.get("protocol_version").and_then(|v| v.as_u64()) == Some(2) {
        println!("{}", state_evidence::run(value)?);
        return Ok(());
    }
    if value.get("protocol_version").and_then(|v| v.as_u64()) == Some(3) {
        println!("{}", error_contract::run(value)?);
        return Ok(());
    }
    if value.get("protocol_version").and_then(|v| v.as_u64()) == Some(7) {
        println!("{}", domain_facts::run(value)?);
        return Ok(());
    }
    let input: Input = serde_json::from_value(value)?;
    if input.protocol_version != 1 || input.files.is_empty() {
        return Err("expected protocol_version 1 and at least one file".into());
    }
    let results: Vec<_> = input
        .files
        .iter()
        .map(|file| analysis::analyze(&file.path, &file.source))
        .collect();
    println!("{}", json!({"protocol_version": 1, "files": results}));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}
