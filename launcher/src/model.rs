use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const REPOSITORY: &str = "uapkg/uapkg";

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

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    #[serde(rename = "github-releases")]
    Github,
    Npm,
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Self::Github => "github-releases",
            Self::Npm => "npm",
        }
    }
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "github-releases" => Ok(Self::Github),
            "npm" => Ok(Self::Npm),
            _ => bail!("cliSource must be github-releases or npm."),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Settings {
    pub cli_source: Source,
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
    pub bundled_engine: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm_range: Option<String>,
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
            matches!(engine.kind.as_str(), "node" | "sea" | "npm"),
            "Unsupported engine kind {}.",
            engine.kind
        );
        if engine.kind == "npm" {
            ensure!(engine.executable == "node", "npm engines must use Node.js.");
        } else {
            ensure!(
                root.join(relative_path(&engine.executable)?).is_file(),
                "Engine executable is missing: {}.",
                engine.executable
            );
        }
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub schema_version: u32,
    pub cli_version: String,
    pub launcher_version: String,
    pub artifacts: Vec<Artifact>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub kind: String,
    pub platform: String,
    pub file_name: String,
    pub sha256: String,
    pub size: u64,
}

impl Release {
    pub fn validate(&self, version: &str) -> Result<()> {
        ensure!(
            self.schema_version == 1 && self.cli_version == version,
            "Release metadata does not match requested CLI {version}."
        );
        exact_version(&self.cli_version)?;
        exact_version(&self.launcher_version)?;
        for artifact in &self.artifacts {
            ensure!(
                relative_path(&artifact.file_name)?.components().count() == 1,
                "Release asset names must not contain directories."
            );
            ensure!(
                artifact.sha256.len() == 64
                    && artifact.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
                "Invalid release checksum."
            );
            ensure!(
                artifact.size > 0 && artifact.size <= 2 * 1024 * 1024 * 1024,
                "Invalid release asset size."
            );
        }
        Ok(())
    }

    pub fn artifact(&self, kind: &str, target: &str) -> Result<&Artifact> {
        let matches: Vec<_> = self
            .artifacts
            .iter()
            .filter(|a| a.kind == kind && a.platform == target)
            .collect();
        ensure!(
            matches.len() == 1,
            "Release {} must contain exactly one {kind} artifact for {target}.",
            self.cli_version
        );
        Ok(matches[0])
    }
}
