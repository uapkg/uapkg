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
    "linux-x64-musl",
    "win-arm64",
    "win-x64",
];
// Historical signed metadata keeps its original identifiers. Recognizing those
// records does not make them aliases for the current executable's platform.
pub const KNOWN_PLATFORMS: &[&str] = &[
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "linux-x64-musl",
    "win-arm64",
    "win-x64",
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
pub struct ReleaseStatus {
    pub at: String,
    pub reason: String,
}

impl ReleaseStatus {
    pub fn display_reason(&self) -> String {
        self.reason.chars().filter(|character| !matches!(*character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
            .map(|character| if character.is_control() { ' ' } else { character }).take(500).collect()
    }
    fn validate(&self) -> Result<()> {
        let bytes = self.at.as_bytes();
        let parts = if matches!(bytes.len(), 20 | 24)
            && bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes[10] == b'T'
            && bytes[13] == b':'
            && bytes[16] == b':'
            && bytes[bytes.len() - 1] == b'Z'
            && (bytes.len() == 20 || bytes[19] == b'.')
            && bytes.iter().enumerate().all(|(i, c)| {
                matches!(i, 4 | 7 | 10 | 13 | 16)
                    || i == bytes.len() - 1
                    || (bytes.len() == 24 && i == 19)
                    || c.is_ascii_digit()
            }) {
            Some((
                self.at[0..4].parse::<u32>()?,
                self.at[5..7].parse::<u32>()?,
                self.at[8..10].parse::<u32>()?,
                self.at[11..13].parse::<u32>()?,
                self.at[14..16].parse::<u32>()?,
                self.at[17..19].parse::<u32>()?,
            ))
        } else {
            None
        };
        let valid = parts.is_some_and(|(year, month, day, hour, minute, second)| {
            let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
            let days = match month {
                4 | 6 | 9 | 11 => 30,
                2 if leap => 29,
                2 => 28,
                1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
                _ => 0,
            };
            day >= 1 && day <= days && hour < 24 && minute < 60 && second < 60
        });
        ensure!(
            valid,
            "Invalid release status timestamp; use a full UTC timestamp."
        );
        ensure!(
            !self.reason.trim().is_empty(),
            "Release status reason cannot be empty."
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub version: String,
    pub date: String,
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yanked: Option<ReleaseStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quarantined: Option<ReleaseStatus>,
}
impl Release {
    pub fn unavailable(&self) -> Option<(&'static str, &ReleaseStatus)> {
        self.quarantined
            .as_ref()
            .map(|status| ("quarantined", status))
            .or_else(|| self.yanked.as_ref().map(|status| ("yanked", status)))
    }
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
            for status in [&release.yanked, &release.quarantined]
                .into_iter()
                .flatten()
            {
                status.validate()?;
            }
            ensure!(
                release.files.is_empty() == release.quarantined.is_some(),
                "A quarantined catalog release must have no platforms; other releases must contain platforms."
            );
            for platform in &release.files {
                ensure!(
                    KNOWN_PLATFORMS.contains(&platform.as_str()) && platforms.insert(platform),
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
            ensure!(
                self.release(target)
                    .is_some_and(|release| release.unavailable().is_none()),
                "Alias target must not be yanked or quarantined."
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
        if let Some(status) = &release.quarantined {
            anyhow::bail!(
                "Release {version} is quarantined: {}. Download and execution are refused.",
                status.display_reason()
            );
        }
        ensure!(
            release.files.iter().any(|file| file == platform),
            "Release {version} is unavailable for {platform}."
        );
        Ok(())
    }

    pub fn release(&self, version: &str) -> Option<&Release> {
        self.releases
            .iter()
            .find(|release| release.version == version)
    }

    pub fn ensure_runnable(&self, version: &str) -> Result<()> {
        if let Some((kind, status)) = self.release(version).and_then(Release::unavailable) {
            anyhow::bail!(
                "Release {version} is {kind}: {}. Execution is refused.",
                status.display_reason()
            );
        }
        Ok(())
    }

    /// Moderation never changes channels or treats build metadata as precedence.
    pub fn resolve_release(&self, version: &str, platform: &str) -> Result<(String, Vec<String>)> {
        let Some((kind, status)) = self.release(version).and_then(Release::unavailable) else {
            return Ok((version.into(), Vec::new()));
        };
        let current = exact(version)?;
        let stage = current.pre.as_str().split('.').next().unwrap_or_default();
        let mut candidates = self
            .releases
            .iter()
            .filter_map(|release| {
                if release.unavailable().is_some()
                    || !release.files.iter().any(|file| file == platform)
                {
                    return None;
                }
                let candidate = exact(&release.version).ok()?;
                let channel = if current.pre.is_empty() {
                    candidate.pre.is_empty()
                } else {
                    base(&candidate) == base(&current)
                        && candidate.pre.as_str().starts_with(&format!("{stage}."))
                };
                (channel && candidate.cmp_precedence(&current).is_lt())
                    .then_some((candidate, release))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|(a, left), (b, right)| {
            b.cmp_precedence(a)
                .then_with(|| left.version.cmp(&right.version))
        });
        let replacement = candidates.first().map(|(_, release)| release.version.clone())
            .with_context(|| format!("Release {version} is {kind}: {}. No previous un-yanked, un-quarantined release is available for {platform} in this channel.", status.display_reason()))?;
        Ok((
            replacement.clone(),
            vec![format!(
                "The requested {} release is {kind}: {version} -> {replacement}. Reason: {}",
                self.product,
                status.display_reason()
            )],
        ))
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
    validate: impl Fn(&T) -> Result<()>,
) -> Result<Option<T>> {
    match github::document_validated(context, product, name, offline, validate) {
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
    optional(context, product, "index.json", offline, |index: &Index| {
        index.validate(product)
    })
}

pub fn replacements(
    context: &ContextPaths,
    product: &str,
    offline: bool,
) -> Result<Option<Replacements>> {
    optional(
        context,
        product,
        "replacements.json",
        offline,
        |replacements: &Replacements| replacements.validate(product),
    )
}

pub fn refresh_index(context: &ContextPaths, product: &str) -> Result<Index> {
    github::refresh_document(context, product, "index.json", |index: &Index| {
        index.validate(product)
    })
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

fn read_resolutions(path: &std::path::Path) -> Result<Resolutions> {
    match read_json(path) {
        Ok(state) => Ok(state),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(Resolutions::default())
        }
        Err(error) => Err(error),
    }
}

pub fn active_version(
    context: &ContextPaths,
    product: &str,
    requested: &str,
) -> Result<Option<String>> {
    let path = context
        .home
        .join("catalog")
        .join(product)
        .join("resolutions.json");
    let active = read_resolutions(&path)?.active.remove(requested);
    if let Some(version) = &active {
        exact(version)?;
    }
    Ok(active)
}

/// Stable tracking is activated only after a successful installation.
/// Preview movement is entirely published metadata; no local retirement clock exists.
pub fn resolve(
    context: &ContextPaths,
    product: &str,
    requested: &str,
    offline: bool,
    explicit: bool,
) -> Result<Resolution> {
    optional_resolution(context, product, requested, offline, explicit)?.with_context(|| format!("No verified resolution is cached for {product} {requested}. Connect to releases.uapkg.dev and retry."))
}

pub(crate) fn cached_resolution(
    context: &ContextPaths,
    product: &str,
    requested: &str,
) -> Result<Option<Resolution>> {
    optional_resolution(context, product, requested, true, false)
}

fn optional_resolution(
    context: &ContextPaths,
    product: &str,
    requested: &str,
    offline: bool,
    explicit: bool,
) -> Result<Option<Resolution>> {
    github::product(product)?;
    let kind = selector(requested)?;
    let mut published = index(context, product, true)?;
    if published.is_none() && !offline && kind != Selector::Exact {
        published = index(context, product, false)?;
    }
    let mut messages = Vec::new();
    let version = match kind {
        Selector::Exact => {
            if exact_version(requested)?.pre.is_empty() {
                requested.to_owned()
            } else if let Some(replacements) = replacements(context, product, offline)? {
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
        Selector::Latest | Selector::Preview { .. } => {
            let latest = published
                .as_ref()
                .and_then(|index| index.aliases.get(requested).cloned());
            let active = active_version(context, product, requested)?;
            if kind == Selector::Latest
                && !explicit
                && let Some(active) = &active
            {
                if let Some(latest) = &latest
                    && exact_version(latest)?
                        .cmp_precedence(&exact_version(active)?)
                        .is_gt()
                {
                    messages.push(format!("A new {product} version is available: {active} -> {latest}. Run `uapkg {}` to update.", if product == "cli" { "version install latest" } else { "launcher-update" }));
                }
                active.clone()
            } else {
                let Some(version) = latest.or(active) else {
                    return Ok(None);
                };
                version
            }
        }
    };
    let version = if let Some(index) = &published {
        let (version, notices) = index.resolve_release(&version, crate::model::platform()?)?;
        messages.extend(notices);
        version
    } else {
        version
    };
    if let Selector::Preview { .. } = selector(requested)?
        && exact_version(&version)?.pre.is_empty()
    {
        messages.push(format!("The requested {product} preview is now stable: {requested} -> {version}. Update the configured version selector."));
    }
    Ok(Some(Resolution {
        requested: requested.to_owned(),
        version,
        messages,
    }))
}
pub fn activate(context: &ContextPaths, product: &str, resolution: &Resolution) -> Result<()> {
    if let Some(index) = index(context, product, true)? {
        index.ensure_runnable(&resolution.version)?;
    }
    if product == "launcher" {
        atomic_json(
            &context.home.join("catalog/launcher/tracking.json"),
            &serde_json::json!({"selector":resolution.requested,"version":resolution.version}),
        )?;
    }
    if selector(&resolution.requested)? == Selector::Exact {
        return Ok(());
    }
    let candidate = exact(&resolution.version)?;
    let directory = context.home.join("catalog").join(product);
    let _lock = lock(&directory.join("resolutions.lock"))?;
    let path = directory.join("resolutions.json");
    let mut state = read_resolutions(&path)?;
    let index = index(context, product, true)?;
    if let Some(index) = &index {
        index.ensure_runnable(&resolution.version)?;
    }
    if let Some(active) = state.active.get(&resolution.requested)
        && (active == &resolution.version
            || (product == "cli"
                && resolution.requested == "latest"
                && !candidate.cmp_precedence(&exact(active)?).is_gt()
                && !index.as_ref().is_some_and(|index| {
                    index
                        .release(active)
                        .is_some_and(|release| release.unavailable().is_some())
                })))
    {
        return Ok(());
    }
    state
        .active
        .insert(resolution.requested.clone(), resolution.version.clone());
    atomic_json(&path, &state)
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
pub(crate) fn cache_moderated_fixture(context: &ContextPaths, product: &str) -> Index {
    let (bytes, signature) = match product {
        "cli" => (
            include_str!("../../tools/release/fixtures/moderated-cli.json"),
            include_str!("../../tools/release/fixtures/moderated-cli.json.minisig"),
        ),
        "launcher" => (
            include_str!("../../tools/release/fixtures/moderated-launcher.json"),
            include_str!("../../tools/release/fixtures/moderated-launcher.json.minisig"),
        ),
        _ => panic!("Unknown fixture product"),
    };
    atomic_json(
        &context
            .home
            .join("catalog")
            .join(product)
            .join("index.json.verified.json"),
        &serde_json::json!({"bytes":bytes,"signature":signature}),
    )
    .unwrap();
    index(context, product, true).unwrap().unwrap()
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
        for value in fixture["validStatusIndexes"].as_array().unwrap() {
            serde_json::from_value::<Index>(value.clone())
                .unwrap()
                .validate("cli")
                .unwrap();
        }
        for value in fixture["invalidStatusIndexes"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<Index>(value.clone())
                    .map_err(anyhow::Error::from)
                    .and_then(|index| index.validate("cli"))
                    .is_err(),
                "{value}"
            );
        }
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
    fn historical_and_current_catalogs_coexist_without_platform_aliases() {
        let mut index: Index =
            serde_json::from_str(include_str!("../../tools/release/fixtures/index.json")).unwrap();
        index.releases.push(Release {
            version: "3.0.0".into(),
            date: "2026-11-17".into(),
            yanked: None,
            quarantined: None,
            files: PLATFORMS
                .iter()
                .map(|platform| (*platform).into())
                .collect(),
        });
        index.validate("cli").unwrap();
        for platform in ["win-x64", "win-arm64", "linux-x64-musl"] {
            index.supports("3.0.0", platform).unwrap();
            let error = index.supports("2.0.0", platform).unwrap_err().to_string();
            assert_eq!(
                error,
                format!("Release 2.0.0 is unavailable for {platform}.")
            );
        }
        for platform in ["win32-x64", "win32-arm64"] {
            index.supports("2.0.0", platform).unwrap();
            assert!(index.supports("3.0.0", platform).is_err());
            assert!(github::artifact_name("cli", "3.0.0", platform).is_err());
        }
        for platform in ["linux-arm64-musl", "win-ia32", "../../escape"] {
            let mut invalid = index.clone();
            invalid.releases[0].files.push(platform.into());
            assert!(invalid.validate("cli").is_err());
        }
        let duplicate = index.releases[0].files[0].clone();
        index.releases[0].files.push(duplicate);
        assert!(index.validate("cli").is_err());
    }

    #[test]
    fn cached_resolutions_leave_unknown_aliases_unresolved_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        for requested in ["latest", "2.1.0-beta"] {
            assert!(
                cached_resolution(&context, "cli", requested)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                resolve(&context, "cli", requested, true, false)
                    .unwrap_err()
                    .to_string(),
                format!(
                    "No verified resolution is cached for cli {requested}. Connect to releases.uapkg.dev and retry."
                )
            );
        }
        for requested in ["1.2.3", "2.1.0-beta.1"] {
            let resolution = cached_resolution(&context, "cli", requested)
                .unwrap()
                .unwrap();
            assert_eq!(resolution.requested, requested);
            assert_eq!(resolution.version, requested);
            assert!(resolution.messages.is_empty());
        }
        assert!(replacements(&context, "cli", true).unwrap().is_none());
        assert!(cached_resolution(&context, "unknown", "latest").is_err());
        assert!(cached_resolution(&context, "cli", "^1.2.3").is_err());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn cached_resolutions_use_signed_mappings_without_advancing_tracking() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        published(&context);
        atomic_json(
            &context.home.join("catalog/cli/resolutions.json"),
            &serde_json::json!({"active":{"latest":"1.9.0","2.1.0-beta":"2.1.0-beta.1"}}),
        )
        .unwrap();
        let snapshot = || {
            fs::read_dir(context.home.join("catalog/cli"))
                .unwrap()
                .map(|entry| {
                    let entry = entry.unwrap();
                    (entry.file_name(), fs::read(entry.path()).unwrap())
                })
                .collect::<BTreeMap<_, _>>()
        };
        let before = snapshot();
        for (requested, expected) in [
            ("latest", "1.9.0"),
            ("2.1.0-beta", "2.1.0-beta.10"),
            ("2.0.0-alpha.1", "2.0.0"),
            ("2.0.0-beta", "2.0.0"),
        ] {
            assert_eq!(
                cached_resolution(&context, "cli", requested)
                    .unwrap()
                    .unwrap()
                    .version,
                expected
            );
        }
        assert_eq!(
            replacements(&context, "cli", true)
                .unwrap()
                .unwrap()
                .replacements["2.0.0-alpha.1"],
            "2.0.0"
        );
        assert_eq!(snapshot(), before);

        fs::remove_file(context.home.join("catalog/cli/index.json.verified.json")).unwrap();
        let before = snapshot();
        for (requested, expected) in [("latest", "1.9.0"), ("2.1.0-beta", "2.1.0-beta.1")] {
            assert_eq!(
                cached_resolution(&context, "cli", requested)
                    .unwrap()
                    .unwrap()
                    .version,
                expected
            );
        }
        assert_eq!(snapshot(), before);
    }

    #[test]
    fn cached_resolutions_reject_invalid_metadata_and_tracking() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        published(&context);
        cached(
            &context,
            "index.json",
            "{}",
            include_str!("../../tools/release/fixtures/index.json.minisig"),
        );
        assert!(cached_resolution(&context, "cli", "latest").is_err());
        fs::write(
            context.home.join("catalog/cli/index.json.verified.json"),
            b"not JSON",
        )
        .unwrap();
        assert!(cached_resolution(&context, "cli", "latest").is_err());

        published(&context);
        cached(
            &context,
            "replacements.json",
            "{}",
            include_str!("../../tools/release/fixtures/replacements.json.minisig"),
        );
        assert!(cached_resolution(&context, "cli", "2.0.0-alpha.1").is_err());
        assert!(replacements(&context, "cli", true).is_err());

        published(&context);
        let tracking = context.home.join("catalog/cli/resolutions.json");
        fs::write(&tracking, b"not JSON").unwrap();
        assert!(cached_resolution(&context, "cli", "latest").is_err());
        atomic_json(
            &tracking,
            &serde_json::json!({"active":{"latest":"invalid"}}),
        )
        .unwrap();
        assert!(cached_resolution(&context, "cli", "latest").is_err());
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

    #[test]
    fn signed_moderation_redirects_exact_and_remembered_latest_and_allows_rollback_activation() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        cache_moderated_fixture(&context, "cli");
        atomic_json(
            &context.home.join("catalog/cli/resolutions.json"),
            &serde_json::json!({"active":{"latest":"1.7.2"}}),
        )
        .unwrap();
        for requested in ["1.7.2", "1.7.1", "latest"] {
            let resolution = resolve(&context, "cli", requested, true, false).unwrap();
            assert_eq!(resolution.version, "1.7.0");
            assert!(
                resolution
                    .messages
                    .iter()
                    .any(|message| message.contains("Reason:"))
            );
        }
        let resolution = resolve(&context, "cli", "latest", true, false).unwrap();
        activate(&context, "cli", &resolution).unwrap();
        assert_eq!(
            active_version(&context, "cli", "latest")
                .unwrap()
                .as_deref(),
            Some("1.7.0")
        );
        assert!(
            activate(
                &context,
                "cli",
                &Resolution {
                    requested: "latest".into(),
                    version: "1.7.2".into(),
                    messages: vec![]
                }
            )
            .is_err()
        );
    }

    #[test]
    fn moderation_preserves_channels_uses_numeric_precedence_and_skips_build_ties() {
        let index: Index = serde_json::from_value(serde_json::json!({
            "schemaVersion":1,"product":"cli","aliases":{},"releases":[
                {"version":"2.0.0-beta.11","date":"2026-11-18","files":[],"quarantined":{"at":"2026-11-18T00:00:00Z","reason":"broken"}},
                {"version":"2.0.0-beta.10","date":"2026-11-18","files":["win-x64"]},
                {"version":"2.0.0-beta.9","date":"2026-11-18","files":["win-x64"]},
                {"version":"2.0.0-alpha.99","date":"2026-11-18","files":["win-x64"]},
                {"version":"1.9.0-beta.99","date":"2026-11-18","files":["win-x64"]},
                {"version":"2.0.0","date":"2026-11-18","files":["win-x64"],"yanked":{"at":"2026-11-18T00:00:00Z","reason":"broken"}},
                {"version":"2.0.0+healthy-build","date":"2026-11-18","files":["win-x64"]},
                {"version":"1.8.0+build.2","date":"2026-11-18","files":["win-x64"]},
                {"version":"1.8.0+build.1","date":"2026-11-18","files":["win-x64"]},
                {"version":"1.9.0","date":"2026-11-18","files":["linux-x64"]}
            ]})).unwrap();
        index.validate("cli").unwrap();
        assert_eq!(
            index.resolve_release("2.0.0-beta.11", "win-x64").unwrap().0,
            "2.0.0-beta.10"
        );
        assert_eq!(
            index.resolve_release("2.0.0", "win-x64").unwrap().0,
            "1.8.0+build.1"
        );
        assert!(index.resolve_release("2.0.0-beta.11", "linux-x64").is_err());
        let mut empty = index.clone();
        empty
            .releases
            .retain(|release| release.version == "2.0.0" || release.version.starts_with("2.0.0+"));
        assert!(empty.resolve_release("2.0.0", "win-x64").is_err());
    }

    #[test]
    fn status_serialization_omits_nulls_and_notices_strip_control_characters() {
        let release: Release = serde_json::from_value(serde_json::json!({"version":"1.0.0","date":"2026-11-18","files":["win-x64"],"yanked":null,"quarantined":null})).unwrap();
        let value = serde_json::to_value(&release).unwrap();
        assert!(value.get("yanked").is_none() && value.get("quarantined").is_none());
        let status = ReleaseStatus {
            at: "2026-11-18T00:00:00Z".into(),
            reason: format!("bad\n\u{1b}[31m{}", "x".repeat(3000)),
        };
        let reason = status.display_reason();
        assert_eq!(reason.chars().count(), 500);
        assert!(!reason.chars().any(char::is_control));
    }
}
