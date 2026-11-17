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
    install_cached(context, version, offline, |stage| {
        let client = if let Some(index) = verified_index {
            index.supports(version, target)?;
            github::client_with_timeout(Duration::from_secs(30))?
        } else {
            catalog::index(context, "cli", false)?
                .context("No verified CLI index is available.")?
                .supports(version, target)?;
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
fn install_cached(
    context: &ContextPaths,
    version: &str,
    offline: bool,
    install: impl FnOnce(&Path) -> Result<PathBuf>,
) -> Result<InstalledEngine> {
    exact_version(version)?;
    let target = platform()?;
    let destination = context.cache_dir(version, target)?;
    if destination.exists() {
        return cached(&destination, version, target);
    }
    ensure!(
        !offline,
        "CLI {version} is not cached for {target}. Run `uapkg version install {version}` while online; no other version will be substituted."
    );
    let _lock = lock(
        &context
            .home
            .join("locks")
            .join(format!("cli-{version}-{target}.lock")),
    )?;
    if destination.exists() {
        return cached(&destination, version, target);
    }
    let staging_parent = context.home.join("staging");
    fs::create_dir_all(&staging_parent)?;
    let temporary = tempfile::Builder::new()
        .prefix("engine-")
        .tempdir_in(&staging_parent)?;
    let root = install(temporary.path())?;
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

pub fn list(context: &ContextPaths) -> Result<Vec<(String, String)>> {
    let mut results = Vec::new();
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
        for target in fs::read_dir(entry.path())? {
            let target = target?;
            if !target.file_type()?.is_dir() {
                continue;
            }
            let platform = target.file_name().to_string_lossy().into_owned();
            if cached(&target.path(), &version, &platform).is_ok() {
                results.push((version.clone(), platform));
            }
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
