use crate::storage::ExtraFields;
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn platform() -> Result<&'static str> {
    let target_env = if cfg!(target_env = "musl") {
        "musl"
    } else if cfg!(target_env = "gnu") {
        "gnu"
    } else {
        ""
    };
    distribution_platform(std::env::consts::OS, std::env::consts::ARCH, target_env)
}

fn distribution_platform(os: &str, arch: &str, target_env: &str) -> Result<&'static str> {
    match (os, arch, target_env) {
        ("windows", "x86_64", _) => Ok("win-x64"),
        ("windows", "aarch64", _) => Ok("win-arm64"),
        ("macos", "x86_64", _) => Ok("darwin-x64"),
        ("macos", "aarch64", _) => Ok("darwin-arm64"),
        ("linux", "x86_64", "gnu") => Ok("linux-x64"),
        ("linux", "aarch64", "gnu") => Ok("linux-arm64"),
        ("linux", "x86_64", "musl") => Ok("linux-x64-musl"),
        ("linux", _, _) => {
            bail!("No UAPKG executable is available for {os}/{arch} with libc {target_env:?}.")
        }
        _ => bail!("No UAPKG executable is available for {os}/{arch}."),
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

#[derive(Clone, Debug)]
pub struct Settings {
    pub default_cli_version: Option<String>,
    pub auto_launcher_update: bool,
    pub auto_cli_update: bool,
    pub minimum_release_age: crate::release_age::MinimumReleaseAge,
    pub global_cli_version: Option<String>,
    pub config_source: uapkg_slim_config::Source,
    pub config_file: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub schema_version: u32,
    pub install_method: String,
    #[serde(default)]
    pub default_cli_version: Option<String>,
    #[serde(default)]
    pub development: Option<Development>,
    #[serde(flatten, default)]
    pub extra_fields: ExtraFields,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Development {
    pub engine_path: PathBuf,
    pub node_path: PathBuf,
    pub checkout_path: PathBuf,
    #[serde(flatten, default)]
    pub extra_fields: ExtraFields,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Engine {
    pub schema_version: u32,
    pub version: String,
    pub platform: String,
    pub kind: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(flatten, default)]
    pub extra_fields: ExtraFields,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn roundtrip_record<T: DeserializeOwned + Serialize>(mut value: Value, required: &[&str]) {
        let extras = json!({
            "futureObject": {"nested": [1, {"enabled": true}, null]},
            "futureArray": ["value", false, {"other": 2}],
            "futureNull": null
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extras.as_object().unwrap().clone());
        let parsed: T = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        for field in required {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(*field);
            assert!(
                serde_json::from_value::<T>(missing).is_err(),
                "Missing {field} must fail"
            );
            let mut malformed = value.clone();
            malformed[*field] = json!(false);
            assert!(
                serde_json::from_value::<T>(malformed).is_err(),
                "Wrong type for {field} must fail"
            );
        }
    }

    #[test]
    fn installation_records_roundtrip_unknown_fields_and_reject_invalid_known_shapes() {
        roundtrip_record::<Receipt>(
            json!({
                "schemaVersion": 1, "installMethod": "standalone", "defaultCliVersion": null, "development": null
            }),
            &["schemaVersion", "installMethod"],
        );
        roundtrip_record::<Development>(
            json!({
                "enginePath": "engine", "nodePath": "node", "checkoutPath": "checkout"
            }),
            &["enginePath", "nodePath", "checkoutPath"],
        );
        roundtrip_record::<Engine>(
            json!({
                "schemaVersion": 1, "version": "1.2.3", "platform": "win-x64", "kind": "sea", "executable": "engine", "args": []
            }),
            &["schemaVersion", "version", "platform", "kind", "executable"],
        );
        let receipt: Receipt =
            serde_json::from_value(json!({"schemaVersion": 1, "installMethod": "standalone"}))
                .unwrap();
        assert!(
            receipt.default_cli_version.is_none()
                && receipt.development.is_none()
                && receipt.extra_fields.is_empty()
        );
        let engine: Engine = serde_json::from_value(json!({"schemaVersion": 1, "version": "1.2.3", "platform": "win-x64", "kind": "sea", "executable": "engine"})).unwrap();
        assert!(engine.args.is_empty() && engine.extra_fields.is_empty());
        for invalid in [
            json!({"schemaVersion": 1, "installMethod": "standalone", "defaultCliVersion": []}),
            json!({"schemaVersion": 1, "installMethod": "standalone", "development": false}),
            json!({"schemaVersion": 1, "version": "1.2.3", "platform": "win-x64", "kind": "sea", "executable": "engine", "args": [false]}),
        ] {
            if invalid.get("installMethod").is_some() {
                assert!(serde_json::from_value::<Receipt>(invalid).is_err());
            } else {
                assert!(serde_json::from_value::<Engine>(invalid).is_err());
            }
        }
    }

    #[test]
    fn nested_development_metadata_remains_attached_to_its_own_record() {
        let value = json!({"schemaVersion": 1, "installMethod": "development", "defaultCliVersion": null,
        "outerMetadata": [null, 1], "development": {
            "enginePath": "engine", "nodePath": "node", "checkoutPath": "checkout", "innerMetadata": {"enabled": true}
        }});
        let receipt: Receipt = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(receipt.extra_fields.len(), 1);
        assert_eq!(receipt.development.as_ref().unwrap().extra_fields.len(), 1);
        assert_eq!(serde_json::to_value(receipt).unwrap(), value);
    }

    #[test]
    fn unknown_metadata_does_not_relax_engine_identity_kind_or_path_validation() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("engine"), b"engine").unwrap();
        fs::write(directory.path().join("entry.js"), b"entry").unwrap();
        let value = json!({"schemaVersion": 1, "version": "1.2.3", "platform": "win-x64", "kind": "node", "executable": "engine", "args": ["entry.js"], "futureMetadata": {"nested": [null]}});
        let write = |value: &Value| {
            fs::write(
                directory.path().join("engine.json"),
                serde_json::to_vec(value).unwrap(),
            )
            .unwrap()
        };
        write(&value);
        assert!(
            Engine::read(directory.path(), "1.2.3", "win-x64")
                .unwrap()
                .extra_fields
                .contains_key("futureMetadata")
        );
        for (field, invalid) in [
            ("schemaVersion", json!(2)),
            ("version", json!("2.0.0")),
            ("platform", json!("linux-x64")),
            ("kind", json!("unrecognized")),
            ("executable", json!("../engine")),
            ("args", json!([])),
        ] {
            let mut changed = value.clone();
            changed[field] = invalid;
            write(&changed);
            assert!(
                Engine::read(directory.path(), "1.2.3", "win-x64").is_err(),
                "Invalid {field} must fail"
            );
        }
    }

    #[test]
    fn receipt_extensions_do_not_relax_installation_validation() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("uapkg");
        let base = json!({"schemaVersion": 1, "installMethod": "standalone", "defaultCliVersion": "latest", "futureMetadata": [null, {"nested": true}]});
        let receipt = directory.path().join("uapkg-install.json");
        fs::write(&receipt, serde_json::to_vec(&base).unwrap()).unwrap();
        assert!(
            crate::storage::ContextPaths::for_executable(executable.clone())
                .unwrap()
                .receipt
                .unwrap()
                .extra_fields
                .contains_key("futureMetadata")
        );
        for (field, invalid) in [
            ("schemaVersion", json!(2)),
            ("installMethod", json!("unrecognized")),
            ("defaultCliVersion", json!("^1.2.3")),
        ] {
            let mut changed = base.clone();
            changed[field] = invalid;
            fs::write(&receipt, serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(
                crate::storage::ContextPaths::for_executable(executable.clone()).is_err(),
                "Invalid {field} must fail"
            );
        }
    }

    #[test]
    fn distribution_ids_distinguish_linux_libc_and_name_only_64_bit_windows_targets() {
        for (os, arch, target_env, expected) in [
            ("windows", "x86_64", "msvc", "win-x64"),
            ("windows", "aarch64", "msvc", "win-arm64"),
            ("macos", "x86_64", "", "darwin-x64"),
            ("macos", "aarch64", "", "darwin-arm64"),
            ("linux", "x86_64", "gnu", "linux-x64"),
            ("linux", "aarch64", "gnu", "linux-arm64"),
            ("linux", "x86_64", "musl", "linux-x64-musl"),
        ] {
            assert_eq!(
                distribution_platform(os, arch, target_env).unwrap(),
                expected
            );
            assert!(crate::catalog::PLATFORMS.contains(&expected));
        }
        for (os, arch, target_env) in [
            ("windows", "x86", "msvc"),
            ("linux", "aarch64", "musl"),
            ("linux", "x86_64", ""),
            ("linux", "x86_64", "uclibc"),
        ] {
            assert!(distribution_platform(os, arch, target_env).is_err());
        }
    }
}
