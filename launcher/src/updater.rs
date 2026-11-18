use crate::{
    archive,
    catalog::{self, Index, Selector},
    github, maintenance,
    model::{exact_version, platform, read_json, relative_path},
    release_age::{self, MinimumReleaseAge, automatic_candidate},
    storage::{ContextPaths, ExtraFields, atomic_json, lock},
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
const BACKUP_RECORD: &str = "uapkg-backup.json";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupRecord {
    schema_version: u32,
    version: String,
    backup: String,
    sha256: String,
    #[serde(flatten, default)]
    pub extra_fields: ExtraFields,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedRelease {
    schema_version: u32,
    version: String,
    platform: String,
    #[serde(flatten, default)]
    pub extra_fields: ExtraFields,
}

fn stage_lock(directory: &Path, version: &str) -> Result<fs::File> {
    exact_version(version)?;
    lock(&directory.join(format!("uapkg-stage-{version}.lock")))
}

pub(crate) fn purge_quarantined(context: &ContextPaths, index: &Index) -> Result<()> {
    if context.ownership() != "standalone" {
        return Ok(());
    }
    let directory = context
        .executable
        .parent()
        .context("Launcher has no installation directory.")?;
    let canonical = directory.canonicalize()?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(".uapkg-update-")
            || !entry.file_type()?.is_dir()
        {
            continue;
        }
        ensure!(
            !fs::symlink_metadata(entry.path())?.file_type().is_symlink()
                && entry.path().canonicalize()?.starts_with(&canonical),
            "Refusing launcher stage cleanup outside its installation directory."
        );
        let Ok(staged) = read_json::<StagedRelease>(&entry.path().join(".release.json")) else {
            continue;
        };
        if staged.schema_version != 1
            || exact_version(&staged.version).is_err()
            || !index
                .release(&staged.version)
                .is_some_and(|release| release.quarantined.is_some())
        {
            continue;
        }
        let Some(_guard) = crate::storage::try_lock(
            &directory.join(format!("uapkg-stage-{}.lock", staged.version)),
        )?
        else {
            eprintln!(
                "uapkg: Cleanup of quarantined launcher {} is deferred while its installation is active.",
                staged.version
            );
            continue;
        };
        if entry.path().exists() {
            fs::remove_dir_all(entry.path())?;
        }
    }
    // Keep transaction-owned backups until recovery or replacement commits.
    if directory.join(JOURNAL).exists() {
        return Ok(());
    }
    let name = context
        .executable
        .file_name()
        .and_then(|name| name.to_str())
        .context("Launcher file name must be UTF-8.")?;
    let backup = directory.join(if cfg!(windows) {
        format!("{name}.backup.exe")
    } else {
        format!("{name}.backup")
    });
    if backup.is_file() && !fs::symlink_metadata(&backup)?.file_type().is_symlink() {
        let _guard = lock(&directory.join("uapkg-update.lock"))?;
        if !directory.join(JOURNAL).exists()
            && let Ok(record) = read_json::<BackupRecord>(&directory.join(BACKUP_RECORD))
            && record.schema_version == 1
            && backup.file_name().and_then(|name| name.to_str()) == Some(record.backup.as_str())
            && archive::sha256(&backup).ok().as_deref() == Some(record.sha256.as_str())
            && index
                .release(&record.version)
                .is_some_and(|release| release.quarantined.is_some())
        {
            remove_backup(&backup)?;
            fs::remove_file(directory.join(BACKUP_RECORD))?;
        }
    }
    Ok(())
}

pub fn recover_installation(context: &ContextPaths) -> Result<Option<PathBuf>> {
    let directory = context
        .executable
        .parent()
        .context("Launcher has no installation directory.")?;
    if !directory.join(JOURNAL).exists() {
        return Ok(None);
    }
    ensure!(
        context.ownership() == "standalone",
        "An update recovery record exists, but {} owns this launcher installation. Restore or update it through its original installation method. No installation files were changed.",
        context.ownership()
    );
    let transaction: Transaction = read_json(&directory.join(JOURNAL))?;
    let (target, _) = paths(directory, &transaction)?;
    let before = archive::sha256(&target).ok();
    match recover(&context.executable) {
        Ok(()) => {}
        Err(error)
            if !directory.join(JOURNAL).exists()
                && archive::sha256(&target).ok().as_deref()
                    == Some(&transaction.previous_sha256) =>
        {
            eprintln!("uapkg: {error:#}");
        }
        Err(error) => return Err(error),
    }
    let moved = context.executable != target || before != archive::sha256(&target).ok();
    Ok(moved.then_some(target))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub schema_version: u32,
    pub executable: String,
    pub backup: String,
    pub previous_sha256: String,
    pub next_sha256: String,
    pub next_version: String,
    #[serde(flatten, default)]
    pub extra_fields: ExtraFields,
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
    if directory.join(BACKUP_RECORD).exists() {
        fs::remove_file(directory.join(BACKUP_RECORD))?;
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
    Required,
}

enum Replacement {
    Installed,
    AlreadyPresent(String),
}

fn tracked_selector(context: &ContextPaths) -> Result<String> {
    let path = context.home.join("catalog/launcher/tracking.json");
    if !path.exists() {
        return Ok("latest".into());
    }
    let tracking: catalog::Tracking = read_json(&path)?;
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
pub fn maintain(
    context: &ContextPaths,
    auto_update: bool,
    fresh: bool,
    minimum_age: MinimumReleaseAge,
) -> UpdateMaintenance {
    if context.ownership() == "development" {
        return UpdateMaintenance::default();
    }
    maintain_from_catalog(context, auto_update, fresh, minimum_age).unwrap_or_else(|error| {
        eprintln!("uapkg: Could not check for launcher updates. {error:#}");
        UpdateMaintenance::default()
    })
}

fn maintain_from_catalog(
    context: &ContextPaths,
    auto_update: bool,
    fresh: bool,
    minimum_age: MinimumReleaseAge,
) -> Result<UpdateMaintenance> {
    let requested = tracked_selector(context)?;
    if catalog::selector(&requested)? == Selector::Exact {
        return Ok(UpdateMaintenance::default());
    }

    let perform_update = fresh && auto_update && context.ownership() == "standalone";
    let index = match catalog::index(context, "launcher", true) {
        Ok(Some(index)) => index,
        _ => return Ok(UpdateMaintenance::default()),
    };
    maintain_selected(
        context,
        &requested,
        crate::model::VERSION,
        &index,
        perform_update.then(|| (minimum_age, release_age::now())),
        |next, index| install(context, next, index, UpdateMode::Automatic),
    )
}

fn maintain_selected(
    context: &ContextPaths,
    requested: &str,
    current: &str,
    index: &Index,
    automatic: Option<(MinimumReleaseAge, Option<jiff::Timestamp>)>,
    install: impl FnOnce(&str, &Index) -> Result<Replacement>,
) -> Result<UpdateMaintenance> {
    let Some(next) = index.aliases.get(requested) else {
        return Ok(UpdateMaintenance::default());
    };
    if !exact_version(next)?
        .cmp_precedence(&exact_version(current)?)
        .is_gt()
    {
        return Ok(UpdateMaintenance::default());
    }

    if let Some((minimum_age, now)) = automatic
        && let Some(next) =
            automatic_candidate(index, requested, current, platform()?, minimum_age, now)
    {
        match install(next, index) {
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
        notices: update_notices(current, next, context.ownership(), requested),
    })
}

pub fn update(context: &ContextPaths, requested: Option<&str>) -> Result<()> {
    ownership_instructions(context.ownership())?;
    let requested = requested.unwrap_or("latest");
    let selector = catalog::selector(requested)?;
    let _attempt = maintenance::claim(&maintenance::launcher_directory(context), true)?
        .context("Could not reserve the launcher update check.")?;
    let index = catalog::index(context, "launcher", false)?
        .context("No verified launcher index is available.")?;
    if let Err(error) = purge_quarantined(context, &index) {
        eprintln!("uapkg: Could not finish quarantined launcher cleanup. {error:#}");
    }
    let resolution = catalog::resolve(context, "launcher", requested, true, true)?;
    let current = exact_version(crate::model::VERSION)?;
    let required = index
        .release(crate::model::VERSION)
        .is_some_and(|release| release.unavailable().is_some());
    if !required
        && selector == Selector::Latest
        && exact_version(&resolution.version)?
            .cmp_precedence(&current)
            .is_le()
    {
        catalog::activate(context, "launcher", &resolution)?;
        println!("The launcher is up to date.");
        return Ok(());
    }
    catalog::emit(&resolution.messages);
    let mode = if required {
        UpdateMode::Required
    } else if selector == Selector::Latest {
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
    index.ensure_runnable(version)?;
    index.supports(version, target)?;
    let directory = context
        .executable
        .parent()
        .context("Launcher has no installation directory.")?;
    let _stage_guard = stage_lock(directory, version)?;
    let temporary = tempfile::Builder::new()
        .prefix(".uapkg-update-")
        .tempdir_in(directory)?;
    atomic_json(
        &temporary.path().join(".release.json"),
        &StagedRelease {
            schema_version: 1,
            version: version.into(),
            platform: target.into(),
            extra_fields: ExtraFields::new(),
        },
    )?;
    let archive_path = temporary.path().join("launcher.tar.gz");
    github::download_artifact(&client, "launcher", version, target, &archive_path)?;
    let extracted = temporary.path().join("launcher");
    archive::extract(&archive_path, &extracted)?;
    let next = extracted.join(if cfg!(windows) { "uapkg.exe" } else { "uapkg" });
    ensure!(
        next.is_file(),
        "Launcher archive does not contain its executable."
    );
    replace_staged_with_policy(context, &next, version, mode, Some(index))
}

/// A marked running launcher may only execute the updater and identity probes.
/// This path deliberately ignores tracking pins and optional update settings.
pub fn enforce_policy(context: &ContextPaths, offline: bool) -> Result<bool> {
    let Some(index) = catalog::index(context, "launcher", true)? else {
        return Ok(false);
    };
    enforce_policy_with(
        context,
        crate::model::VERSION,
        offline,
        &index,
        |version, index| {
            install(context, version, index, UpdateMode::Required).map(|result| match result {
                Replacement::Installed => version.into(),
                Replacement::AlreadyPresent(version) => version,
            })
        },
    )
}

fn enforce_policy_with(
    context: &ContextPaths,
    current: &str,
    offline: bool,
    index: &Index,
    install: impl FnOnce(&str, &Index) -> Result<String>,
) -> Result<bool> {
    let Some((kind, status)) = index
        .release(current)
        .and_then(catalog::Release::unavailable)
    else {
        return Ok(false);
    };
    let message = format!("Launcher {current} is {kind}: {}.", status.display_reason());
    ownership_instructions(context.ownership()).with_context(|| message.clone())?;
    ensure!(
        !offline,
        "{message} Ordinary commands are refused. Connect and run `uapkg launcher-update` to recover."
    );
    let next = index.target("latest").with_context(|| {
        format!("{message} No healthy latest launcher is available; ordinary commands are refused.")
    })?;
    index.ensure_runnable(&next)?;
    index.supports(&next, platform()?)?;
    eprintln!("uapkg: {message} Installing healthy launcher {next} before continuing.");
    let installed = install(&next, index).with_context(|| format!("{message} Required recovery failed; the command was refused. Run `uapkg launcher-update` to retry."))?;
    catalog::activate(
        context,
        "launcher",
        &catalog::Resolution {
            requested: "latest".into(),
            version: installed,
            messages: vec![],
        },
    )?;
    Ok(true)
}

/// Start the already checked replacement with the original arguments and
/// inherited process context. Only a failure before launch permits fallback.
pub fn resume(context: &ContextPaths, args: &[OsString]) -> Result<Option<i32>> {
    resume_mode(context, args, false)
}

pub fn resume_required(context: &ContextPaths, args: &[OsString]) -> Result<i32> {
    resume_mode(context, args, true)?
        .context("The healthy launcher could not be started; the command was refused.")
}

fn resume_mode(context: &ContextPaths, args: &[OsString], required: bool) -> Result<Option<i32>> {
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

    if required {
        return Err(error)
            .context("Could not start the healthy replacement launcher; the command was refused.");
    }
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
    replace_staged_with_policy(context, next, version, mode, None)
}

fn replace_staged_with_policy(
    context: &ContextPaths,
    next: &Path,
    version: &str,
    mode: UpdateMode,
    policy: Option<&Index>,
) -> Result<Replacement> {
    ownership_instructions(context.ownership())?;
    exact_version(version)?;
    let directory = context
        .executable
        .parent()
        .context("Launcher has no installation directory.")?;
    let _lock = lock(&directory.join("uapkg-update.lock"))?;
    let latest_policy = catalog::index(context, "launcher", true)?;
    let policy = latest_policy.as_ref().or(policy);
    if let Some(policy) = policy {
        policy.ensure_runnable(version)?;
    }
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
        exact_version(&live)?;
        let keep = if mode == UpdateMode::Required {
            live == version
                || (live != crate::model::VERSION
                    && policy.is_some_and(|policy| policy.ensure_runnable(&live).is_ok()))
        } else {
            keep_installed(&live, version, crate::model::VERSION, mode)?
        };
        if keep {
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
    atomic_json(
        &directory.join(BACKUP_RECORD),
        &BackupRecord {
            schema_version: 1,
            version: crate::model::VERSION.into(),
            backup: backup_name.clone(),
            sha256: previous_sha256.clone(),
            extra_fields: ExtraFields::new(),
        },
    )?;
    let transaction = Transaction {
        schema_version: 1,
        executable: name.to_owned(),
        backup: backup_name,
        previous_sha256,
        next_sha256: archive::sha256(next)?,
        next_version: version.to_owned(),
        extra_fields: ExtraFields::new(),
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
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn roundtrip_update_record<T: DeserializeOwned + Serialize>(
        mut value: Value,
        required: &[&str],
    ) {
        let extras = json!({"futureObject": {"nested": [null, {"enabled": true}]}, "futureArray": [1, "value", false], "futureNull": null});
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
    fn update_records_roundtrip_extensions_and_reject_missing_or_malformed_known_fields() {
        roundtrip_update_record::<BackupRecord>(
            json!({"schemaVersion": 1, "version": "0.3.3", "backup": "uapkg.backup", "sha256": "0".repeat(64)}),
            &["schemaVersion", "version", "backup", "sha256"],
        );
        roundtrip_update_record::<StagedRelease>(
            json!({"schemaVersion": 1, "version": "0.3.3", "platform": "win-x64"}),
            &["schemaVersion", "version", "platform"],
        );
        roundtrip_update_record::<Transaction>(
            json!({"schemaVersion": 1, "executable": "uapkg", "backup": "uapkg.backup", "previousSha256": "0".repeat(64), "nextSha256": "1".repeat(64), "nextVersion": "0.3.3"}),
            &[
                "schemaVersion",
                "executable",
                "backup",
                "previousSha256",
                "nextSha256",
                "nextVersion",
            ],
        );
    }

    #[test]
    fn transaction_extensions_do_not_relax_schema_version_or_path_validation() {
        let value = json!({"schemaVersion": 1, "executable": "uapkg", "backup": "uapkg.backup", "previousSha256": "0".repeat(64), "nextSha256": "1".repeat(64), "nextVersion": "0.3.3", "futureMetadata": {"nested": [null]}});
        let directory = tempfile::tempdir().unwrap();
        let parsed: Transaction = serde_json::from_value(value.clone()).unwrap();
        assert!(paths(directory.path(), &parsed).is_ok());
        assert!(parsed.extra_fields.contains_key("futureMetadata"));
        for (field, invalid) in [
            ("schemaVersion", json!(2)),
            ("executable", json!("../uapkg")),
            ("backup", json!("../backup")),
            ("nextVersion", json!("^0.3.3")),
        ] {
            let mut changed = value.clone();
            changed[field] = invalid;
            let transaction: Transaction = serde_json::from_value(changed).unwrap();
            assert!(
                paths(directory.path(), &transaction).is_err(),
                "Invalid {field} must fail"
            );
        }
    }

    #[test]
    fn new_update_records_serialize_only_their_own_known_fields() {
        let backup = BackupRecord {
            schema_version: 1,
            version: "0.3.3".into(),
            backup: "uapkg.backup".into(),
            sha256: "0".repeat(64),
            extra_fields: ExtraFields::new(),
        };
        assert_eq!(
            serde_json::to_value(backup)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            4
        );
        let staged = StagedRelease {
            schema_version: 1,
            version: "0.3.3".into(),
            platform: "win-x64".into(),
            extra_fields: ExtraFields::new(),
        };
        assert_eq!(
            serde_json::to_value(staged)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            3
        );
        let transaction = Transaction {
            schema_version: 1,
            executable: "uapkg".into(),
            backup: "uapkg.backup".into(),
            previous_sha256: "0".repeat(64),
            next_sha256: "1".repeat(64),
            next_version: "0.3.3".into(),
            extra_fields: ExtraFields::new(),
        };
        assert_eq!(
            serde_json::to_value(transaction)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            6
        );
    }

    #[test]
    fn marked_launcher_requires_healthy_latest_recovery_even_when_it_is_a_downgrade() {
        let directory = tempfile::tempdir().unwrap();
        let context = ContextPaths {
            home: directory.path().join("profile"),
            executable: directory.path().join("uapkg"),
            receipt: None,
        };
        let index = catalog::cache_moderated_fixture(&context, "launcher");
        for current in ["0.3.3", "0.3.2"] {
            let mut attempted = false;
            assert!(
                enforce_policy_with(&context, current, false, &index, |version, _| {
                    attempted = true;
                    assert_eq!(version, "0.3.1");
                    Ok(version.into())
                })
                .unwrap()
            );
            assert!(attempted);
            assert!(
                enforce_policy_with(&context, current, true, &index, |_, _| panic!(
                    "Offline recovery must not download"
                ))
                .is_err()
            );
            assert!(
                enforce_policy_with(&context, current, false, &index, |_, _| bail!(
                    "download failed"
                ))
                .unwrap_err()
                .to_string()
                .contains("command was refused")
            );
        }
        assert!(
            !enforce_policy_with(&context, "0.3.1", false, &index, |_, _| panic!(
                "Healthy launcher must continue"
            ))
            .unwrap()
        );
    }

    #[test]
    fn cleanup_removes_only_identified_quarantined_launcher_stages() {
        let directory = tempfile::tempdir().unwrap();
        let context = ContextPaths {
            home: directory.path().join("profile"),
            executable: directory.path().join("uapkg"),
            receipt: None,
        };
        let index = catalog::cache_moderated_fixture(&context, "launcher");
        for (name, version) in [
            (".uapkg-update-bad", "0.3.3"),
            (".uapkg-update-yanked", "0.3.2"),
        ] {
            let stage = directory.path().join(name);
            atomic_json(
                &stage.join(".release.json"),
                &StagedRelease {
                    schema_version: 1,
                    version: version.into(),
                    platform: platform().unwrap().into(),
                    extra_fields: ExtraFields::new(),
                },
            )
            .unwrap();
            fs::write(stage.join("launcher.tar.gz"), b"abandoned archive").unwrap();
        }
        let unknown = directory.path().join(".uapkg-update-unknown");
        fs::create_dir_all(&unknown).unwrap();
        fs::write(unknown.join("launcher.tar.gz"), b"unidentified archive").unwrap();
        purge_quarantined(&context, &index).unwrap();
        assert!(!directory.path().join(".uapkg-update-bad").exists());
        assert!(directory.path().join(".uapkg-update-yanked").exists());
        assert!(unknown.exists());
    }

    #[test]
    fn backup_cleanup_requires_recorded_identity_and_never_executes_backup_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let context = ContextPaths {
            home: directory.path().join("profile"),
            executable: directory.path().join("uapkg"),
            receipt: None,
        };
        let index = catalog::cache_moderated_fixture(&context, "launcher");
        let name = if cfg!(windows) {
            "uapkg.backup.exe"
        } else {
            "uapkg.backup"
        };
        let backup = directory.path().join(name);
        fs::write(&backup, b"arbitrary backup bytes; must not be executed").unwrap();
        purge_quarantined(&context, &index).unwrap();
        assert!(backup.exists(), "An unidentified orphan must be preserved");
        atomic_json(
            &directory.path().join(BACKUP_RECORD),
            &BackupRecord {
                schema_version: 1,
                version: "0.3.3".into(),
                backup: name.into(),
                sha256: "0".repeat(64),
                extra_fields: ExtraFields::new(),
            },
        )
        .unwrap();
        purge_quarantined(&context, &index).unwrap();
        assert!(backup.exists(), "A hash mismatch must preserve the orphan");
        atomic_json(
            &directory.path().join(BACKUP_RECORD),
            &BackupRecord {
                schema_version: 1,
                version: "0.3.3".into(),
                backup: name.into(),
                sha256: archive::sha256(&backup).unwrap(),
                extra_fields: ExtraFields::new(),
            },
        )
        .unwrap();
        purge_quarantined(&context, &index).unwrap();
        assert!(!backup.exists());
        assert!(!directory.path().join(BACKUP_RECORD).exists());
    }

    #[test]
    fn required_restart_failure_never_permits_continuing_on_the_running_launcher() {
        let directory = tempfile::tempdir().unwrap();
        let context = ContextPaths {
            home: directory.path().join("profile"),
            executable: directory.path().join("missing-launcher"),
            receipt: None,
        };
        assert!(
            resume_required(&context, &[])
                .unwrap_err()
                .to_string()
                .contains("command was refused")
        );
    }

    #[test]
    fn package_owned_marked_launchers_refuse_commands_without_modifying_installation() {
        let directory = tempfile::tempdir().unwrap();
        let mut context = ContextPaths {
            home: directory.path().join("profile"),
            executable: directory.path().join("uapkg"),
            receipt: None,
        };
        let index = catalog::cache_moderated_fixture(&context, "launcher");
        for owner in ["npm", "homebrew", "winget", "scoop"] {
            context.receipt = Some(crate::model::Receipt {
                schema_version: 1,
                install_method: owner.into(),
                default_cli_version: None,
                development: None,
                extra_fields: ExtraFields::new(),
            });
            let error = enforce_policy_with(&context, "0.3.3", false, &index, |_, _| {
                panic!("Package owner must perform the update")
            })
            .unwrap_err();
            assert!(format!("{error:#}").to_lowercase().contains(owner));
        }
        assert!(!context.executable.exists());
    }

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
            &serde_json::json!({"selector":"0.1.2", "version":"0.1.2", "futureMetadata":{"nested":[null,1]}}),
        )
        .unwrap();
        let action = maintain(&context, true, false, MinimumReleaseAge::parse("3d"));
        assert_eq!(tracked_selector(&context).unwrap(), "0.1.2");
        assert!(!action.restart);
        assert!(action.notices.is_empty());
        assert!(!maintenance::launcher_directory(&context).exists());
    }

    #[test]
    fn automatic_launcher_maintenance_obeys_cooldown_without_changing_aliases() {
        let directory = tempfile::tempdir().unwrap();
        let context = ContextPaths {
            home: directory.path().join("profile"),
            executable: directory.path().join("uapkg"),
            receipt: None,
        };
        let index: Index = serde_json::from_value(serde_json::json!({
            "schemaVersion":1,"product":"launcher","aliases":{"latest":"1.2.0"},
            "releases":[
                {"version":"1.0.0","date":"2026-11-01","files":[platform().unwrap()]},
                {"version":"1.1.0","date":"2026-11-15T12:00:00Z","files":[platform().unwrap()]},
                {"version":"1.2.0","date":"2026-11-18T12:00:00Z","files":[platform().unwrap()]}
            ]
        }))
        .unwrap();
        let now = Some("2026-11-18T12:00:00Z".parse().unwrap());
        for (current, age, automatic, expected) in [
            ("1.0.0", "3d", true, Some("1.1.0")),
            ("1.0.0", "0", true, Some("1.2.0")),
            ("1.0.0", "1w", true, None),
            ("1.1.0", "3d", true, None),
            ("1.2.0", "0s", true, None),
            ("1.0.0", "0", false, None),
        ] {
            let mut attempted = false;
            let result = maintain_selected(
                &context,
                "latest",
                current,
                &index,
                automatic.then_some((MinimumReleaseAge::parse(age), now)),
                |version, _| {
                    attempted = true;
                    assert_eq!(Some(version), expected);
                    Ok(Replacement::Installed)
                },
            )
            .unwrap();
            assert_eq!(attempted, expected.is_some());
            assert_eq!(result.restart, expected.is_some());
            if !result.restart && current != "1.2.0" {
                assert!(result.notices.iter().any(|notice| notice.contains("1.2.0")));
            }
            assert_eq!(index.aliases["latest"], "1.2.0");
            assert!(!context.home.exists());
        }
        let result = maintain_selected(
            &context,
            "latest",
            "1.0.0",
            &index,
            Some((MinimumReleaseAge::parse("3d"), now)),
            |_, _| anyhow::bail!("integrity verification failed"),
        )
        .unwrap();
        assert!(!result.restart);
        assert!(!result.notices.is_empty());
    }
}
