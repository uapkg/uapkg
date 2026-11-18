use crate::{
    catalog::{self, Index, Replacements, Selector},
    engines,
    model::{exact_version, platform},
    routing::{Invocation, discover_project},
    storage::ContextPaths,
};
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeSet, path::Path};

const LOCAL_FOOTER: &str =
    "To see the list of available versions, run `uapkg version list available`.";
const AVAILABLE_FOOTER: &str = "For the complete list, visit https://releases.uapkg.dev/cli";
const AVAILABLE_LIMIT: usize = 15;

struct Tag {
    role: &'static str,
    alias: Option<String>,
}

struct SelectedVersion {
    version: String,
    resolved: bool,
    tags: Vec<Tag>,
}

pub(crate) fn local(context: &ContextPaths, invocation: &Invocation, cwd: &Path) -> Result<String> {
    ensure!(
        context.ownership() != "development" || invocation.override_version.is_none(),
        "--cli-version is unavailable for a development checkout binding."
    );
    let settings = context.settings_at(cwd, uapkg_slim_config::Scope::Effective)?;
    let project = discover_project(cwd)?;
    let selections = [
        ("global default", settings.global_cli_version.as_deref()),
        (
            "config default",
            (matches!(
                settings.config_source,
                uapkg_slim_config::Source::Intermediary | uapkg_slim_config::Source::Local
            ) && settings
                .config_file
                .as_deref()
                .is_some_and(|file| !same_config_file(file, &context.home.join("config.json"))))
            .then(|| context.default_version(&settings))
            .flatten(),
        ),
        (
            "project pin",
            project
                .as_ref()
                .and_then(|project| project.version.as_deref()),
        ),
        ("cli override", invocation.override_version.as_deref()),
    ];
    let mut selected: Vec<SelectedVersion> = Vec::new();
    for (role, requested) in selections {
        let Some(requested) = requested else { continue };
        let resolution = catalog::cached_selection(
            context,
            "cli",
            requested,
            matches!(role, "project pin" | "cli override"),
        )?;
        let resolved = resolution.is_some();
        let version = resolution.map_or_else(|| requested.to_owned(), |value| value.version);
        let tag = Tag {
            role,
            alias: (catalog::selector(requested)? != Selector::Exact).then(|| requested.to_owned()),
        };
        if let Some(row) = selected
            .iter_mut()
            .find(|row| row.version == version && row.resolved == resolved)
        {
            row.tags.push(tag);
        } else {
            selected.push(SelectedVersion {
                version,
                resolved,
                tags: vec![tag],
            });
        }
    }
    local_output(selected, engines::list(context)?)
}

fn same_config_file(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn local_output(selected: Vec<SelectedVersion>, installed: Vec<String>) -> Result<String> {
    let mut remaining: BTreeSet<_> = installed.into_iter().collect();
    let mut tagged = Vec::new();
    for row in selected {
        let status = if !row.resolved {
            "unresolved"
        } else if remaining.remove(&row.version) {
            "installed"
        } else {
            "not installed"
        };
        let mut labels: Vec<_> = row.tags.iter().map(|tag| tag.role).collect();
        labels.push(status);
        let mut line = format!("{} ({})", row.version, labels.join(", "));
        if row.resolved {
            let aliases: Vec<_> = row
                .tags
                .iter()
                .filter_map(|tag| {
                    tag.alias.as_ref().map(|alias| {
                        if row.tags.len() == 1 {
                            format!("used as alias `{alias}`")
                        } else {
                            format!("{} uses alias `{alias}`", tag.role)
                        }
                    })
                })
                .collect();
            if !aliases.is_empty() {
                line.push_str(&format!(" ({})", aliases.join("; ")));
            }
        }
        tagged.push(line);
    }
    let mut sections = Vec::new();
    if !tagged.is_empty() {
        sections.push(tagged.join("\n"));
    }
    if !remaining.is_empty() {
        sections.push(sorted_versions(remaining.into_iter().collect())?.join("\n"));
    }
    if sections.is_empty() {
        sections.push("No CLI versions are installed for this platform.".into());
    }
    sections.push(LOCAL_FOOTER.into());
    Ok(format!("{}\n", sections.join("\n\n")))
}

pub(crate) fn available(context: &ContextPaths, offline: bool) -> Result<String> {
    let index = catalog::index(context, "cli", offline)?
        .context("No verified CLI index is available. Connect to releases.uapkg.dev and retry.")?;
    let replacements = catalog::replacements(context, "cli", offline)?;
    available_output(&index, replacements.as_ref(), platform()?)
}

fn available_output(
    index: &Index,
    replacements: Option<&Replacements>,
    target: &str,
) -> Result<String> {
    let versions = sorted_versions(
        index
            .releases
            .iter()
            .filter(|release| {
                release.files.iter().any(|file| file == target)
                    && release.unavailable().is_none()
                    && !replacements
                        .is_some_and(|map| map.replacements.contains_key(&release.version))
            })
            .map(|release| release.version.clone())
            .collect(),
    )?;
    let partial = versions.len() > AVAILABLE_LIMIT;
    let mut lines = Vec::new();
    for version in versions.into_iter().take(AVAILABLE_LIMIT) {
        let aliases: Vec<_> = index
            .aliases
            .iter()
            .filter(|(_, target)| **target == version)
            .map(|(alias, _)| format!("`{alias}`"))
            .collect();
        let line = match aliases.len() {
            0 => version,
            1 => format!("{version} (alias {})", aliases[0]),
            _ => format!("{version} (aliases {})", aliases.join(", ")),
        };
        lines.push(line);
    }
    if lines.is_empty() {
        lines.push("No CLI versions are available for this platform.".into());
    }
    let footer = if partial {
        format!("This is a partial list. {AVAILABLE_FOOTER}")
    } else {
        AVAILABLE_FOOTER.into()
    };
    Ok(format!("{}\n\n{footer}\n", lines.join("\n")))
}

fn sorted_versions(versions: Vec<String>) -> Result<Vec<String>> {
    let mut parsed = versions
        .into_iter()
        .map(|version| Ok((exact_version(&version)?, version)))
        .collect::<Result<Vec<_>>>()?;
    parsed.sort_by(|(a, a_text), (b, b_text)| b.cmp_precedence(a).then_with(|| a_text.cmp(b_text)));
    Ok(parsed.into_iter().map(|(_, version)| version).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{catalog::Release, storage::atomic_json};
    use std::{collections::BTreeMap, ffi::OsString, fs};

    fn index(versions: impl IntoIterator<Item = String>) -> Index {
        let index = Index {
            schema_version: 1,
            product: "cli".into(),
            aliases: BTreeMap::new(),
            releases: versions
                .into_iter()
                .map(|version| Release {
                    version,
                    date: "2026-11-17".into(),
                    files: vec!["win-x64".into()],
                    yanked: None,
                    quarantined: None,
                    extra_fields: Default::default(),
                })
                .collect(),
            extra_fields: Default::default(),
        };
        index.validate("cli").unwrap();
        index
    }

    fn context(root: &Path) -> ContextPaths {
        ContextPaths {
            home: root.join("profile"),
            executable: root.join("uapkg"),
            receipt: None,
        }
    }

    fn invocation(args: &[&str]) -> Invocation {
        Invocation::parse(args.iter().copied().map(OsString::from).collect()).unwrap()
    }

    fn published(context: &ContextPaths) {
        for (name, bytes, signature) in [
            (
                "index.json",
                include_str!("../../tools/release/fixtures/index.json"),
                include_str!("../../tools/release/fixtures/index.json.minisig"),
            ),
            (
                "replacements.json",
                include_str!("../../tools/release/fixtures/replacements.json"),
                include_str!("../../tools/release/fixtures/replacements.json.minisig"),
            ),
        ] {
            atomic_json(
                &context
                    .home
                    .join("catalog/cli")
                    .join(format!("{name}.verified.json")),
                &serde_json::json!({"bytes":bytes,"signature":signature}),
            )
            .unwrap();
        }
    }

    fn installed(context: &ContextPaths, version: &str) {
        let target = platform().unwrap();
        let root = context.cache_dir(version, target).unwrap();
        atomic_json(
            &root.join("engine.json"),
            &serde_json::json!({"schemaVersion":1,"version":version,"platform":target,"kind":"sea","executable":"cli"}),
        ).unwrap();
        atomic_json(
            &root.join(".installed.json"),
            &serde_json::json!({"schemaVersion":1,"version":version,"platform":target}),
        )
        .unwrap();
        fs::write(root.join("cli"), b"test executable").unwrap();
    }

    #[test]
    fn available_orders_semver_precedence_and_build_ties_deterministically() {
        let index = index(
            [
                "2.0.0+build.2",
                "2.1.0-alpha.2",
                "2.1.0-beta.2",
                "2.0.0+build.10",
                "2.1.0-alpha.10",
                "2.1.0",
                "2.1.0-beta.10",
                "2.0.0",
                "3.0.0",
            ]
            .map(str::to_owned),
        );
        assert_eq!(
            available_output(&index, None, "win-x64").unwrap(),
            format!(
                "3.0.0\n2.1.0\n2.1.0-beta.10\n2.1.0-beta.2\n2.1.0-alpha.10\n2.1.0-alpha.2\n2.0.0\n2.0.0+build.10\n2.0.0+build.2\n\n{AVAILABLE_FOOTER}\n"
            )
        );
    }

    #[test]
    fn available_shows_only_published_aliases_in_alphabetical_order() {
        let mut index = index(["1.0.0", "2.0.0", "2.1.0-beta.10"].map(str::to_owned));
        index.aliases = BTreeMap::from([
            ("latest".into(), "2.0.0".into()),
            ("2.0.0-beta".into(), "2.0.0".into()),
            ("2.1.0-beta".into(), "2.1.0-beta.10".into()),
            ("2.0.0-alpha".into(), "2.0.0".into()),
        ]);
        index.validate("cli").unwrap();
        assert_eq!(
            available_output(&index, None, "win-x64").unwrap(),
            format!(
                "2.1.0-beta.10 (alias `2.1.0-beta`)\n2.0.0 (aliases `2.0.0-alpha`, `2.0.0-beta`, `latest`)\n1.0.0\n\n{AVAILABLE_FOOTER}\n"
            )
        );
    }

    #[test]
    fn available_handles_empty_and_fifteen_version_boundaries() {
        for count in [0, 15, 16] {
            let index = index((0..count).map(|patch| format!("1.0.{patch}")));
            let output = available_output(&index, None, "win-x64").unwrap();
            let entries = if count == 0 {
                "No CLI versions are available for this platform.".into()
            } else {
                (0..count)
                    .rev()
                    .take(15)
                    .map(|patch| format!("1.0.{patch}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let partial = if count > 15 {
                "This is a partial list. "
            } else {
                ""
            };
            assert_eq!(
                output,
                format!("{entries}\n\n{partial}{AVAILABLE_FOOTER}\n")
            );
        }
    }

    #[test]
    fn available_filters_replaced_and_foreign_versions_before_limiting() {
        for eligible in [15, 16] {
            let mut versions: Vec<_> = (0..eligible - 1)
                .map(|patch| format!("1.0.{patch}"))
                .collect();
            versions.extend(
                ["2.0.0", "2.0.0-alpha.1", "2.0.0-alpha.2", "3.0.0", "4.0.0"].map(str::to_owned),
            );
            let mut index = index(versions);
            index
                .releases
                .iter_mut()
                .find(|release| release.version == "3.0.0")
                .unwrap()
                .files = vec!["win32-x64".into()];
            index
                .releases
                .iter_mut()
                .find(|release| release.version == "4.0.0")
                .unwrap()
                .files = vec!["linux-x64".into()];
            index.validate("cli").unwrap();
            let replacements = Replacements {
                schema_version: 1,
                product: "cli".into(),
                replacements: BTreeMap::from([
                    ("2.0.0-alpha.1".into(), "2.0.0".into()),
                    ("2.0.0-alpha.2".into(), "2.0.0".into()),
                ]),
                extra_fields: Default::default(),
            };
            replacements.validate("cli").unwrap();
            let output = available_output(&index, Some(&replacements), "win-x64").unwrap();
            let expected = std::iter::once("2.0.0".to_owned())
                .chain(
                    (0..eligible - 1)
                        .rev()
                        .take(14)
                        .map(|patch| format!("1.0.{patch}")),
                )
                .collect::<Vec<_>>()
                .join("\n");
            let partial = if eligible > 15 {
                "This is a partial list. "
            } else {
                ""
            };
            assert_eq!(
                output,
                format!("{expected}\n\n{partial}{AVAILABLE_FOOTER}\n")
            );
        }
    }

    #[test]
    fn available_reads_signed_cached_metadata_and_permits_missing_replacements() {
        let root = tempfile::tempdir().unwrap();
        let context = context(root.path());
        published(&context);
        let entries = if matches!(
            platform().unwrap(),
            "win-x64" | "win-arm64" | "linux-x64-musl"
        ) {
            "No CLI versions are available for this platform."
        } else {
            "2.1.0-beta.10 (alias `2.1.0-beta`)\n2.0.0 (aliases `2.0.0-alpha`, `2.0.0-beta`, `latest`)"
        };
        let expected = format!("{entries}\n\n{AVAILABLE_FOOTER}\n");
        assert_eq!(available(&context, true).unwrap(), expected);
        fs::remove_file(
            context
                .home
                .join("catalog/cli/replacements.json.verified.json"),
        )
        .unwrap();
        assert_eq!(available(&context, true).unwrap(), expected);
    }

    #[test]
    fn available_rejects_tampered_index_and_replacements() {
        let root = tempfile::tempdir().unwrap();
        let context = context(root.path());
        for (name, signature) in [
            (
                "index.json",
                include_str!("../../tools/release/fixtures/index.json.minisig"),
            ),
            (
                "replacements.json",
                include_str!("../../tools/release/fixtures/replacements.json.minisig"),
            ),
        ] {
            published(&context);
            atomic_json(
                &context
                    .home
                    .join("catalog/cli")
                    .join(format!("{name}.verified.json")),
                &serde_json::json!({"bytes":"{}","signature":signature}),
            )
            .unwrap();
            assert!(available(&context, true).is_err(), "{name}");
        }
    }

    #[test]
    fn local_shows_remembered_latest_and_project_alias_without_labeling_exact_selectors() {
        let root = tempfile::tempdir().unwrap();
        let context = context(root.path());
        let cwd = root.path().join("project");
        published(&context);
        atomic_json(
            &context.home.join("config.json"),
            &serde_json::json!({"launcher":{"defaultCliVersion":"latest"}}),
        )
        .unwrap();
        atomic_json(
            &context.home.join("catalog/cli/resolutions.json"),
            &serde_json::json!({"active":{"latest":"1.9.0"}}),
        )
        .unwrap();
        atomic_json(
            &cwd.join("uapkg.json"),
            &serde_json::json!({"kind":"project","uapkgVersion":"2.1.0-beta"}),
        )
        .unwrap();
        installed(&context, "1.9.0");
        installed(&context, "2.0.0");
        assert_eq!(
            local(
                &context,
                &invocation(&["version", "list", "--cli-version=2.0.0"]),
                &cwd
            )
            .unwrap(),
            format!(
                "1.9.0 (global default, installed) (used as alias `latest`)\n2.1.0-beta.10 (project pin, not installed) (used as alias `2.1.0-beta`)\n2.0.0 (cli override, installed)\n\n{LOCAL_FOOTER}\n"
            )
        );
    }

    #[test]
    fn local_latest_pins_and_overrides_show_the_published_target() {
        let root = tempfile::tempdir().unwrap();
        let context = context(root.path());
        let cwd = root.path().join("project");
        published(&context);
        atomic_json(
            &context.home.join("config.json"),
            &serde_json::json!({"launcher":{"defaultCliVersion":"latest"}}),
        )
        .unwrap();
        atomic_json(
            &context.home.join("catalog/cli/resolutions.json"),
            &serde_json::json!({"active":{"latest":"1.9.0"}}),
        )
        .unwrap();
        atomic_json(
            &cwd.join("uapkg.json"),
            &serde_json::json!({"kind":"project","uapkgVersion":"latest"}),
        )
        .unwrap();
        installed(&context, "1.9.0");
        let tracking = context.home.join("catalog/cli/resolutions.json");
        let before = fs::read(&tracking).unwrap();
        assert_eq!(
            local(
                &context,
                &invocation(&["version", "list", "--cli-version=latest"]),
                &cwd
            )
            .unwrap(),
            format!(
                "1.9.0 (global default, installed) (used as alias `latest`)\n2.0.0 (project pin, cli override, not installed) (project pin uses alias `latest`; cli override uses alias `latest`)\n\n{LOCAL_FOOTER}\n"
            )
        );
        assert_eq!(fs::read(tracking).unwrap(), before);
    }

    #[test]
    fn local_associates_aliases_with_roles_when_selections_merge() {
        let root = tempfile::tempdir().unwrap();
        let context = context(root.path());
        let cwd = root.path().join("project");
        published(&context);
        atomic_json(
            &context.home.join("config.json"),
            &serde_json::json!({"launcher":{"defaultCliVersion":"latest"}}),
        )
        .unwrap();
        atomic_json(
            &cwd.join("uapkg.json"),
            &serde_json::json!({"kind":"project","uapkgVersion":"2.0.0-alpha"}),
        )
        .unwrap();
        installed(&context, "2.0.0");
        assert_eq!(
            local(
                &context,
                &invocation(&["version", "list", "--cli-version=2.0.0"]),
                &cwd
            )
            .unwrap(),
            format!(
                "2.0.0 (global default, project pin, cli override, installed) (global default uses alias `latest`; project pin uses alias `2.0.0-alpha`)\n\n{LOCAL_FOOTER}\n"
            )
        );
    }

    #[test]
    fn local_follows_known_preview_replacements_without_alias_labels() {
        let root = tempfile::tempdir().unwrap();
        let context = context(root.path());
        published(&context);
        atomic_json(
            &context.home.join("config.json"),
            &serde_json::json!({"launcher":{"defaultCliVersion":"2.0.0-alpha.1"}}),
        )
        .unwrap();
        installed(&context, "2.0.0-alpha.1");
        assert_eq!(
            local(&context, &invocation(&["version", "list"]), root.path()).unwrap(),
            format!("2.0.0 (global default, not installed)\n\n2.0.0-alpha.1\n\n{LOCAL_FOOTER}\n")
        );
    }

    #[test]
    fn local_merges_unresolved_alias_roles_without_inventing_a_version() {
        let root = tempfile::tempdir().unwrap();
        let context = context(root.path());
        let cwd = root.path().join("project");
        atomic_json(
            &context.home.join("config.json"),
            &serde_json::json!({"launcher":{"defaultCliVersion":"latest"}}),
        )
        .unwrap();
        atomic_json(
            &cwd.join("uapkg.json"),
            &serde_json::json!({"kind":"project","uapkgVersion":"latest"}),
        )
        .unwrap();
        assert_eq!(
            local(
                &context,
                &invocation(&["version", "list", "--cli-version=latest"]),
                &cwd
            )
            .unwrap(),
            format!(
                "latest (global default, project pin, cli override, unresolved)\n\n{LOCAL_FOOTER}\n"
            )
        );
        assert!(!context.home.join("catalog").exists());
        assert!(!context.home.join("engines").exists());
    }

    #[test]
    fn local_uses_generated_default_instead_of_receipt_fallback() {
        let root = tempfile::tempdir().unwrap();
        let mut context = context(root.path());
        context.receipt = Some(
            serde_json::from_value(serde_json::json!({
                "schemaVersion":1,"installMethod":"standalone","defaultCliVersion":"1.2.3"
            }))
            .unwrap(),
        );
        assert_eq!(
            local(&context, &invocation(&["version", "list"]), root.path()).unwrap(),
            format!("latest (global default, unresolved)\n\n{LOCAL_FOOTER}\n")
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_does_not_duplicate_the_global_role_through_a_home_directory_alias() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("real-home");
        let alias = root.path().join("aliased-home");
        atomic_json(
            &home.join(".uapkg/config.json"),
            &serde_json::json!({"launcher":{"defaultCliVersion":"1.2.3"}}),
        )
        .unwrap();
        std::os::unix::fs::symlink(&home, &alias).unwrap();
        let context = ContextPaths {
            home: alias.join(".uapkg"),
            executable: alias.join("uapkg"),
            receipt: None,
        };

        assert_eq!(
            local(
                &context,
                &invocation(&["version", "list"]),
                &home.canonicalize().unwrap(),
            )
            .unwrap(),
            format!("1.2.3 (global default, not installed)\n\n{LOCAL_FOOTER}\n")
        );
    }
}
