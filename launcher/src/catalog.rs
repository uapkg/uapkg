use crate::{
    github,
    model::{exact_version, read_json},
    storage::{ContextPaths, atomic_json, lock},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const PLATFORMS: &[&str] = &[
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
];
#[derive(Debug, PartialEq, Eq)]
pub enum Selector {
    Exact,
    Latest,
    Preview { base: String, stage: String },
}
pub fn selector(value: &str) -> Result<Selector> {
    if value == "latest" {
        return Ok(Selector::Latest);
    }
    let version = exact_version(value)?;
    if matches!(version.pre.as_str(), "alpha" | "beta") {
        ensure!(
            version.build.is_empty(),
            "Preview aliases cannot contain build metadata."
        );
        return Ok(Selector::Preview {
            base: format!("{}.{}.{}", version.major, version.minor, version.patch),
            stage: version.pre.to_string(),
        });
    }
    if !version.pre.is_empty() {
        let mut parts = version.pre.as_str().split('.');
        ensure!(
            matches!(parts.next(), Some("alpha" | "beta"))
                && parts.clone().count() == 1
                && parts.all(|part| part.bytes().all(|byte| byte.is_ascii_digit())),
            "Use an exact stable version, numbered alpha/beta version, latest, or a base-scoped alpha/beta selector."
        );
    }
    Ok(Selector::Exact)
}
fn exact(value: &str) -> Result<semver::Version> {
    ensure!(
        selector(value)? == Selector::Exact,
        "Catalog versions must be exact releases."
    );
    exact_version(value)
}
fn base(version: &semver::Version) -> String {
    format!("{}.{}.{}", version.major, version.minor, version.patch)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub version: String,
    pub date: String,
    pub files: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Index {
    pub schema_version: u32,
    pub product: String,
    pub aliases: BTreeMap<String, String>,
    pub releases: Vec<Release>,
}
impl Index {
    pub fn validate(&self, product: &str) -> Result<()> {
        ensure!(
            self.schema_version == 1 && self.product == product,
            "Catalog product or schema does not match the request."
        );
        let mut versions = BTreeSet::new();
        for release in &self.releases {
            exact(&release.version)?;
            ensure!(
                versions.insert(&release.version),
                "Duplicate catalog release."
            );
            ensure!(
                release.date.len() == 10
                    && release
                        .date
                        .bytes()
                        .enumerate()
                        .all(|(i, b)| if i == 4 || i == 7 {
                            b == b'-'
                        } else {
                            b.is_ascii_digit()
                        }),
                "Invalid release date."
            );
            let mut platforms = BTreeSet::new();
            ensure!(
                !release.files.is_empty(),
                "A catalog release must contain platforms."
            );
            for platform in &release.files {
                ensure!(
                    PLATFORMS.contains(&platform.as_str()) && platforms.insert(platform),
                    "Invalid or duplicate release platform."
                );
            }
        }
        for (alias, target) in &self.aliases {
            let version = exact(target)?;
            ensure!(
                versions.contains(target),
                "Alias target is not in the release index."
            );
            match selector(alias)? {
                Selector::Latest => ensure!(
                    version.pre.is_empty(),
                    "Latest must target a stable release."
                ),
                Selector::Preview {
                    base: requested,
                    stage,
                } => ensure!(
                    base(&version) == requested
                        && (version.pre.is_empty()
                            || version.pre.as_str().starts_with(&format!("{stage}."))),
                    "Preview aliases must remain in their base version and stage."
                ),
                Selector::Exact => anyhow::bail!("Exact versions cannot be aliases."),
            }
        }
        Ok(())
    }
    pub fn target(&self, selector: &str) -> Result<String> {
        self.aliases
            .get(selector)
            .cloned()
            .with_context(|| format!("No published alias is available for {selector}."))
    }
    pub fn supports(&self, version: &str, platform: &str) -> Result<()> {
        let release = self
            .releases
            .iter()
            .find(|release| release.version == version)
            .with_context(|| format!("Release {version} is not in the published index."))?;
        ensure!(
            release.files.iter().any(|file| file == platform),
            "Release {version} is unavailable for {platform}."
        );
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Replacements {
    pub schema_version: u32,
    pub product: String,
    pub replacements: BTreeMap<String, String>,
}
impl Replacements {
    pub fn validate(&self, product: &str) -> Result<()> {
        ensure!(
            self.schema_version == 1 && self.product == product,
            "Replacement product or schema does not match the request."
        );
        for (requested, target) in &self.replacements {
            let requested = exact(requested)?;
            let target = exact(target)?;
            ensure!(
                !requested.pre.is_empty()
                    && target.pre.is_empty()
                    && base(&requested) == base(&target),
                "Preview replacement must target the stable release of the same base version."
            );
        }
        Ok(())
    }
}
fn optional<T: serde::de::DeserializeOwned>(
    context: &ContextPaths,
    product: &str,
    name: &str,
    offline: bool,
) -> Result<Option<T>> {
    if github::catalog_key().is_none()
        && !context
            .home
            .join("catalog")
            .join(product)
            .join(format!("{name}.verified.json"))
            .exists()
    {
        return Ok(None);
    }
    match github::document(context, product, name, offline) {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
pub fn index(context: &ContextPaths, product: &str, offline: bool) -> Result<Option<Index>> {
    let value: Option<Index> = optional(context, product, "index.json", offline)?;
    if let Some(index) = &value {
        index.validate(product)?;
    }
    Ok(value)
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resolutions {
    #[serde(default)]
    active: BTreeMap<String, String>,
}
#[derive(Debug)]
pub struct Resolution {
    pub requested: String,
    pub version: String,
    pub messages: Vec<String>,
}
/// Stable tracking is activated only after successful explicit installation.
/// Preview movement is entirely published metadata; no local retirement clock exists.
pub fn resolve(
    context: &ContextPaths,
    product: &str,
    requested: &str,
    offline: bool,
    explicit: bool,
) -> Result<Resolution> {
    github::product(product)?;
    let kind = selector(requested)?;
    let mut messages = Vec::new();
    let version = match kind {
        Selector::Exact => {
            if exact_version(requested)?.pre.is_empty() {
                requested.to_owned()
            } else {
                let replacements: Option<Replacements> =
                    optional(context, product, "replacements.json", offline)?;
                if let Some(replacements) = replacements {
                    replacements.validate(product)?;
                    if let Some(target) = replacements.replacements.get(requested) {
                        messages.push(format!("The requested {product} preview has retired: {requested} -> {target}. Update the configured version selector."));
                        target.clone()
                    } else {
                        requested.to_owned()
                    }
                } else {
                    requested.to_owned()
                }
            }
        }
        Selector::Latest | Selector::Preview { .. } => {
            let index = index(context, product, offline)?;
            let latest = index
                .as_ref()
                .and_then(|index| index.aliases.get(requested).cloned());
            let state_path = context
                .home
                .join("catalog")
                .join(product)
                .join("resolutions.json");
            let state: Resolutions = if state_path.exists() {
                read_json(&state_path)?
            } else {
                Resolutions::default()
            };
            let active = state.active.get(requested);
            if let Some(active) = active {
                exact(active)?;
            }
            if kind == Selector::Latest
                && !explicit
                && let Some(active) = active
            {
                if let Some(latest) = &latest
                    && exact_version(latest)?
                        .cmp_precedence(&exact_version(active)?)
                        .is_gt()
                {
                    messages.push(format!("A new {product} version is available: {active} -> {latest}. Run `uapkg {}` to update.", if product == "cli" { "version install latest" } else { "self-update" }));
                }
                active.clone()
            } else {
                latest.or_else(|| active.cloned()).with_context(|| format!("No verified resolution is cached for {product} {requested}. Connect to releases.uapkg.dev and retry."))?
            }
        }
    };
    if let Selector::Preview { .. } = selector(requested)?
        && exact_version(&version)?.pre.is_empty()
    {
        messages.push(format!("The requested {product} preview is now stable: {requested} -> {version}. Update the configured version selector."));
    }
    Ok(Resolution {
        requested: requested.to_owned(),
        version,
        messages,
    })
}
pub fn activate(context: &ContextPaths, product: &str, resolution: &Resolution) -> Result<()> {
    if product == "launcher" {
        atomic_json(
            &context.home.join("catalog/launcher/tracking.json"),
            &serde_json::json!({"selector":resolution.requested,"version":resolution.version}),
        )?;
    }
    if selector(&resolution.requested)? == Selector::Exact {
        return Ok(());
    }
    exact(&resolution.version)?;
    let directory = context.home.join("catalog").join(product);
    let _lock = lock(&directory.join("resolutions.lock"))?;
    let path = directory.join("resolutions.json");
    let mut state: Resolutions = if path.exists() {
        read_json(&path)?
    } else {
        Resolutions::default()
    };
    state
        .active
        .insert(resolution.requested.clone(), resolution.version.clone());
    atomic_json(&path, &state)
}
pub fn launcher_notices(context: &ContextPaths, offline: bool) -> Result<Vec<String>> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Tracking {
        selector: String,
        version: String,
    }
    let path = context.home.join("catalog/launcher/tracking.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let tracking: Tracking = read_json(&path)?;
    exact(&tracking.version)?;
    let resolved = resolve(context, "launcher", &tracking.selector, offline, true)?;
    let mut messages = resolved.messages;
    if exact_version(&resolved.version)?
        .cmp_precedence(&exact_version(crate::model::VERSION)?)
        .is_gt()
    {
        messages.push(format!(
            "A new launcher version is available: {} -> {}. Run `uapkg self-update {}` to update.",
            crate::model::VERSION,
            resolved.version,
            tracking.selector
        ));
    }
    Ok(messages)
}

pub fn emit(messages: &[String]) {
    for message in messages {
        eprintln!("uapkg: {message}");
    }
}
pub fn apply_notices(command: &mut std::process::Command, messages: &[String]) -> Result<()> {
    command.env_remove("UAPKG_LAUNCHER_NOTICES");
    if !messages.is_empty() {
        command.env(
            "UAPKG_LAUNCHER_NOTICES",
            serde_json::to_string(&serde_json::json!({"schemaVersion":1,"messages":messages}))?,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn context(root: &std::path::Path) -> ContextPaths {
        ContextPaths {
            home: root.to_owned(),
            executable: root.join("uapkg"),
            receipt: None,
        }
    }
    fn cached(context: &ContextPaths, name: &str, bytes: &str, signature: &str) {
        atomic_json(
            &context
                .home
                .join("catalog/cli")
                .join(format!("{name}.verified.json")),
            &serde_json::json!({"bytes":bytes,"signature":signature}),
        )
        .unwrap();
    }
    fn published(context: &ContextPaths) {
        cached(
            context,
            "index.json",
            include_str!("../../tools/release/fixtures/index.json"),
            include_str!("../../tools/release/fixtures/index.json.minisig"),
        );
        cached(
            context,
            "replacements.json",
            include_str!("../../tools/release/fixtures/replacements.json"),
            include_str!("../../tools/release/fixtures/replacements.json.minisig"),
        );
    }
    #[test]
    fn shared_catalog_contract_and_separate_keys() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tools/release/fixtures/catalog-contract.json"
        ))
        .unwrap();
        for version in fixture["validVersions"].as_array().unwrap() {
            assert!(exact(version.as_str().unwrap()).is_ok(), "{version}");
        }
        for version in fixture["invalidVersions"].as_array().unwrap() {
            assert!(exact(version.as_str().unwrap()).is_err(), "{version}");
        }
        let index: Index = serde_json::from_value(fixture["index"].clone()).unwrap();
        index.validate("cli").unwrap();
        assert!(index.validate("launcher").is_err());
        let payload = include_bytes!("../../tools/release/fixtures/index.json");
        let signature = include_str!("../../tools/release/fixtures/index.json.minisig");
        github::verify(
            payload,
            signature,
            include_str!("../../tools/release/fixtures/metadata.pub"),
        )
        .unwrap();
        assert!(
            github::verify(
                payload,
                signature,
                include_str!("../../tools/release/fixtures/artifact.pub")
            )
            .is_err()
        );
        let sums = include_bytes!("../../tools/release/fixtures/SHASUMS256.txt");
        let signature = include_str!("../../tools/release/fixtures/SHASUMS256.txt.minisig");
        github::verify(
            sums,
            signature,
            include_str!("../../tools/release/fixtures/artifact.pub"),
        )
        .unwrap();
        assert!(
            github::verify(
                sums,
                signature,
                include_str!("../../tools/release/fixtures/metadata.pub")
            )
            .is_err()
        );
    }
    #[test]
    fn offline_latest_notifies_without_advancing_until_explicit_installation() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        published(&context);
        activate(
            &context,
            "cli",
            &Resolution {
                requested: "latest".into(),
                version: "1.9.0".into(),
                messages: vec![],
            },
        )
        .unwrap();
        let ordinary = resolve(&context, "cli", "latest", true, false).unwrap();
        assert_eq!(ordinary.version, "1.9.0");
        assert!(ordinary.messages[0].contains("1.9.0 -> 2.0.0"));
        let explicit = resolve(&context, "cli", "latest", true, true).unwrap();
        assert_eq!(explicit.version, "2.0.0");
        assert_eq!(
            resolve(&context, "cli", "latest", true, false)
                .unwrap()
                .version,
            "1.9.0",
            "Selection alone must not activate an uninstalled update"
        );
        activate(&context, "cli", &explicit).unwrap();
        assert_eq!(
            resolve(&context, "cli", "latest", true, false)
                .unwrap()
                .version,
            "2.0.0"
        );
        fs::remove_file(context.home.join("catalog/cli/index.json.verified.json")).unwrap();
        assert_eq!(
            resolve(&context, "cli", "latest", true, false)
                .unwrap()
                .version,
            "2.0.0"
        );
    }
    #[test]
    fn previews_follow_published_mappings_without_any_clock_or_absence_inference() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        published(&context);
        let exact = resolve(&context, "cli", "2.1.0-beta.1", true, false).unwrap();
        assert_eq!(exact.version, "2.1.0-beta.1");
        assert!(exact.messages.is_empty());
        assert_eq!(
            resolve(&context, "cli", "2.1.0-beta", true, false)
                .unwrap()
                .version,
            "2.1.0-beta.10"
        );
        let retired = resolve(&context, "cli", "2.0.0-alpha.1", true, false).unwrap();
        assert_eq!(retired.version, "2.0.0");
        assert!(retired.messages[0].contains("2.0.0-alpha.1 -> 2.0.0"));
        assert!(
            crate::engines::ensure_installed(&context, &retired.version, true).is_err(),
            "Known replacement cannot fall back to an old preview when binary is missing"
        );
        let alias = resolve(&context, "cli", "2.0.0-alpha", true, false).unwrap();
        assert_eq!(alias.version, "2.0.0");
        assert!(!alias.messages.is_empty());
        // Fixture dates remain usable indefinitely: the resolver has no time input.
        for _ in 0..3 {
            assert_eq!(
                resolve(&context, "cli", "2.1.0-beta.1", true, false)
                    .unwrap()
                    .version,
                "2.1.0-beta.1"
            );
        }
        fs::remove_file(
            context
                .home
                .join("catalog/cli/replacements.json.verified.json"),
        )
        .unwrap();
        assert_eq!(
            resolve(&context, "cli", "2.0.0-alpha.1", true, false)
                .unwrap()
                .version,
            "2.0.0-alpha.1"
        );
    }
    #[test]
    fn cached_metadata_tampering_and_cross_base_mapping_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        published(&context);
        cached(
            &context,
            "index.json",
            "{}",
            include_str!("../../tools/release/fixtures/index.json.minisig"),
        );
        assert!(resolve(&context, "cli", "latest", true, false).is_err());
        let mut replacements = Replacements {
            schema_version: 1,
            product: "cli".into(),
            replacements: BTreeMap::from([("2.0.0-alpha.1".into(), "2.1.0".into())]),
        };
        assert!(replacements.validate("cli").is_err());
        replacements.replacements =
            BTreeMap::from([("2.0.0-alpha.1".into(), "2.0.0-beta.2".into())]);
        assert!(replacements.validate("cli").is_err());
        assert!(
            github::checksum(
                format!("{}  ../escape\n", "0".repeat(64)).as_bytes(),
                "../escape"
            )
            .is_err()
        );
        assert!(
            github::checksum(
                format!("{}  file\n{}  file\n", "0".repeat(64), "1".repeat(64)).as_bytes(),
                "file"
            )
            .is_err()
        );
    }
}
