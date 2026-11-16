use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn platform() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("win32-x64"),
        ("windows", "aarch64") => Ok("win32-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        (os, arch) => bail!("No UAPKG executable is available for {os}/{arch}."),
    }
}

pub fn exact_version(text: &str) -> Result<semver::Version> {
    let version = semver::Version::parse(text)
        .with_context(|| format!("{text:?} is not an exact CLI version. Use a version such as 1.4.0; ranges and tags are not supported."))?;
    ensure!(
        version.to_string() == text,
        "Use the canonical exact version {}.",
        version
    );
    Ok(version)
}

/// Validate portable archive paths, including Windows hazards on Unix builders.
pub fn relative_path(value: &str) -> Result<PathBuf> {
    ensure!(
        !value.is_empty() && !value.contains('\\') && !value.contains('\0'),
        "Invalid artifact path {value:?}."
    );
    let path = Path::new(value);
    ensure!(
        !path.is_absolute(),
        "Artifact paths must be relative: {value:?}."
    );
    for component in path.components() {
        if let Component::Normal(name) = component {
            let name = name.to_str().context("Artifact paths must be UTF-8.")?;
            ensure!(
                !name.contains(':') && !name.ends_with(['.', ' ']),
                "Invalid artifact path component {name:?}."
            );
            let stem = name
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            ensure!(
                !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    && !(stem.len() == 4
                        && (stem.starts_with("COM") || stem.starts_with("LPT"))
                        && stem.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9'])),
                "Reserved artifact path {name:?}."
            );
        } else {
            bail!("Artifact paths cannot traverse directories: {value:?}.");
        }
    }
    Ok(path.to_path_buf())
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let content = fs::read(path).with_context(|| format!("Could not read {}.", path.display()))?;
    serde_json::from_slice(&content).with_context(|| format!("Invalid JSON in {}.", path.display()))
}

#[derive(Clone, Debug, Default)]
pub struct Settings {
    pub default_cli_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub schema_version: u32,
    pub install_method: String,
    #[serde(default)]
    pub default_cli_version: Option<String>,
    #[serde(default)]
    pub development: Option<Development>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Development {
    pub engine_path: PathBuf,
    pub node_path: PathBuf,
    pub checkout_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Engine {
    pub schema_version: u32,
    pub version: String,
    pub platform: String,
    pub kind: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
}

impl Engine {
    pub fn read(root: &Path, expected_version: &str, expected_platform: &str) -> Result<Self> {
        let engine: Self = read_json(&root.join("engine.json"))?;
        ensure!(
            engine.schema_version == 1,
            "Unsupported engine descriptor version {}.",
            engine.schema_version
        );
        ensure!(
            engine.version == expected_version && engine.platform == expected_platform,
            "The engine does not match CLI {expected_version} for {expected_platform}."
        );
        exact_version(&engine.version)?;
        ensure!(
            matches!(engine.kind.as_str(), "node" | "sea"),
            "Unsupported engine kind {}.",
            engine.kind
        );
        ensure!(
            root.join(relative_path(&engine.executable)?).is_file(),
            "Engine executable is missing: {}.",
            engine.executable
        );
        for arg in &engine.args {
            let path = root.join(relative_path(arg)?);
            ensure!(path.is_file(), "Engine entry file is missing: {arg}.");
        }
        ensure!(
            engine.kind == "sea" || engine.args.len() == 1,
            "Node engines require exactly one entry file."
        );
        ensure!(
            engine.kind != "sea" || engine.args.is_empty(),
            "SEA engines must not specify entry files."
        );
        Ok(engine)
    }
}
