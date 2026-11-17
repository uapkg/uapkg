use crate::{
    archive,
    catalog::{self, Index, Selector},
    github, maintenance,
    model::{exact_version, platform, read_json, relative_path},
    storage::{ContextPaths, atomic_json, lock},
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const JOURNAL: &str = "uapkg-update.json";

pub fn recover_installation(context: &ContextPaths) -> Result<()> {
    let directory = context
        .executable
        .parent()
        .context("Launcher has no installation directory.")?;
    if !directory.join(JOURNAL).exists() {
        return Ok(());
    }
    ensure!(
        context.ownership() == "standalone",
        "An update recovery record exists, but {} owns this launcher installation. Restore or update it through its original installation method. No installation files were changed.",
        context.ownership()
    );
    recover(&context.executable)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transaction {
    pub schema_version: u32,
    pub executable: String,
    pub backup: String,
    pub previous_sha256: String,
    pub next_sha256: String,
    pub next_version: String,
}

fn paths(directory: &Path, transaction: &Transaction) -> Result<(PathBuf, PathBuf)> {
    ensure!(
        transaction.schema_version == 1,
        "Unsupported launcher update recovery record."
    );
    let executable = relative_path(&transaction.executable)?;
    let backup = relative_path(&transaction.backup)?;
    ensure!(
        executable.components().count() == 1
            && backup.components().count() == 1
            && executable != backup,
        "Invalid launcher update recovery paths."
    );
    exact_version(&transaction.next_version)?;
    Ok((directory.join(executable), directory.join(backup)))
}

fn reported_version(executable: &Path) -> Result<Option<String>> {
    let mut child = Command::new(executable)
        .args(["launcher", "--version"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Could not start the staged launcher.")?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("The staged launcher did not respond within 10 seconds.");
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .context("Launcher health output is unavailable.")?
        .take(1024)
        .read_to_end(&mut stdout)?;
    Ok(status
        .success()
        .then(|| String::from_utf8_lossy(&stdout).trim().to_owned()))
}

fn health(executable: &Path, expected_version: &str) -> Result<()> {
    ensure!(
        reported_version(executable)?.as_deref() == Some(expected_version),
        "The staged launcher did not pass its version check."
    );
    Ok(())
}

pub fn rollback(directory: &Path, transaction: &Transaction) -> Result<()> {
    let (target, backup) = paths(directory, transaction)?;
    ensure!(
        archive::sha256(&backup)? == transaction.previous_sha256,
        "Launcher backup failed verification. Keep {} and {} for manual recovery.",
        backup.display(),
        directory.join(JOURNAL).display()
    );
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    let mut input = fs::File::open(&backup)?;
    std::io::copy(&mut input, &mut temporary)?;
    temporary.as_file().sync_all()?;
    fs::set_permissions(temporary.path(), fs::metadata(&backup)?.permissions())?;
    temporary
        .persist(&target)
        .map_err(|error| error.error)
        .with_context(|| {
            format!(
                "Could not restore the launcher. Copy {} to {} after closing UAPKG processes.",
                backup.display(),
                target.display()
            )
        })?;
    finish_transaction(directory, &backup)
}

/// A verified backup and journal exist before replacing the live executable.
/// Recover an interrupted transaction on the next normal invocation, including
/// when the backup executable itself is invoked after an interrupted update.
pub fn recover(executable: &Path) -> Result<()> {
    let directory = executable
        .parent()
        .context("Launcher has no installation directory.")?;
    let journal = directory.join(JOURNAL);
    if !journal.exists() {
        return Ok(());
    }
    let _lock = lock(&directory.join("uapkg-update.lock"))?;
    if !journal.exists() {
        return Ok(());
    }
    let transaction: Transaction = read_json(&journal)?;
    let (target, backup) = paths(directory, &transaction)?;
    ensure!(
        executable == target || executable == backup,
        "Update journal does not belong to this launcher."
    );
    let current_hash = if target.is_file() {
        Some(archive::sha256(&target)?)
    } else {
        None
    };
    if current_hash.as_deref() == Some(&transaction.next_sha256)
        && health(&target, &transaction.next_version).is_ok()
    {
        return finish_transaction(directory, &backup);
    }
    if current_hash.as_deref() == Some(&transaction.previous_sha256) {
        return finish_transaction(directory, &backup);
    }
    rollback(directory, &transaction)?;
    bail!("Recovered the previous launcher after an interrupted update. Run the command again.")
}

fn finish_transaction(directory: &Path, backup: &Path) -> Result<()> {
    if backup.exists() {
        remove_backup(backup)?;
    }
    fs::remove_file(directory.join(JOURNAL))?;
    Ok(())
}

fn remove_backup(backup: &Path) -> Result<()> {
    let running = std::env::current_exe()?.canonicalize().ok();
    if running.as_ref() == Some(&backup.canonicalize()?) {
        self_replace::self_delete().context("The launcher was recovered, but its running backup could not be scheduled for cleanup.")?;
    } else {
        fs::remove_file(backup)?;
    }
    Ok(())
}

pub fn ownership_instructions(method: &str) -> Result<()> {
    match method {
        "standalone" => Ok(()),
        "npm" => bail!(
            "npm owns this launcher installation. Use npm to update the package that installed UAPKG."
        ),
        "winget" => bail!(
            "WinGet owns this launcher installation. Use WinGet to update the package that installed UAPKG."
        ),
        "homebrew" => bail!(
            "Homebrew owns this launcher installation. Use Homebrew to update the formula that installed UAPKG."
        ),
        "scoop" => bail!(
            "Scoop owns this launcher installation. Use Scoop to update the package that installed UAPKG."
        ),
        "development" => bail!(
            "This launcher is bound to a development checkout. Rebuild it with the checkout's development tooling."
        ),
        _ => bail!(
            "Unknown launcher installation owner {method:?}. Reinstall through the original distribution channel."
        ),
    }
}

#[derive(Default)]
pub struct UpdateMaintenance {
    pub restart: bool,
    pub notices: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UpdateMode {
    Automatic,
    ManualLatest,
    ManualSelected,
}

enum Replacement {
    Installed,
    AlreadyPresent(String),
}

fn tracked_selector(context: &ContextPaths) -> Result<String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Tracking {
        selector: String,
        version: String,
    }

    let path = context.home.join("catalog/launcher/tracking.json");
    if !path.exists() {
        return Ok("latest".into());
    }
    let tracking: Tracking = read_json(&path)?;
    exact_version(&tracking.version)?;
    Ok(tracking.selector)
}

fn update_notices(current: &str, next: &str, owner: &str, requested: &str) -> Vec<String> {
    let action = match owner {
        "standalone" if requested == "latest" => {
            "Use `uapkg launcher-update` to install it.".into()
        }
        "standalone" => format!("Use `uapkg launcher-update {requested}` to install it."),
        "npm" => "Use npm to update the package that installed UAPKG.".into(),
        "winget" => "Use WinGet to update the package that installed UAPKG.".into(),
        "homebrew" => "Use Homebrew to update the formula that installed UAPKG.".into(),
        "scoop" => "Use Scoop to update the package that installed UAPKG.".into(),
        _ => "Update UAPKG through its original installation method.".into(),
    };
    vec![
        format!("A new UAPKG launcher update is available. {current} -> {next}"),
        action,
    ]
}

/// A launcher update is optional for a delegated command. Reuse a verified
/// index for reminders and require a fresh index before automatic replacement.
pub fn maintain(context: &ContextPaths, auto_update: bool) -> UpdateMaintenance {
    if context.ownership() == "development"
        || github::catalog_key().is_none_or(|key| key.trim().is_empty())
    {
        return UpdateMaintenance::default();
    }
    maintain_from_catalog(context, auto_update).unwrap_or_else(|error| {
        eprintln!("uapkg: Could not check for launcher updates. {error:#}");
        UpdateMaintenance::default()
    })
}

fn maintain_from_catalog(context: &ContextPaths, auto_update: bool) -> Result<UpdateMaintenance> {
    let requested = tracked_selector(context)?;
    if catalog::selector(&requested)? == Selector::Exact {
        return Ok(UpdateMaintenance::default());
    }

    let attempt = maintenance::claim(&maintenance::launcher_directory(context), false)?;
    let fresh = if attempt.is_some() {
        match catalog::refresh_index(context, "launcher") {
            Ok(index) => Some(index),
            Err(error) => {
                eprintln!("uapkg: Could not check for launcher updates. {error:#}");
                None
            }
        }
    } else {
        None
    };
    let perform_update = fresh.is_some() && auto_update && context.ownership() == "standalone";
    let index = match fresh {
        Some(index) => index,
        None => match catalog::index(context, "launcher", true) {
            Ok(Some(index)) => index,
            _ => return Ok(UpdateMaintenance::default()),
        },
    };
    let Some(next) = index.aliases.get(&requested) else {
        return Ok(UpdateMaintenance::default());
    };
    let current = crate::model::VERSION;
    if !exact_version(next)?
        .cmp_precedence(&exact_version(current)?)
        .is_gt()
        || index.supports(next, platform()?).is_err()
    {
        return Ok(UpdateMaintenance::default());
    }

    if perform_update {
        match install(context, next, &index, UpdateMode::Automatic) {
            Ok(Replacement::Installed) => {
                // Maintenance keeps following the existing selector. The next
                // launcher can reuse that intent with the timestamp we saved.
                eprintln!("uapkg: Updated launcher to {next}.");
                return Ok(UpdateMaintenance {
                    restart: true,
                    notices: Vec::new(),
                });
            }
            Ok(Replacement::AlreadyPresent(_)) => {
                return Ok(UpdateMaintenance {
                    restart: true,
                    notices: Vec::new(),
                });
            }
            Err(error) => {
                eprintln!("uapkg: Could not update the launcher automatically. {error:#}");
            }
        }
    }

    Ok(UpdateMaintenance {
        restart: false,
        notices: update_notices(current, next, context.ownership(), &requested),
    })
}

pub fn update(context: &ContextPaths, requested: Option<&str>) -> Result<()> {
    ownership_instructions(context.ownership())?;
    let requested = requested.unwrap_or("latest");
    let selector = catalog::selector(requested)?;
    let _attempt = maintenance::claim(&maintenance::launcher_directory(context), true)?
        .context("Could not reserve the launcher update check.")?;
    let resolution = catalog::resolve(context, "launcher", requested, false, true)?;
    let current = exact_version(crate::model::VERSION)?;
    if selector == Selector::Latest
        && exact_version(&resolution.version)?
            .cmp_precedence(&current)
            .is_le()
    {
        catalog::activate(context, "launcher", &resolution)?;
        println!("The launcher is up to date.");
        return Ok(());
    }
    catalog::emit(&resolution.messages);
    let offline = selector != Selector::Exact;
    let index = catalog::index(context, "launcher", offline)?
        .context("No verified launcher index is available.")?;
    let mode = if selector == Selector::Latest {
        UpdateMode::ManualLatest
    } else {
        UpdateMode::ManualSelected
    };
    let mut resolution = resolution;
    match install(context, &resolution.version, &index, mode)? {
        Replacement::Installed => {
            catalog::activate(context, "launcher", &resolution)?;
            println!("Updated launcher to {}.", resolution.version);
            catalog::emit(&resolution.messages);
        }
        Replacement::AlreadyPresent(version) => {
            resolution.version = version;
            catalog::activate(context, "launcher", &resolution)?;
            println!("The launcher is up to date.");
        }
    }
    Ok(())
}

fn install(
    context: &ContextPaths,
    version: &str,
    index: &Index,
    mode: UpdateMode,
) -> Result<Replacement> {
    let client = if mode == UpdateMode::Automatic {
        github::client_with_timeout(Duration::from_secs(30))?
    } else {
        github::client()?
    };
    let target = platform()?;
    index.supports(version, target)?;
    let directory = context
        .executable
        .parent()
        .context("Launcher has no installation directory.")?;
    let temporary = tempfile::Builder::new()
        .prefix(".uapkg-update-")
        .tempdir_in(directory)?;
    let archive_path = temporary.path().join("launcher.tar.gz");
    github::download_artifact(&client, "launcher", version, target, &archive_path)?;
    let extracted = temporary.path().join("launcher");
    archive::extract(&archive_path, &extracted)?;
    let next = extracted.join(if cfg!(windows) { "uapkg.exe" } else { "uapkg" });
    ensure!(
        next.is_file(),
        "Launcher archive does not contain its executable."
    );
    replace_staged_with_mode(context, &next, version, mode)
}

/// Start the already checked replacement with the original arguments and
/// inherited process context. Only a failure before launch permits fallback.
pub fn resume(context: &ContextPaths, args: &[OsString]) -> Result<Option<i32>> {
    let mut command = Command::new(&context.executable);
    command
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(unix)]
    let error = {
        use std::os::unix::process::CommandExt;
        command.exec()
    };
    #[cfg(not(unix))]
    let error = {
        #[cfg(windows)]
        windows_console_handler()?;
        match command.spawn() {
            Ok(mut child) => {
                let status = child
                    .wait()
                    .context("Could not wait for the updated launcher.")?;
                return Ok(Some(status.code().unwrap_or(1)));
            }
            Err(error) => error,
        }
    };

    eprintln!(
        "uapkg: Could not start the updated launcher. Continuing this command with the running launcher. {error}"
    );
    Ok(None)
}

#[cfg(windows)]
pub(crate) fn windows_console_handler() -> Result<()> {
    match ctrlc::try_set_handler(|| {}) {
        Ok(()) | Err(ctrlc::Error::MultipleHandlers) => Ok(()),
        Err(error) => Err(error).context("Could not initialize console signal handling."),
    }
}

/// Complete a replacement after the caller has verified and extracted a signed
/// artifact. This phase is separate so recovery and the platform replacement
/// helper can be tested without publishing a release or using the network.
pub fn replace_staged(context: &ContextPaths, next: &Path, version: &str) -> Result<()> {
    replace_staged_with_mode(context, next, version, UpdateMode::ManualSelected)?;
    Ok(())
}

fn replace_staged_with_mode(
    context: &ContextPaths,
    next: &Path,
    version: &str,
    mode: UpdateMode,
) -> Result<Replacement> {
    ownership_instructions(context.ownership())?;
    exact_version(version)?;
    let directory = context
        .executable
        .parent()
        .context("Launcher has no installation directory.")?;
    let _lock = lock(&directory.join("uapkg-update.lock"))?;
    ensure!(
        !directory.join(JOURNAL).exists(),
        "An earlier launcher update needs recovery. Run UAPKG again before updating."
    );
    if mode != UpdateMode::ManualSelected {
        // Different profiles may share this installation. Inspect the live
        // binary under its installation lock, after downloading the candidate.
        let live = reported_version(&context.executable)
            .context("Could not check the installed launcher version.")?
            .context("The installed launcher did not report its version.")?;
        if keep_installed(&live, version, crate::model::VERSION, mode)? {
            return Ok(Replacement::AlreadyPresent(live));
        }
    }
    ensure!(
        context.executable.canonicalize()? == std::env::current_exe()?.canonicalize()?,
        "Only the running launcher can replace itself."
    );
    health(next, version)?;
    let name = context
        .executable
        .file_name()
        .and_then(|name| name.to_str())
        .context("Launcher file name must be UTF-8.")?;
    let backup_name = if cfg!(windows) {
        format!("{name}.backup.exe")
    } else {
        format!("{name}.backup")
    };
    let backup = directory.join(&backup_name);
    let previous_sha256 = archive::sha256(&context.executable)?;
    if backup.exists() {
        ensure!(
            archive::sha256(&backup)? == previous_sha256,
            "A launcher backup already exists at {}. Keep it until you have checked the current installation.",
            backup.display()
        );
        // A crash between writing the backup and journal can leave an orphan.
        fs::remove_file(&backup)?;
    }
    fs::copy(&context.executable, &backup).context("Could not create the launcher backup.")?;
    fs::OpenOptions::new()
        .write(true)
        .open(&backup)?
        .sync_all()
        .context("Could not flush the launcher backup.")?;
    ensure!(
        archive::sha256(&backup)? == previous_sha256,
        "Could not verify the launcher backup."
    );
    let transaction = Transaction {
        schema_version: 1,
        executable: name.to_owned(),
        backup: backup_name,
        previous_sha256,
        next_sha256: archive::sha256(next)?,
        next_version: version.to_owned(),
    };
    atomic_json(&directory.join(JOURNAL), &transaction)?;
    // self-replace supplies the Windows helper which retires the running binary
    // after exit; it does not invoke a shell or overwrite an open executable.
    if let Err(error) = self_replace::self_replace(next) {
        if archive::sha256(&context.executable).ok().as_deref()
            == Some(&transaction.previous_sha256)
        {
            finish_transaction(directory, &backup)?;
        } else {
            rollback(directory, &transaction)?;
        }
        return Err(error)
            .context("Could not replace the launcher. The previous launcher is still installed.");
    }
    if let Err(error) = health(&context.executable, &transaction.next_version) {
        rollback(directory, &transaction)?;
        return Err(error)
            .context("The updated launcher failed its check; the previous launcher was restored.");
    }
    finish_transaction(directory, &backup)?;
    Ok(Replacement::Installed)
}

fn keep_installed(live: &str, candidate: &str, running: &str, mode: UpdateMode) -> Result<bool> {
    let live = exact_version(live)?;
    Ok(!exact_version(candidate)?.cmp_precedence(&live).is_gt()
        || (mode == UpdateMode::Automatic && live != exact_version(running)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_replacement_hands_off_to_a_launcher_installed_by_another_process() {
        for candidate in ["0.9.0", "0.10.0", "0.11.0"] {
            assert!(keep_installed("0.10.0", candidate, "0.8.0", UpdateMode::Automatic).unwrap());
        }
        assert!(keep_installed("0.7.0", "0.9.0", "0.8.0", UpdateMode::Automatic).unwrap());
        assert!(!keep_installed("0.8.0", "0.9.0", "0.8.0", UpdateMode::Automatic).unwrap());
        assert!(keep_installed("0.10.0", "0.9.0", "0.8.0", UpdateMode::ManualLatest).unwrap());
        assert!(!keep_installed("0.10.0", "0.11.0", "0.8.0", UpdateMode::ManualLatest).unwrap());
    }

    #[test]
    fn a_fresh_launcher_tracks_latest_and_an_explicit_exact_update_stays_pinned() {
        let directory = tempfile::tempdir().unwrap();
        let context = ContextPaths {
            home: directory.path().join("profile"),
            executable: directory.path().join("launcher"),
            receipt: None,
        };
        assert_eq!(tracked_selector(&context).unwrap(), "latest");
        atomic_json(
            &context.home.join("catalog/launcher/tracking.json"),
            &serde_json::json!({"selector":"0.1.2", "version":"0.1.2"}),
        )
        .unwrap();
        let action = maintain(&context, true);
        assert_eq!(tracked_selector(&context).unwrap(), "0.1.2");
        assert!(!action.restart);
        assert!(action.notices.is_empty());
        assert!(!maintenance::launcher_directory(&context).exists());
    }
}
