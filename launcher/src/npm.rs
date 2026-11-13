use crate::{
    archive, github,
    model::{Engine, read_json},
    storage::atomic_json,
};
use anyhow::{Context, Result, bail, ensure};
use base64::Engine as _;
use reqwest::{Url, blocking::Client};
use serde::Deserialize;
use sha2::{Digest, Sha512};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

const NODE_MINIMUM: &str = ">=26.0.0";
const NPM_MINIMUM: &str = ">=11.12.1";

pub struct Runtime {
    pub node: PathBuf,
    pub npm: PathBuf,
}

fn executable_on_path(name: &str) -> Result<PathBuf> {
    let paths = std::env::var_os("PATH").context("PATH is missing.")?;
    for directory in std::env::split_paths(&paths) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Ok(candidate.canonicalize()?);
        }
    }
    bail!(
        "The npm CLI source requires {name} on PATH. Install Node.js 26+ and npm 11.12.1+, or set launcher.cliSource to github-releases in your global UAPKG config.json for a standalone runtime."
    )
}

pub fn satisfies(version: &str, requirement: &str) -> Result<bool> {
    let version: node_semver::Version = version
        .trim()
        .trim_start_matches('v')
        .parse()
        .with_context(|| format!("Invalid runtime version {version:?}."))?;
    let range: node_semver::Range = requirement
        .parse()
        .with_context(|| format!("Invalid package engine range {requirement:?}."))?;
    Ok(version.satisfies(&range))
}

fn version(command: &mut Command) -> Result<String> {
    let output = command
        .arg("--version")
        .output()
        .context("Could not inspect the npm source runtime.")?;
    ensure!(
        output.status.success(),
        "Could not inspect the npm source runtime."
    );
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

pub fn node_runtime(node_range: Option<&str>) -> Result<PathBuf> {
    let node = executable_on_path(if cfg!(windows) { "node.exe" } else { "node" })?;
    let node_version = version(&mut Command::new(&node))?;
    for range in [Some(NODE_MINIMUM), node_range].into_iter().flatten() {
        ensure!(
            satisfies(&node_version, range)?,
            "Node.js {node_version} does not satisfy {range}. Install a compatible runtime, or use cliSource github-releases."
        );
    }
    Ok(node)
}

pub fn runtime(node_range: Option<&str>, npm_range: Option<&str>) -> Result<Runtime> {
    let node = node_runtime(node_range)?;
    let npm_shim = executable_on_path(if cfg!(windows) { "npm.cmd" } else { "npm" })?;
    let npm = if npm_shim
        .extension()
        .is_some_and(|extension| extension == "js")
    {
        npm_shim
    } else {
        let parent = npm_shim
            .parent()
            .context("npm has no installation directory.")?;
        [parent.join("node_modules/npm/bin/npm-cli.js"), parent.join("../lib/node_modules/npm/bin/npm-cli.js")]
            .into_iter().find(|path| path.is_file()).context("Could not locate npm-cli.js beside npm. Install a standard Node.js/npm distribution, or use cliSource github-releases.")?.canonicalize()?
    };
    let npm_version = version(Command::new(&node).arg(&npm))?;
    for range in [Some(NPM_MINIMUM), npm_range].into_iter().flatten() {
        ensure!(
            satisfies(&npm_version, range)?,
            "npm {npm_version} does not satisfy {range}. Install a compatible npm, or use cliSource github-releases."
        );
    }
    Ok(Runtime { node, npm })
}

#[derive(Deserialize)]
struct Metadata {
    name: String,
    version: String,
    dist: Distribution,
}
#[derive(Deserialize)]
struct Distribution {
    tarball: String,
    integrity: String,
}

pub fn verify_integrity(path: &Path, integrity: &str) -> Result<()> {
    let expected: Vec<_> = integrity
        .split_whitespace()
        .filter_map(|item| item.strip_prefix("sha512-"))
        .collect();
    ensure!(
        !expected.is_empty(),
        "npm package metadata must provide SHA-512 integrity."
    );
    let mut input = fs::File::open(path)?;
    let mut hash = Sha512::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    let actual = base64::engine::general_purpose::STANDARD.encode(hash.finalize());
    ensure!(
        expected.contains(&actual.as_str()),
        "npm package integrity verification failed. Nothing was installed."
    );
    Ok(())
}

pub fn install(client: &Client, version: &str, platform: &str, stage: &Path) -> Result<PathBuf> {
    let metadata: Metadata = serde_json::from_slice(&github::metadata(
        client,
        Url::parse(&format!(
            "https://registry.npmjs.org/@uapkg%2fcli/{version}"
        ))?,
    )?)?;
    ensure!(
        metadata.name == "@uapkg/cli" && metadata.version == version,
        "npm metadata does not match @uapkg/cli@{version}."
    );
    let archive_path = stage.join("package.tgz");
    github::download(
        client,
        Url::parse(&metadata.dist.tarball)?,
        &archive_path,
        512 * 1024 * 1024,
    )?;
    verify_integrity(&archive_path, &metadata.dist.integrity)?;
    let unpacked = stage.join("unpacked");
    archive::extract(&archive_path, &unpacked)?;
    let root = unpacked.join("package");
    let package: serde_json::Value = read_json(&root.join("package.json"))?;
    ensure!(
        package["name"] == "@uapkg/cli" && package["version"] == version,
        "npm archive does not match @uapkg/cli@{version}."
    );
    let release_lock = root.join("dist/runtime-lock.json");
    ensure!(
        release_lock.is_file(),
        "CLI {version} does not include dist/runtime-lock.json and cannot be installed reproducibly by the launcher. Choose a launcher-enabled release."
    );
    let runtime_lock: serde_json::Value = read_json(&release_lock)?;
    ensure!(
        runtime_lock["lockfileVersion"].as_u64() == Some(3),
        "CLI {version} requires an npm v3 runtime lock."
    );
    ensure!(
        runtime_lock["packages"][""]["name"] == "@uapkg/cli"
            && runtime_lock["packages"][""]["version"] == version,
        "The runtime lock does not match the CLI package."
    );
    let lock_path = root.join("package-lock.json");
    fs::copy(&release_lock, &lock_path)?;
    let node_range = package["engines"]["node"].as_str().map(str::to_owned);
    let npm_range = package["engines"]["npm"].as_str().map(str::to_owned);
    let runtime = runtime(node_range.as_deref(), npm_range.as_deref())?;
    let lock_before = fs::read(&lock_path)?;
    let output = Command::new(&runtime.node)
        .arg(&runtime.npm)
        .args([
            "ci",
            "--ignore-scripts",
            "--no-bin-links",
            "--omit=dev",
            "--include=optional",
            "--no-audit",
            "--no-fund",
            "--engine-strict",
            "--loglevel=error",
            "--registry=https://registry.npmjs.org",
        ])
        .current_dir(&root)
        .env("NPM_CONFIG_IGNORE_SCRIPTS", "true")
        .output()
        .context("Could not install the pinned npm dependency graph.")?;
    ensure!(
        output.status.success(),
        "npm could not install CLI {version}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    ensure!(
        fs::read(&lock_path)? == lock_before,
        "npm changed the release runtime lock. Nothing was installed."
    );
    let engine = Engine {
        schema_version: 1,
        version: version.to_owned(),
        platform: platform.to_owned(),
        kind: "npm".to_owned(),
        executable: "node".to_owned(),
        args: vec!["dist/cli.js".to_owned()],
        node_range,
        npm_range,
    };
    atomic_json(&root.join("engine.json"), &engine)?;
    Engine::read(&root, version, platform)?;
    Ok(root)
}

pub fn latest_version(client: &Client) -> Result<String> {
    let metadata: Metadata = serde_json::from_slice(&github::metadata(
        client,
        Url::parse("https://registry.npmjs.org/@uapkg%2fcli/latest")?,
    )?)?;
    ensure!(
        metadata.name == "@uapkg/cli",
        "npm latest metadata does not match @uapkg/cli."
    );
    let version = crate::model::exact_version(&metadata.version)?;
    ensure!(
        version.pre.is_empty(),
        "The npm latest tag points to a prerelease. Select an exact CLI version instead."
    );
    Ok(metadata.version)
}
