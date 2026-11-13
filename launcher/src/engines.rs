use crate::{
    archive, diagnostics, github,
    model::{Engine, Source, exact_version, platform, read_json, relative_path},
    npm,
    storage::{ContextPaths, atomic_json, lock},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installation {
    schema_version: u32,
    source: Source,
    version: String,
    platform: String,
}

pub struct InstalledEngine {
    pub root: PathBuf,
    pub engine: Engine,
}

fn cached(root: &Path, source: Source, version: &str, platform: &str) -> Result<InstalledEngine> {
    let receipt: Installation = read_json(&root.join(".installed.json"))?;
    ensure!(
        receipt.schema_version == 1
            && receipt.source == source
            && receipt.version == version
            && receipt.platform == platform,
        "CLI cache receipt does not match the selected engine. Remove the damaged directory {} and retry.",
        root.display()
    );
    let engine = Engine::read(root, version, platform)?;
    ensure!(
        (source == Source::Npm) == (engine.kind == "npm"),
        "CLI source does not match its cache descriptor."
    );
    Ok(InstalledEngine {
        root: root.to_path_buf(),
        engine,
    })
}

pub fn ensure_installed(
    context: &ContextPaths,
    source: Source,
    version: &str,
    offline: bool,
) -> Result<InstalledEngine> {
    exact_version(version)?;
    let target = platform()?;
    // A complete installer can run its bundled version with no network or npm.
    if source == Source::Github
        && let Some(receipt) = &context.receipt
        && receipt.default_cli_version.as_deref() == Some(version)
        && let Some(relative) = &receipt.bundled_engine
    {
        let root = context
            .executable
            .parent()
            .context("Launcher has no parent.")?
            .join(relative_path(relative)?);
        if root.exists() {
            let engine = Engine::read(&root, version, target)?;
            ensure!(
                engine.kind != "npm",
                "The standalone bundle must contain its own runtime."
            );
            return Ok(InstalledEngine { root, engine });
        }
    }
    install_cached(context, source, version, offline, |stage| {
        eprintln!("Installing UAPKG CLI {version} from {}...", source.name());
        let client = github::client()?;
        match source {
            Source::Github => {
                let verified = github::release(&client, version)?;
                let artifact = verified.release.artifact("cli", target)?;
                let archive_path = stage.join("engine.tar.gz");
                github::download_artifact(&client, version, artifact, &archive_path)?;
                let root = stage.join("engine");
                archive::extract(&archive_path, &root)?;
                fs::write(root.join(".release.json"), verified.bytes)?;
                fs::write(root.join(".release.json.minisig"), verified.signature)?;
                Ok(root)
            }
            Source::Npm => npm::install(&client, version, target, stage),
        }
    })
}

/// The provider must authenticate its download before returning a staged engine.
/// Cache locking, validation, and activation are shared by both real providers;
/// tests substitute only the downloader, never the lock or activation behavior.
fn install_cached(
    context: &ContextPaths,
    source: Source,
    version: &str,
    offline: bool,
    install: impl FnOnce(&Path) -> Result<PathBuf>,
) -> Result<InstalledEngine> {
    exact_version(version)?;
    let target = platform()?;
    let destination = context.cache_dir(source, version, target)?;
    if destination.exists() {
        return cached(&destination, source, version, target);
    }
    ensure!(
        !offline,
        "CLI {version} from {} is not cached for {target}. Run `uapkg version install {version}` while online; no other version will be substituted.",
        source.name()
    );
    let _lock = lock(
        &context
            .home
            .join("locks")
            .join(format!("{}-{version}-{target}.lock", source.name())),
    )?;
    if destination.exists() {
        return cached(&destination, source, version, target);
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
    let engine = Engine::read(&root, version, target)?;
    ensure!(
        (source == Source::Npm) == (engine.kind == "npm"),
        "CLI source does not match the staged engine."
    );
    atomic_json(
        &root.join(".installed.json"),
        &Installation {
            schema_version: 1,
            source,
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
    cached(&destination, source, version, target)
}

pub fn list(context: &ContextPaths) -> Result<Vec<(String, String, String)>> {
    let mut results = Vec::new();
    for source in [Source::Github, Source::Npm] {
        let base = context.home.join("engines").join(source.name());
        if !base.exists() {
            continue;
        }
        for entry in fs::read_dir(base)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(version) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if exact_version(&version).is_err() {
                continue;
            }
            for target in fs::read_dir(entry.path())? {
                let target = target?;
                if !target.file_type()?.is_dir() {
                    continue;
                }
                let platform = target.file_name().to_string_lossy().into_owned();
                if cached(&target.path(), source, &version, &platform).is_ok() {
                    results.push((source.name().to_owned(), version.clone(), platform));
                }
            }
        }
    }
    if let Some(receipt) = &context.receipt
        && let (Some(version), Some(relative)) =
            (&receipt.default_cli_version, &receipt.bundled_engine)
    {
        let root = context
            .executable
            .parent()
            .context("Launcher has no parent.")?
            .join(relative_path(relative)?);
        if Engine::read(&root, version, platform()?).is_ok() {
            results.push((
                "github-releases (bundled)".to_owned(),
                version.clone(),
                platform()?.to_owned(),
            ));
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
) -> Result<i32> {
    let mut command = if installed.engine.kind == "npm" {
        Command::new(npm::node_runtime(installed.engine.node_range.as_deref())?)
    } else {
        Command::new(
            installed
                .root
                .join(relative_path(&installed.engine.executable)?),
        )
    };
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
        ctrlc::set_handler(|| {}).context("Could not initialize console signal handling.")?;
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
                node_range: None,
                npm_range: None,
            },
        )?;
        Ok(root)
    }

    #[test]
    fn concurrent_installers_share_one_provider_and_activate_only_a_complete_engine() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        let provider_calls = AtomicUsize::new(0);
        let destination = context
            .cache_dir(Source::Github, "1.2.3", platform().unwrap())
            .unwrap();
        let (staging_ready, ready) = mpsc::channel();
        let (finish_staging, finish) = mpsc::channel();
        let (second_started, started) = mpsc::channel();

        std::thread::scope(|scope| {
            let context_ref = &context;
            let calls = &provider_calls;
            let first = scope.spawn(move || {
                install_cached(context_ref, Source::Github, "1.2.3", false, |stage| {
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
                install_cached(context_ref, Source::Github, "1.2.3", false, |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    anyhow::bail!("A concurrent waiter must use the winner's installation.")
                })
            });
            started.recv_timeout(Duration::from_secs(5)).unwrap();
            let lock_path = context.home.join("locks").join(format!(
                "github-releases-1.2.3-{}.lock",
                platform().unwrap()
            ));
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
        assert!(cached(&destination, Source::Github, "1.2.3", platform().unwrap()).is_ok());
        assert_eq!(
            fs::read_dir(context.home.join("staging")).unwrap().count(),
            0
        );
    }

    #[test]
    fn an_interrupted_download_cannot_replace_or_hide_a_working_version() {
        let directory = tempfile::tempdir().unwrap();
        let context = context(directory.path());
        let previous = install_cached(&context, Source::Github, "1.2.3", false, |stage| {
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
        let failed = install_cached(&context, Source::Github, "2.0.0", false, |stage| {
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
                .cache_dir(Source::Github, "2.0.0", platform().unwrap())
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
            install_cached(&context, Source::Github, "2.0.0", true, |_| panic!(
                "Offline mode must not call a provider"
            ))
            .is_err()
        );
        assert!(
            install_cached(&context, Source::Github, "1.2.3", true, |_| panic!(
                "Cached execution must not call a provider"
            ))
            .is_ok()
        );
        let retry = install_cached(&context, Source::Github, "2.0.0", false, |stage| {
            stage_engine(stage, "2.0.0")
        })
        .unwrap();
        assert_eq!(retry.engine.version, "2.0.0");
        assert_eq!(archive::sha256(&executable).unwrap(), original_hash);
    }
}
