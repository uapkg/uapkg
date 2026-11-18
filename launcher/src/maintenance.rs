use crate::{
    catalog::{self, Index, Resolution},
    engines::{self, InstalledEngine},
    model::{exact_version, platform, read_json},
    release_age::{self, MinimumReleaseAge, automatic_candidate},
    storage::{ContextPaths, ExtraFields, atomic_json, lock, open_lock, preserve_json_fields},
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, TryLockError},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const DAY: u64 = 24 * 60 * 60;

#[derive(Default)]
pub(crate) struct PolicyRefresh {
    pub cli_fresh: bool,
    pub launcher_fresh: bool,
}

/// Discovery is independent of selectors and optional automatic upgrades. Known
/// signed policy is enforced even while offline or while another checker runs.
pub(crate) fn refresh_policy(context: &ContextPaths, offline: bool) -> Result<PolicyRefresh> {
    let cli = refresh_product(context, "cli", offline)?;
    if let Some(index) = catalog::index(context, "cli", true)?
        && let Err(error) = engines::purge_quarantined(context, &index)
    {
        eprintln!(
            "uapkg: Could not finish quarantined CLI cleanup; execution remains blocked for those versions. {error:#}"
        );
    }
    let launcher = refresh_product(context, "launcher", offline)?;
    if let Some(index) = catalog::index(context, "launcher", true)?
        && let Err(error) = crate::updater::purge_quarantined(context, &index)
    {
        eprintln!("uapkg: Could not finish quarantined launcher cleanup. {error:#}");
    }
    Ok(PolicyRefresh {
        cli_fresh: cli,
        launcher_fresh: launcher,
    })
}

fn refresh_product(context: &ContextPaths, product: &str, offline: bool) -> Result<bool> {
    refresh_product_with(context, product, offline, || {
        catalog::refresh_index(context, product)
    })
}

fn refresh_product_with(
    context: &ContextPaths,
    product: &str,
    offline: bool,
    refresh: impl FnOnce() -> Result<Index>,
) -> Result<bool> {
    catalog::index(context, product, true)?;
    if offline {
        return Ok(false);
    }
    let directory = if product == "cli" {
        cli_directory(context)
    } else {
        launcher_directory(context)
    };
    let Some(_attempt) = claim(&directory, false)? else {
        return Ok(false);
    };
    match refresh() {
        Ok(_) => Ok(true),
        Err(error) if crate::github::network_unavailable(&error) => {
            eprintln!(
                "uapkg: Could not refresh {product} release policy. Using verified cached policy. {error:#}"
            );
            Ok(false)
        }
        Err(error) => {
            Err(error).with_context(|| format!("Could not verify {product} release policy."))
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    last_attempt: u64,
    #[serde(flatten, default)]
    extra_fields: ExtraFields,
}

pub fn launcher_directory(context: &ContextPaths) -> PathBuf {
    let executable = context
        .executable
        .canonicalize()
        .unwrap_or_else(|_| context.executable.clone());
    let installation: String = Sha256::digest(executable.as_os_str().as_encoded_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    context
        .home
        .join("catalog/launcher/checks")
        .join(installation)
}

pub fn cli_directory(context: &ContextPaths) -> PathBuf {
    context.home.join("catalog/cli/checks")
}

/// Persist attempts before contacting the server so a failed check is also
/// throttled. Ordinary invocations can continue while another process updates.
pub fn claim(directory: &Path, force: bool) -> Result<Option<File>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    claim_at(directory, force, now)
}

fn claim_at(directory: &Path, force: bool, now: u64) -> Result<Option<File>> {
    let lock_path = directory.join("check.lock");
    let guard = if force {
        lock(&lock_path)?
    } else {
        let file = open_lock(&lock_path)?;
        match file.try_lock() {
            Ok(()) => file,
            Err(TryLockError::WouldBlock) => return Ok(None),
            Err(TryLockError::Error(error)) => {
                return Err(error).context("Could not lock the update check.");
            }
        }
    };
    let path = directory.join("check.json");
    if !force
        && let Ok(check) = read_json::<Check>(&path)
        && now
            .checked_sub(check.last_attempt)
            .is_some_and(|elapsed| elapsed < DAY)
    {
        return Ok(None);
    }
    let check = Check {
        last_attempt: now,
        extra_fields: ExtraFields::new(),
    };
    atomic_json(&path, &preserve_json_fields(&path, &check)?)?;
    Ok(Some(guard))
}

pub fn maintain_cli(
    context: &ContextPaths,
    resolution: &mut Resolution,
    auto_update: bool,
    fresh: bool,
    minimum_age: MinimumReleaseAge,
) -> Option<InstalledEngine> {
    let index = catalog::index(context, "cli", true).ok().flatten()?;
    maintain_cli_selected(
        context,
        resolution,
        auto_update && fresh,
        &index,
        minimum_age,
        release_age::now(),
        |version, index| engines::install_cli_update(context, version, index),
    )
}

#[cfg(test)]
fn maintain_cli_with(
    context: &ContextPaths,
    resolution: &mut Resolution,
    auto_update: bool,
    refresh: impl FnOnce() -> Result<Index>,
    install: impl FnOnce(&str, &Index) -> Result<InstalledEngine>,
) -> Option<InstalledEngine> {
    let guard = claim(&cli_directory(context), false).ok().flatten();
    let fresh = guard.as_ref().and_then(|_| refresh().ok());
    let can_install = auto_update && fresh.is_some();
    let index = fresh.or_else(|| catalog::index(context, "cli", true).ok().flatten())?;
    maintain_cli_selected(
        context,
        resolution,
        can_install,
        &index,
        MinimumReleaseAge::parse("0"),
        release_age::now(),
        install,
    )
}

fn maintain_cli_selected(
    context: &ContextPaths,
    resolution: &mut Resolution,
    can_install: bool,
    index: &Index,
    minimum_age: MinimumReleaseAge,
    now: Option<jiff::Timestamp>,
    install: impl FnOnce(&str, &Index) -> Result<InstalledEngine>,
) -> Option<InstalledEngine> {
    // Never reintroduce a revoked active version after required fallback.
    if let Ok(Some(active)) = catalog::active_version(context, "cli", "latest")
        && index.ensure_runnable(&active).is_ok()
    {
        resolution.version = active;
    }
    let latest = index.aliases.get("latest")?;
    let current = exact_version(&resolution.version).ok()?;
    if !exact_version(latest).ok()?.cmp_precedence(&current).is_gt() {
        return None;
    }

    if can_install
        && let Some(next) = automatic_candidate(
            index,
            "latest",
            &resolution.version,
            platform().ok()?,
            minimum_age,
            now,
        )
    {
        let update = Resolution {
            requested: "latest".into(),
            version: next.into(),
            messages: vec![],
        };
        if let Ok(installed) = install(next, index)
            && catalog::activate(context, "cli", &update).is_ok()
        {
            resolution.version = catalog::active_version(context, "cli", "latest")
                .ok()
                .flatten()
                .unwrap_or(update.version);
            return (installed.engine.version == resolution.version).then_some(installed);
        }
        resolution
            .messages
            .push("Could not automatically update the UAPKG CLI.".into());
    }
    resolution.messages.extend([
        format!(
            "A new UAPKG CLI update is available. {} -> {latest}",
            resolution.version
        ),
        "Use `uapkg version install latest` to install it.".into(),
    ]);
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::bail;

    #[test]
    fn daily_policy_checks_are_independent_of_selectors_and_offline_never_refreshes() {
        let directory = tempfile::tempdir().unwrap();
        let context = ContextPaths {
            home: directory.path().join("profile"),
            executable: directory.path().join("uapkg"),
            receipt: None,
        };
        let index = catalog::cache_moderated_fixture(&context, "cli");
        assert!(
            !refresh_product_with(&context, "cli", true, || panic!(
                "Offline policy must use signed cached state"
            ))
            .unwrap()
        );
        assert!(!cli_directory(&context).exists());
        assert!(refresh_product_with(&context, "cli", false, || Ok(index)).unwrap());
        assert!(
            !refresh_product_with(&context, "cli", false, || panic!(
                "Policy refresh must be daily"
            ))
            .unwrap()
        );
        assert!(
            refresh_product_with(&context, "launcher", false, || bail!("invalid signature"))
                .is_err()
        );
        assert!(
            !refresh_product_with(&context, "launcher", false, || panic!(
                "A failed attempt is also paced"
            ))
            .unwrap()
        );
    }

    fn cli_fixture(root: &Path) -> (ContextPaths, Resolution, Index) {
        let context = ContextPaths {
            home: root.to_owned(),
            executable: root.join("uapkg"),
            receipt: None,
        };
        let active = Resolution {
            requested: "latest".into(),
            version: "1.9.0".into(),
            messages: vec![],
        };
        let mut index: Index =
            serde_json::from_str(include_str!("../../tools/release/fixtures/index.json")).unwrap();
        index
            .releases
            .iter_mut()
            .find(|release| release.version == index.aliases["latest"])
            .unwrap()
            .files = vec![platform().unwrap().into()];
        index.validate("cli").unwrap();
        catalog::activate(&context, "cli", &active).unwrap();
        (context, active, index)
    }

    #[test]
    fn checks_are_due_daily_and_manual_attempts_reset_the_interval() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path();
        let first = claim_at(path, false, 10)?.unwrap();
        assert!(claim_at(path, false, 10 + DAY)?.is_none());
        drop(first);
        assert!(claim_at(path, false, 10 + DAY - 1)?.is_none());
        assert!(claim_at(path, false, 10 + DAY)?.is_some());
        assert!(claim_at(path, true, 20 + DAY)?.is_some());
        assert!(claim_at(path, false, 19 + 2 * DAY)?.is_none());
        assert!(claim_at(path, false, 20 + 2 * DAY)?.is_some());
        // A clock correction must not suppress checks until a future date.
        assert!(claim_at(path, false, 1)?.is_some());
        Ok(())
    }

    #[test]
    fn check_writeback_preserves_unknown_fields_during_due_forced_and_repair_writes() -> Result<()>
    {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("check.json");
        let future = serde_json::json!({"nested":[null, false, {"keep":"value"}]});
        atomic_json(
            &path,
            &serde_json::json!({"lastAttempt":10,"future":future}),
        )?;
        let before = std::fs::read(&path)?;
        assert!(claim_at(directory.path(), false, 11)?.is_none());
        assert_eq!(std::fs::read(&path)?, before);
        drop(claim_at(directory.path(), false, 10 + DAY)?.unwrap());
        let check: Check = read_json(&path)?;
        assert_eq!(check.last_attempt, 10 + DAY);
        assert_eq!(check.extra_fields["future"], future);
        drop(claim_at(directory.path(), true, 12)?.unwrap());
        assert_eq!(read_json::<Check>(&path)?.extra_fields["future"], future);

        atomic_json(
            &path,
            &serde_json::json!({"lastAttempt":"invalid","future":future}),
        )?;
        assert!(read_json::<Check>(&path).is_err());
        drop(claim_at(directory.path(), false, 13)?.unwrap());
        let check: Check = read_json(&path)?;
        assert_eq!(check.last_attempt, 13);
        assert_eq!(check.extra_fields["future"], future);
        std::fs::write(&path, b"malformed JSON")?;
        drop(claim_at(directory.path(), true, 14)?.unwrap());
        assert_eq!(read_json::<Check>(&path)?.last_attempt, 14);
        assert!(serde_json::from_value::<Check>(serde_json::json!({"future":true})).is_err());
        Ok(())
    }

    #[test]
    fn disabled_and_failed_cli_updates_keep_the_active_version() -> Result<()> {
        for auto_update in [false, true] {
            let directory = tempfile::tempdir()?;
            let (context, mut active, index) = cli_fixture(directory.path());
            let mut attempted = false;
            assert!(
                maintain_cli_with(
                    &context,
                    &mut active,
                    auto_update,
                    || Ok(index),
                    |_, _| {
                        attempted = true;
                        bail!("Artifact verification failed.")
                    },
                )
                .is_none()
            );
            assert_eq!(attempted, auto_update);
            assert_eq!(active.version, "1.9.0");
            assert!(
                active
                    .messages
                    .iter()
                    .any(|line| line.contains("1.9.0 -> 2.0.0"))
            );
            assert_eq!(
                catalog::active_version(&context, "cli", "latest")?.as_deref(),
                Some("1.9.0")
            );
            assert!(
                maintain_cli_with(
                    &context,
                    &mut active,
                    auto_update,
                    || panic!("A failed attempt must wait until the next interval"),
                    |_, _| panic!("An optional install requires fresh metadata"),
                )
                .is_none()
            );
        }
        Ok(())
    }

    #[test]
    fn cli_update_advances_the_active_version_only_after_installing() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let (context, mut active, index) = cli_fixture(directory.path());
        let config = context.home.join("config.json");
        let settings = r#"{"launcher":{"defaultCliVersion":"latest"}}"#;
        std::fs::write(&config, settings)?;
        let installed = maintain_cli_with(
            &context,
            &mut active,
            true,
            || Ok(index),
            |version, _| {
                assert_eq!(
                    catalog::active_version(&context, "cli", "latest")?.as_deref(),
                    Some("1.9.0")
                );
                Ok(InstalledEngine {
                    root: directory.path().join(version),
                    engine: crate::model::Engine {
                        schema_version: 1,
                        version: version.into(),
                        platform: platform()?.into(),
                        kind: "sea".into(),
                        executable: "uapkg".into(),
                        args: vec![],
                        extra_fields: ExtraFields::new(),
                    },
                })
            },
        )
        .unwrap();
        assert_eq!(active.version, "2.0.0");
        assert_eq!(installed.engine.version, active.version);
        assert_eq!(std::fs::read_to_string(config)?, settings);
        // An in-flight invocation retaining the old version cannot undo this update.
        catalog::activate(
            &context,
            "cli",
            &Resolution {
                requested: "latest".into(),
                version: "1.9.0".into(),
                messages: vec![],
            },
        )?;
        assert_eq!(
            catalog::active_version(&context, "cli", "latest")?.as_deref(),
            Some("2.0.0")
        );
        Ok(())
    }

    #[test]
    fn cli_maintenance_installs_an_eligible_intermediate_and_keeps_latest_intent() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let (context, mut active, mut index) = cli_fixture(directory.path());
        index
            .releases
            .iter_mut()
            .find(|release| release.version == "2.0.0")
            .unwrap()
            .date = "2026-11-18T12:00:00Z".into();
        index.releases.push(catalog::Release {
            version: "1.10.0".into(),
            date: "2026-11-15T12:00:00Z".into(),
            files: vec![platform()?.into()],
            yanked: None,
            quarantined: None,
            extra_fields: ExtraFields::new(),
        });
        let now = Some("2026-11-18T12:00:00Z".parse().unwrap());
        let installed = maintain_cli_selected(
            &context,
            &mut active,
            true,
            &index,
            MinimumReleaseAge::parse("3d"),
            now,
            |version, _| {
                assert_eq!(version, "1.10.0");
                Ok(InstalledEngine {
                    root: directory.path().join(version),
                    engine: crate::model::Engine {
                        schema_version: 1,
                        version: version.into(),
                        platform: platform()?.into(),
                        kind: "sea".into(),
                        executable: "uapkg".into(),
                        args: vec![],
                        extra_fields: ExtraFields::new(),
                    },
                })
            },
        )
        .unwrap();
        assert_eq!(installed.engine.version, "1.10.0");
        assert_eq!(active.version, "1.10.0");
        assert_eq!(active.requested, "latest");
        assert_eq!(index.aliases["latest"], "2.0.0");
        assert!(
            maintain_cli_selected(
                &context,
                &mut active,
                true,
                &index,
                MinimumReleaseAge::parse("3d"),
                now,
                |_, _| panic!(
                    "A young latest must not replace the already installed eligible version"
                ),
            )
            .is_none()
        );
        assert_eq!(active.version, "1.10.0");
        assert!(
            active
                .messages
                .iter()
                .any(|message| message.contains("1.10.0 -> 2.0.0"))
        );
        assert!(
            !active
                .messages
                .iter()
                .any(|message| message.contains("Could not automatically"))
        );
        Ok(())
    }
}
