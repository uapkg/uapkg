use crate::model::relative_path;
use anyhow::{Context, Result, ensure};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub fn sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub fn verify_file(path: &Path, size: u64, digest: &str) -> Result<()> {
    ensure!(
        fs::metadata(path)?.len() == size,
        "Downloaded artifact size does not match its signed metadata."
    );
    ensure!(
        sha256(path)?.eq_ignore_ascii_case(digest),
        "Downloaded artifact checksum does not match its signed metadata. Nothing was installed."
    );
    Ok(())
}

/// Extract only ordinary files/directories into a new empty staging directory.
/// Links, duplicates, traversal, platform-specific aliases, and huge entries are
/// rejected before the archive can become executable.
pub fn extract(archive: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    ensure!(
        fs::read_dir(destination)?.next().is_none(),
        "Archive destination must be empty."
    );
    let mut input = tar::Archive::new(GzDecoder::new(File::open(archive)?));
    let mut seen = HashSet::new();
    let mut total = 0_u64;
    let mut count = 0_u64;
    for entry in input.entries()? {
        let mut entry = entry?;
        count += 1;
        ensure!(count <= 200_000, "Archive contains too many entries.");
        let raw = entry.path()?.into_owned();
        let raw = raw.to_str().context("Archive path must be UTF-8.")?;
        // Standard tar tools may put a harmless ./ in front of entries.
        let raw = raw.strip_prefix("./").unwrap_or(raw).trim_end_matches('/');
        if raw.is_empty() {
            ensure!(
                entry.header().entry_type().is_dir(),
                "Invalid archive root."
            );
            continue;
        }
        let relative = relative_path(raw)?;
        ensure!(
            seen.insert(raw.to_lowercase()),
            "Archive contains duplicate paths: {raw}."
        );
        let kind = entry.header().entry_type();
        ensure!(
            kind.is_file() || kind.is_dir(),
            "Archive links and special files are not permitted: {raw}."
        );
        total = total
            .checked_add(entry.size())
            .context("Archive size overflow.")?;
        ensure!(
            total <= 4 * 1024 * 1024 * 1024,
            "Archive exceeds the extraction size limit."
        );
        let path = destination.join(relative);
        if kind.is_dir() {
            fs::create_dir_all(&path)?;
            continue;
        }
        fs::create_dir_all(path.parent().context("Invalid archive parent.")?)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        std::io::copy(&mut entry, &mut output)?;
        output.flush()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if entry.header().mode()? & 0o111 != 0 {
                0o755
            } else {
                0o644
            };
            fs::set_permissions(&path, fs::Permissions::from_mode(mode))?;
        }
    }
    Ok(())
}
