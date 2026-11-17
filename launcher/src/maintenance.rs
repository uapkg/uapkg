use crate::{
    catalog::{self, Index, Resolution},
    engines::{self, InstalledEngine},
    model::{exact_version, platform, read_json},
    storage::{ContextPaths, atomic_json, lock, open_lock},
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    last_attempt: u64,
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
    atomic_json(&path, &Check { last_attempt: now })?;
    Ok(Some(guard))
}

pub fn maintain_cli(
    context: &ContextPaths,
    resolution: &mut Resolution,
    auto_update: bool,
) -> Option<InstalledEngine> {
    maintain_cli_with(
        context,
        resolution,
        auto_update,
        || catalog::refresh_index(context, "cli"),
        |version, index| engines::install_cli_update(context, version, index),
    )
}

fn maintain_cli_with(
    context: &ContextPaths,
    resolution: &mut Resolution,
    auto_update: bool,
    refresh: impl FnOnce() -> Result<Index>,
    install: impl FnOnce(&str, &Index) -> Result<InstalledEngine>,
) -> Option<InstalledEngine> {
    let guard = claim(&cli_directory(context), false).ok().flatten();
    // Another invocation may have advanced latest after this one read it.
    if let Ok(Some(active)) = catalog::active_version(context, "cli", "latest") {
        resolution.version = active;
    }
    let fresh = guard.as_ref().and_then(|_| refresh().ok());
    let can_install = auto_update && fresh.is_some();
    let index = fresh.or_else(|| catalog::index(context, "cli", true).ok().flatten())?;
    let latest = index.aliases.get("latest")?;
    let current = exact_version(&resolution.version).ok()?;
    if !exact_version(latest).ok()?.cmp_precedence(&current).is_gt()
        || index.supports(latest, platform().ok()?).is_err()
    {
        return None;
    }

    if can_install {
        let update = Resolution {
            requested: "latest".into(),
            version: latest.clone(),
            messages: vec![],
        };
        if let Ok(installed) = install(latest, &index)
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
}
