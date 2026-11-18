use crate::{
    archive, catalog, diagnostics, github,
    model::{Engine, exact_version, platform, read_json, relative_path},
    storage::{ContextPaths, atomic_json, lock},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installation {
    schema_version: u32,
    version: String,
    platform: String,
}

pub struct InstalledEngine {
    pub root: PathBuf,
    pub engine: Engine,
}

fn version_lock(context: &ContextPaths, version: &str) -> Result<fs::File> {
    lock(
        &context
            .home
            .join("locks")
            .join(format!("cli-{version}.lock")),
    )
}

fn known_policy(context: &ContextPaths, version: &str) -> Result<()> {
    if let Some(index) = catalog::index(context, "cli", true)? {
        index.ensure_runnable(version)?;
    }
    Ok(())
}

fn cleanup_lock(context: &ContextPaths, version: &str) -> Result<Option<fs::File>> {
    let guard = crate::storage::try_lock(
        &context
            .home
            .join("locks")
            .join(format!("cli-{version}.lock")),
    )?;
    if guard.is_none() {
        eprintln!(
            "uapkg: Cleanup of quarantined CLI {version} is deferred while another installation is active."
        );
    }
    Ok(guard)
}

fn managed_directory(context: &ContextPaths, path: &Path) -> Result<()> {
    let home = context.home.canonicalize()?;
    ensure!(
        path.canonicalize()?.starts_with(&home),
        "Refusing cache cleanup outside {}.",
        home.display()
    );
    ensure!(
        !fs::symlink_metadata(path)?.file_type().is_symlink(),
        "Refusing cache cleanup through a symbolic link: {}.",
        path.display()
    );
    Ok(())
}

fn retire_directory(context: &ContextPaths, source: &Path, version: &str) -> Result<()> {
    managed_directory(context, source)?;
    if fs::remove_dir_all(source).is_ok() {
        return Ok(());
    }
    let pending = context.home.join("quarantine-removals");
    if pending.exists() {
        managed_directory(context, &pending)?;
    }
    let retired = pending.join(version);
    fs::create_dir_all(&retired)?;
    managed_directory(context, &pending)?;
    managed_directory(context, &retired)?;
    let temporary = tempfile::Builder::new()
        .prefix("engine-")
        .tempdir_in(&retired)?;
    fs::rename(source, temporary.path().join("engine"))
        .with_context(|| format!("Could not remove quarantined CLI {version} from its managed cache. Close processes using it and retry."))?;
    let path = temporary.keep();
    if fs::remove_dir_all(&path).is_err() {
        eprintln!(
            "uapkg: Removed quarantined CLI {version} from the executable cache; remaining files will be deleted after existing processes exit."
        );
    }
    Ok(())
}

fn purge_staging(context: &ContextPaths, index: &catalog::Index) -> Result<()> {
    let staging = context.home.join("staging");
    if !staging.exists() {
        return Ok(());
    }
    managed_directory(context, &staging)?;
    for entry in fs::read_dir(&staging)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with("engine-")
            || !entry.file_type()?.is_dir()
        {
            continue;
        }
        managed_directory(context, &entry.path())?;
        let version = read_json::<Installation>(&entry.path().join(".release.json"))
            .ok()
            .filter(|record| record.schema_version == 1)
            .map(|record| record.version)
            .or_else(|| {
                let root = entry.path().join("engine");
                root.canonicalize().ok().filter(|path| {
                    path.starts_with(entry.path().canonicalize().unwrap_or_default())
                })?;
                read_json::<Engine>(&root.join("engine.json"))
                    .ok()
                    .map(|engine| engine.version)
            });
        let Some(version) = version else {
            continue;
        };
        if exact_version(&version).is_err()
            || !index
                .release(&version)
                .is_some_and(|release| release.quarantined.is_some())
        {
            continue;
        }
        let Some(_guard) = cleanup_lock(context, &version)? else {
            continue;
        };
        if entry.path().exists() {
            retire_directory(context, &entry.path(), &version)?;
        }
    }
    Ok(())
}

/// Purge every platform, including historical platforms. A Windows executable
/// already in use can be retired from the executable cache and retried later.
pub fn purge_quarantined(context: &ContextPaths, index: &catalog::Index) -> Result<()> {
    let pending = context.home.join("quarantine-removals");
    if pending.exists() {
        managed_directory(context, &pending)?;
        for entry in fs::read_dir(&pending)? {
            let entry = entry?;
            let version = entry.file_name().to_string_lossy().into_owned();
            if exact_version(&version).is_err() {
                continue;
            }
            let Some(_guard) = cleanup_lock(context, &version)? else {
                continue;
            };
            managed_directory(context, &entry.path())?;
            if fs::remove_dir_all(entry.path()).is_err() {
                eprintln!(
                    "uapkg: Quarantined CLI {version} is awaiting cleanup; close any processes using it and run UAPKG again."
                );
            }
        }
    }
    purge_staging(context, index)?;
    let engines = context.home.join("engines");
    if !engines.exists() {
        return Ok(());
    }
    managed_directory(context, &engines)?;
    for release in &index.releases {
        if release.quarantined.is_none() {
            continue;
        }
        exact_version(&release.version)?;
        let Some(_guard) = cleanup_lock(context, &release.version)? else {
            continue;
        };
        let source = engines.join(&release.version);
        let metadata = match fs::symlink_metadata(&source) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            fs::remove_file(&source)?;
            continue;
        }
        retire_directory(context, &source, &release.version)?;
    }
    Ok(())
}

fn cached(root: &Path, version: &str, platform: &str) -> Result<InstalledEngine> {
    let receipt: Installation = read_json(&root.join(".installed.json"))?;
    ensure!(
        receipt.schema_version == 1 && receipt.version == version && receipt.platform == platform,
        "CLI cache receipt does not match the selected engine. Remove the damaged directory {} and retry.",
        root.display()
    );
    let engine = Engine::read(root, version, platform)?;
    Ok(InstalledEngine {
        root: root.to_path_buf(),
        engine,
    })
}

pub fn ensure_installed(
    context: &ContextPaths,
    version: &str,
    offline: bool,
) -> Result<InstalledEngine> {
    ensure_installed_with_reason(context, version, offline, None)
}

pub(crate) fn ensure_installed_with_reason(
    context: &ContextPaths,
    version: &str,
    offline: bool,
    reason: Option<&str>,
) -> Result<InstalledEngine> {
    install_release(context, version, offline, reason, None)
}

pub(crate) fn install_cli_update(
    context: &ContextPaths,
    version: &str,
    index: &catalog::Index,
) -> Result<InstalledEngine> {
    install_release(context, version, false, None, Some(index))
}

fn install_release(
    context: &ContextPaths,
    version: &str,
    offline: bool,
    reason: Option<&str>,
    verified_index: Option<&catalog::Index>,
) -> Result<InstalledEngine> {
    exact_version(version)?;
    let target = platform()?;
    let published = if verified_index.is_none() {
        let cached = catalog::index(context, "cli", true)?;
        if cached.is_none() && !offline && !context.cache_dir(version, target)?.exists() {
            catalog::index(context, "cli", false)?
        } else {
            cached
        }
    } else {
        None
    };
    let verified_index = verified_index.or(published.as_ref());
    if let Some(index) = verified_index {
        if let Err(error) = purge_quarantined(context, index) {
            eprintln!("uapkg: Could not finish quarantined CLI cleanup. {error:#}");
        }
        index.ensure_runnable(version)?;
    }
    install_cached(context, version, offline, |stage| {
        let client = if let Some(index) = verified_index {
            index.supports(version, target)?;
            github::client_with_timeout(Duration::from_secs(30))?
        } else {
            let index = match catalog::index(context, "cli", true)? {
                Some(index) => index,
                None => catalog::index(context, "cli", false)?
                    .context("No verified CLI index is available.")?,
            };
            index.ensure_runnable(version)?;
            index.supports(version, target)?;
            github::client()?
        };
        let progress = format!("Installing UAPKG CLI {version}...");
        if let Some(reason) = reason {
            eprintln!("{reason}\n{progress}");
        } else {
            eprintln!("{progress}");
        }
        let archive_path = stage.join("engine.tar.gz");
        github::download_artifact(&client, "cli", version, target, &archive_path)?;
        let root = stage.join("engine");
        archive::extract(&archive_path, &root)?;
        Ok(root)
    })
}

/// The provider must authenticate its download before returning a staged engine.
/// Cache locking, validation, and activation are shared by all installations;
/// tests substitute only the downloader, never the lock or activation behavior.
pub(crate) fn install_cached(
    context: &ContextPaths,
    version: &str,
    offline: bool,
    install: impl FnOnce(&Path) -> Result<PathBuf>,
) -> Result<InstalledEngine> {
    exact_version(version)?;
    known_policy(context, version)?;
    let target = platform()?;
    let destination = context.cache_dir(version, target)?;
    if destination.exists() {
        let _guard = version_lock(context, version)?;
        known_policy(context, version)?;
        return cached(&destination, version, target);
    }
    ensure!(
        !offline,
        "CLI {version} is not cached for {target}. Offline mode prevents downloading it. Disable offline mode and retry to install this version; no other version will be substituted."
    );
    let _version_lock = version_lock(context, version)?;
    let _lock = lock(
        &context
            .home
            .join("locks")
            .join(format!("cli-{version}-{target}.lock")),
    )?;
    known_policy(context, version)?;
    if destination.exists() {
        return cached(&destination, version, target);
    }
    let staging_parent = context.home.join("staging");
    fs::create_dir_all(&staging_parent)?;
    let temporary = tempfile::Builder::new()
        .prefix("engine-")
        .tempdir_in(&staging_parent)?;
    atomic_json(
        &temporary.path().join(".release.json"),
        &Installation {
            schema_version: 1,
            version: version.into(),
            platform: target.into(),
        },
    )?;
    let root = install(temporary.path())?;
    known_policy(context, version)?;
    ensure!(
        root.canonicalize()?
            .starts_with(temporary.path().canonicalize()?),
        "An engine must be staged inside its installation transaction."
    );
    Engine::read(&root, version, target)?;
    atomic_json(
        &root.join(".installed.json"),
        &Installation {
            schema_version: 1,
            version: version.to_owned(),
            platform: target.to_owned(),
        },
    )?;
    fs::create_dir_all(
        destination
            .parent()
            .context("Cache directory has no parent.")?,
    )?;
    fs::rename(&root, &destination).context(
        "Could not activate the downloaded CLI. Existing CLI versions were left unchanged.",
    )?;
    cached(&destination, version, target)
}

pub fn list(context: &ContextPaths) -> Result<Vec<String>> {
    let mut results = Vec::new();
    let target = platform()?;
    let base = context.home.join("engines");
    if !base.exists() {
        return Ok(results);
    }
    for entry in fs::read_dir(base)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let version = entry.file_name().to_string_lossy().into_owned();
        if exact_version(&version).is_err() {
            continue;
        }
        let root = entry.path().join(target);
        if fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.is_dir())
            && cached(&root, &version, target).is_ok()
        {
            results.push(version);
        }
    }
    results.sort();
    Ok(results)
}

pub fn delegate(
    context: &ContextPaths,
    installed: &InstalledEngine,
    args: &[OsString],
    diagnostic: Option<&diagnostics::LauncherContext>,
    notices: &[String],
) -> Result<i32> {
    known_policy(context, &installed.engine.version)?;
    let mut command = Command::new(
        installed
            .root
            .join(relative_path(&installed.engine.executable)?),
    );
    catalog::apply_notices(&mut command, notices)?;
    if !notices.is_empty() {
        let mut stderr = std::io::stderr().lock();
        for notice in notices {
            let _ = writeln!(stderr, "uapkg: {notice}");
        }
        let _ = writeln!(stderr);
    }
    for arg in &installed.engine.args {
        command.arg(installed.root.join(relative_path(arg)?));
    }
    command
        .args(args)
        .env("UAPKG_LAUNCHER_VERSION", crate::model::VERSION)
        .env("UAPKG_LAUNCHER_EXECUTABLE", &context.executable)
        .env("UAPKG_CLI_VERSION", &installed.engine.version);
    execute(command, diagnostic)
}

pub fn execute(
    mut command: Command,
    diagnostic: Option<&diagnostics::LauncherContext>,
) -> Result<i32> {
    diagnostics::apply(&mut command, diagnostic)?;
    command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    // Replacing the launcher preserves process identity and all Unix signal and
    // terminal semantics. No pipe/proxy or shell ever sits between user and CLI.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec()).context("Could not start the selected UAPKG CLI.")
    }
    #[cfg(windows)]
    {
        // Both processes share the console. Let Node handle Ctrl+C; the parent
        // waits so that it returns the child's actual status instead of exiting
        // first and leaving a live CLI behind.
        crate::updater::windows_console_handler()?;
        let status = command
            .status()
            .context("Could not start the selected UAPKG CLI.")?;
        Ok(status.code().unwrap_or(1))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Ok(command.status()?.code().unwrap_or(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };
    use std::time::Duration;

    fn context(directory: &Path) -> ContextPaths {
        ContextPaths {
            home: directory.join("profile"),
            executable: directory.join("launcher"),
            receipt: None,
        }
    }

    fn stage_engine(stage: &Path, version: &str) -> Result<PathBuf> {
        let root = stage.join("engine");
        fs::create_dir_all(&root)?;
        let executable = if cfg!(windows) {
            "test-engine.exe"
        } else {
            "test-engine"
        };
        // A real executable lets the failed-download test prove that the
        // previously installed engine still starts, not just that files exist.
        fs::copy(std::env::current_exe()?, root.join(executable))?;
        atomic_json(
            &root.join("engine.json"),
            &Engine {
                schema_version: 1,
                version: version.to_owned(),
                platform: platform()?.to_owned(),
                kind: "sea".to_owned(),
                executable: executable.to_owned(),
                args: Vec::new(),
            },
        )?;
        Ok(root)
    }

    #[test]
    fn known_signed_policy_blocks_cached_and_missing_marked_engines_before_provider() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        for version in ["1.7.0", "1.7.1", "1.7.2"] {
            install_cached(&context, version, false, |stage| {
                stage_engine(stage, version)
            })
            .unwrap();
        }
        let foreign = context.cache_dir("1.7.2", "win32-arm64").unwrap();
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("binary"), b"quarantined bytes").unwrap();
        let index = catalog::cache_moderated_fixture(&context, "cli");
        for (name, version) in [("engine-marked", "1.7.2"), ("engine-yanked", "1.7.1")] {
            let stage = context.home.join("staging").join(name);
            atomic_json(
                &stage.join(".release.json"),
                &Installation {
                    schema_version: 1,
                    version: version.into(),
                    platform: platform().unwrap().into(),
                },
            )
            .unwrap();
            fs::write(stage.join("engine.tar.gz"), b"abandoned archive").unwrap();
        }
        let unknown = context.home.join("staging/engine-unknown");
        fs::create_dir_all(&unknown).unwrap();
        fs::write(unknown.join("engine.tar.gz"), b"unknown archive").unwrap();
        let legacy = context.home.join("staging/engine-legacy");
        stage_engine(&legacy, "1.7.2").unwrap();
        for version in ["1.7.1", "1.7.2"] {
            for offline in [false, true] {
                let error = install_cached(&context, version, offline, |_| {
                    panic!("A marked version must never reach its acquisition provider")
                })
                .err()
                .unwrap();
                assert!(error.to_string().contains("Execution is refused"));
            }
        }
        purge_quarantined(&context, &index).unwrap();
        assert!(!context.home.join("engines/1.7.2").exists());
        assert!(!context.home.join("staging/engine-marked").exists());
        assert!(!legacy.exists());
        assert!(context.home.join("staging/engine-yanked").exists());
        assert!(unknown.exists());
        assert!(
            context
                .cache_dir("1.7.1", platform().unwrap())
                .unwrap()
                .exists()
        );
        assert!(ensure_installed(&context, "1.7.0", true).is_ok());
        assert!(ensure_installed(&context, "1.7.2", false).is_err());
        assert!(!context.home.join("engines/1.7.2").exists());
    }

    #[test]
    fn cleanup_defers_active_installations_without_allowing_the_marked_version() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        let index = catalog::cache_moderated_fixture(&context, "cli");
        let root = context.home.join("engines/1.7.2");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("binary"), b"quarantined").unwrap();
        let guard = version_lock(&context, "1.7.2").unwrap();
        purge_quarantined(&context, &index).unwrap();
        assert!(root.exists());
        assert!(ensure_installed(&context, "1.7.2", true).is_err());
        drop(guard);
        purge_quarantined(&context, &index).unwrap();
        assert!(!root.exists());
    }

    #[cfg(unix)]
    #[test]
    fn quarantine_cleanup_refuses_an_engines_parent_outside_the_profile() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        fs::create_dir_all(&context.home).unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir_all(outside.join("1.7.2")).unwrap();
        fs::write(outside.join("1.7.2/keep"), b"do not delete").unwrap();
        std::os::unix::fs::symlink(&outside, context.home.join("engines")).unwrap();
        let index = catalog::cache_moderated_fixture(&context, "cli");
        assert!(purge_quarantined(&context, &index).is_err());
        assert!(outside.join("1.7.2/keep").exists());
    }

    #[test]
    fn incompatible_cache_entries_are_not_renamed_or_used_as_platform_fallbacks() {
        let target = platform().unwrap();
        let mut incompatible = vec!["win32-x64", "win32-arm64"];
        if target == "linux-x64-musl" {
            incompatible.push("linux-x64");
        }
        for previous_target in incompatible {
            let directory = tempfile::tempdir().unwrap();
            let context = context(directory.path());
            let staged = stage_engine(directory.path(), "1.2.3").unwrap();
            let mut descriptor: Engine = read_json(&staged.join("engine.json")).unwrap();
            descriptor.platform = previous_target.into();
            atomic_json(&staged.join("engine.json"), &descriptor).unwrap();
            atomic_json(
                &staged.join(".installed.json"),
                &Installation {
                    schema_version: 1,
                    version: "1.2.3".into(),
                    platform: previous_target.into(),
                },
            )
            .unwrap();
            let previous = context.cache_dir("1.2.3", previous_target).unwrap();
            fs::create_dir_all(previous.parent().unwrap()).unwrap();
            fs::rename(staged, &previous).unwrap();
            let original_descriptor = fs::read(previous.join("engine.json")).unwrap();
            let original_receipt = fs::read(previous.join(".installed.json")).unwrap();

            let error = ensure_installed(&context, "1.2.3", true)
                .err()
                .expect("An incompatible cache must not satisfy the selected platform");
            assert!(
                error
                    .to_string()
                    .contains(&format!("not cached for {target}"))
            );
            assert!(!context.cache_dir("1.2.3", target).unwrap().exists());
            assert!(cached(&previous, "1.2.3", target).is_err());
            assert!(Engine::read(&previous, "1.2.3", target).is_err());
            assert_eq!(
                fs::read(previous.join("engine.json")).unwrap(),
                original_descriptor
            );
            assert_eq!(
                fs::read(previous.join(".installed.json")).unwrap(),
                original_receipt
            );
        }
    }

    #[test]
    fn concurrent_installers_share_one_provider_and_activate_only_a_complete_engine() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        let provider_calls = AtomicUsize::new(0);
        let destination = context.cache_dir("1.2.3", platform().unwrap()).unwrap();
        let (staging_ready, ready) = mpsc::channel();
        let (finish_staging, finish) = mpsc::channel();
        let (second_started, started) = mpsc::channel();

        std::thread::scope(|scope| {
            let context_ref = &context;
            let calls = &provider_calls;
            let first = scope.spawn(move || {
                install_cached(context_ref, "1.2.3", false, |stage| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    fs::write(stage.join("download.part"), b"incomplete download")?;
                    staging_ready.send(()).unwrap();
                    finish.recv_timeout(Duration::from_secs(5)).unwrap();
                    stage_engine(stage, "1.2.3")
                })
            });
            ready.recv_timeout(Duration::from_secs(5)).unwrap();
            let second = scope.spawn(move || {
                second_started.send(()).unwrap();
                install_cached(context_ref, "1.2.3", false, |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    anyhow::bail!("A concurrent waiter must use the winner's installation.")
                })
            });
            started.recv_timeout(Duration::from_secs(5)).unwrap();
            let lock_path = context
                .home
                .join("locks")
                .join(format!("cli-1.2.3-{}.lock", platform().unwrap()));
            let contender = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(lock_path)
                .unwrap();
            assert!(
                contender.try_lock().is_err(),
                "The installer must hold its real OS lock while staging."
            );
            assert!(
                !destination.exists(),
                "Incomplete staging must never become a selected engine."
            );
            assert!(list(&context).unwrap().is_empty());
            finish_staging.send(()).unwrap();
            let winner = first.join().unwrap().unwrap();
            let waiter = second.join().unwrap().unwrap();
            assert_eq!(winner.root, destination);
            assert_eq!(waiter.root, destination);
            assert_eq!(winner.engine.version, "1.2.3");
            assert_eq!(waiter.engine.version, "1.2.3");
        });
        assert_eq!(provider_calls.load(Ordering::SeqCst), 1);
        assert!(destination.join(".installed.json").is_file());
        assert!(cached(&destination, "1.2.3", platform().unwrap()).is_ok());
        assert_eq!(
            fs::read_dir(context.home.join("staging")).unwrap().count(),
            0
        );
    }

    #[test]
    fn an_interrupted_download_cannot_replace_or_hide_a_working_version() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        let previous = install_cached(&context, "1.2.3", false, |stage| {
            stage_engine(stage, "1.2.3")
        })
        .unwrap();
        fs::write(
            context.home.join("config.json"),
            r#"{"launcher":{"defaultCliVersion":"1.2.3"}}"#,
        )
        .unwrap();
        let executable = previous.root.join(&previous.engine.executable);
        let original_hash = archive::sha256(&executable).unwrap();
        let failed = install_cached(&context, "2.0.0", false, |stage| {
            fs::write(stage.join("download.part"), b"truncated artifact bytes")?;
            Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Connection closed during artifact download",
            )
            .into())
        });
        assert!(failed.is_err());
        assert!(
            !context
                .cache_dir("2.0.0", platform().unwrap())
                .unwrap()
                .exists()
        );
        assert_eq!(
            fs::read_dir(context.home.join("staging")).unwrap().count(),
            0
        );
        assert_eq!(
            context.settings().unwrap().default_cli_version.as_deref(),
            Some("1.2.3")
        );
        assert_eq!(archive::sha256(&executable).unwrap(), original_hash);
        assert!(
            Command::new(&executable)
                .arg("--list")
                .output()
                .unwrap()
                .status
                .success()
        );
        assert_eq!(list(&context).unwrap().len(), 1);

        // An abruptly terminated process can leave staging files behind. They
        // are never searched as installed versions, even if structurally valid.
        let orphan = context.home.join("staging/engine-interrupted");
        stage_engine(&orphan, "2.0.0").unwrap();
        assert!(
            install_cached(&context, "2.0.0", true, |_| panic!(
                "Offline mode must not call a provider"
            ))
            .is_err()
        );
        assert!(
            install_cached(&context, "1.2.3", true, |_| panic!(
                "Cached execution must not call a provider"
            ))
            .is_ok()
        );
        let retry = install_cached(&context, "2.0.0", false, |stage| {
            stage_engine(stage, "2.0.0")
        })
        .unwrap();
        assert_eq!(retry.engine.version, "2.0.0");
        assert_eq!(archive::sha256(&executable).unwrap(), original_hash);
    }
}
