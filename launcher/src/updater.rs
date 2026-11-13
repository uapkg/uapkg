use crate::{
    archive, github,
    model::{VERSION, exact_version, platform, read_json, relative_path},
    storage::{ContextPaths, atomic_json, lock},
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
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

fn health(executable: &Path, expected_version: &str) -> Result<()> {
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
    ensure!(
        status.success() && String::from_utf8_lossy(&stdout).trim() == expected_version,
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
    fs::remove_file(directory.join(JOURNAL))?;
    remove_backup(&backup)?;
    Ok(())
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
        fs::remove_file(journal)?;
        if backup.exists() {
            remove_backup(&backup)?;
        }
        return Ok(());
    }
    if current_hash.as_deref() == Some(&transaction.previous_sha256) {
        fs::remove_file(journal)?;
        if backup.exists() {
            remove_backup(&backup)?;
        }
        return Ok(());
    }
    rollback(directory, &transaction)?;
    bail!("Recovered the previous launcher after an interrupted update. Run the command again.")
}

fn remove_backup(backup: &Path) -> Result<()> {
    if std::env::current_exe()?.canonicalize()? == backup.canonicalize()? {
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
            "npm owns this launcher installation. Update it with npm; self-update will not replace package-manager files."
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

pub fn update(context: &ContextPaths, requested: Option<&str>) -> Result<()> {
    ownership_instructions(context.ownership())?;
    let requested = requested.map(exact_version).transpose()?;
    let client = github::client()?;
    let current = exact_version(VERSION)?;
    let mut selected: Option<github::VerifiedRelease> = None;
    for version in github::release_versions(&client)? {
        let verified = match github::release(&client, &version.to_string()) {
            Ok(release) => release,
            Err(error) if github::is_not_found(&error) => continue,
            Err(error) => return Err(error),
        };
        let launcher = exact_version(&verified.release.launcher_version)?;
        if let Some(requested) = &requested {
            if &launcher != requested {
                continue;
            }
        } else if !launcher.pre.is_empty() || launcher <= current {
            continue;
        }
        if selected.as_ref().is_none_or(|old| {
            exact_version(&old.release.launcher_version).is_ok_and(|old| launcher > old)
        }) {
            selected = Some(verified);
        }
    }
    let Some(verified) = selected else {
        if let Some(requested) = requested {
            bail!(
                "Launcher {requested} is not available in signed UAPKG CLI releases. No other version was installed."
            );
        }
        println!("Launcher {VERSION} is up to date.");
        return Ok(());
    };
    let directory = context
        .executable
        .parent()
        .context("Launcher has no installation directory.")?;
    let stage = tempfile::Builder::new()
        .prefix(".uapkg-update-")
        .tempdir_in(directory)
        .context(
            "The launcher installation is not writable. Reinstall it in a directory you own.",
        )?;
    let artifact = verified.release.artifact("launcher", platform()?)?;
    let archive_path = stage.path().join("launcher.tar.gz");
    github::download_artifact(
        &client,
        &verified.release.cli_version,
        artifact,
        &archive_path,
    )?;
    let unpacked = stage.path().join("unpacked");
    archive::extract(&archive_path, &unpacked)?;
    let next = unpacked.join(if cfg!(windows) { "uapkg.exe" } else { "uapkg" });
    ensure!(
        next.is_file(),
        "Launcher archive is missing its executable."
    );
    replace_staged(context, &next, &verified.release.launcher_version)
}

/// Complete a replacement after the caller has verified and extracted a signed
/// artifact. This phase is separate so recovery and the platform replacement
/// helper can be tested without publishing a release or using the network.
pub fn replace_staged(context: &ContextPaths, next: &Path, version: &str) -> Result<()> {
    ownership_instructions(context.ownership())?;
    exact_version(version)?;
    ensure!(
        context.executable.canonicalize()? == std::env::current_exe()?.canonicalize()?,
        "Only the running launcher can replace itself."
    );
    let directory = context
        .executable
        .parent()
        .context("Launcher has no installation directory.")?;
    let _lock = lock(&directory.join("uapkg-update.lock"))?;
    ensure!(
        !directory.join(JOURNAL).exists(),
        "An earlier launcher update needs recovery. Run UAPKG again before updating."
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
    ensure!(
        !backup.exists(),
        "A launcher backup already exists at {}. Keep it until you have checked the current installation.",
        backup.display()
    );
    let previous_sha256 = archive::sha256(&context.executable)?;
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
            != Some(&transaction.previous_sha256)
        {
            rollback(directory, &transaction)?;
        }
        return Err(error).context("Could not replace the launcher. The verified backup and update record are available for recovery.");
    }
    if let Err(error) = health(&context.executable, &transaction.next_version) {
        rollback(directory, &transaction)?;
        return Err(error)
            .context("The updated launcher failed its check; the previous launcher was restored.");
    }
    fs::remove_file(directory.join(JOURNAL))?;
    fs::remove_file(backup)?;
    println!(
        "Updated launcher to {}. Your default CLI and project pins are unchanged.",
        transaction.next_version
    );
    Ok(())
}
