use crate::model::{Receipt, Settings, exact_version, read_json, relative_path};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::LazyLock,
};
use uapkg_slim_config::{Resolver, Scope, Source, TraceStatus};

static CONFIG_RESOLVER: LazyLock<std::result::Result<Resolver, String>> =
    LazyLock::new(Resolver::new);

pub struct ContextPaths {
    pub home: PathBuf,
    pub executable: PathBuf,
    pub receipt: Option<Receipt>,
}

impl ContextPaths {
    pub fn load() -> Result<Self> {
        let executable =
            std::env::current_exe().context("Could not locate the launcher executable.")?;
        Self::for_executable(executable)
    }

    pub fn for_executable(executable: PathBuf) -> Result<Self> {
        let receipt_path = executable
            .parent()
            .context("Launcher has no installation directory.")?
            .join("uapkg-install.json");
        let receipt: Option<Receipt> = if receipt_path.exists() {
            Some(read_json(&receipt_path)?)
        } else {
            None
        };
        if let Some(receipt) = &receipt {
            ensure!(
                receipt.schema_version == 1,
                "Unsupported installation receipt version."
            );
            ensure!(
                matches!(
                    receipt.install_method.as_str(),
                    "standalone" | "npm" | "winget" | "homebrew" | "scoop" | "development"
                ),
                "Unsupported installation method {}.",
                receipt.install_method
            );
            if receipt.install_method == "development" {
                ensure!(
                    cfg!(feature = "development"),
                    "This launcher does not support development bindings. Build it with --features development."
                );
                let development = receipt
                    .development
                    .as_ref()
                    .context("Development installation is missing its checkout binding.")?;
                ensure!(
                    development.engine_path.is_absolute()
                        && development.node_path.is_absolute()
                        && development.checkout_path.is_absolute(),
                    "Development binding paths must be absolute."
                );
            } else {
                ensure!(
                    receipt.development.is_none(),
                    "Development bindings require a development installation receipt."
                );
            }
            if let Some(version) = &receipt.default_cli_version {
                crate::catalog::selector(version)?;
            }
        }
        let development = receipt
            .as_ref()
            .is_some_and(|r| r.install_method == "development");
        let user_home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .context("Could not find your home directory.")?;
        let home = PathBuf::from(user_home).join(if development {
            ".uapkg-development"
        } else {
            ".uapkg"
        });
        Ok(Self {
            home,
            executable,
            receipt,
        })
    }

    pub fn settings(&self) -> Result<Settings> {
        self.settings_at(&self.home, Scope::Global)
    }

    pub fn settings_at(&self, cwd: &Path, scope: Scope) -> Result<Settings> {
        let resolver = CONFIG_RESOLVER
            .as_ref()
            .map_err(|message| anyhow::anyhow!(message.clone()))?;
        let resolved = resolver.resolve(&self.home, cwd, scope);
        for diagnostic in &resolved.diagnostics {
            eprintln!("uapkg: warning: {diagnostic}");
        }
        let version_path = "launcher.defaultCliVersion";
        let global_cli_version = resolved.trace.get(version_path).and_then(|entries| {
            entries
                .iter()
                .rev()
                .find(|entry| {
                    entry.status == TraceStatus::Accepted
                        && matches!(entry.origin.source, Source::Default | Source::Global)
                })
                .and_then(|entry| entry.value.as_str().map(str::to_owned))
        });
        // These are projections of the validated generated schema, not a second
        // schema or a set of launcher-owned defaults.
        Ok(Settings {
            default_cli_version: resolved
                .get(version_path)
                .and_then(|value| value.as_str())
                .map(str::to_owned),
            auto_launcher_update: resolved
                .get("launcher.autoLauncherUpdate")
                .and_then(|value| value.as_bool())
                .context("Embedded config schema is missing autoLauncherUpdate.")?,
            auto_cli_update: resolved
                .get("launcher.autoCLIUpdate")
                .and_then(|value| value.as_bool())
                .context("Embedded config schema is missing autoCLIUpdate.")?,
            global_cli_version,
            config_source: resolved
                .origin(version_path)
                .context("Embedded config schema is missing defaultCliVersion.")?
                .source,
            config_file: resolved
                .origin(version_path)
                .and_then(|origin| origin.file.clone()),
        })
    }

    pub fn default_version<'a>(&'a self, settings: &'a Settings) -> Option<&'a str> {
        settings.default_cli_version.as_deref()
    }

    pub fn cache_dir(&self, version: &str, platform: &str) -> Result<PathBuf> {
        exact_version(version)?;
        ensure!(
            relative_path(platform)?.components().count() == 1,
            "Invalid platform."
        );
        Ok(self.home.join("engines").join(version).join(platform))
    }

    pub fn ownership(&self) -> &str {
        self.receipt
            .as_ref()
            .map(|r| r.install_method.as_str())
            .unwrap_or(option_env!("UAPKG_INSTALL_METHOD").unwrap_or("standalone"))
    }
}

/// File locks release automatically on process termination; stale lock files are
/// harmless and must never be removed while another process can be using them.
pub(crate) fn open_lock(path: &Path) -> Result<File> {
    fs::create_dir_all(path.parent().context("Lock path has no parent.")?)?;
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("Could not open {}.", path.display()))
}

pub fn lock(path: &Path) -> Result<File> {
    let file = open_lock(path)?;
    file.lock()
        .with_context(|| format!("Could not lock {}.", path.display()))?;
    Ok(file)
}

pub fn atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let directory = path.parent().context("Metadata path has no parent.")?;
    fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer_pretty(&mut temporary, value)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("Could not save {}.", path.display()))?;
    Ok(())
}
