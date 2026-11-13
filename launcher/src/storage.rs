use crate::model::{Receipt, Settings, Source, exact_version, read_json, relative_path};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

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
                exact_version(version)?;
            }
            if let Some(engine) = &receipt.bundled_engine {
                relative_path(engine)?;
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
        let path = self.home.join("config.json");
        if !path.exists() {
            return Ok(Settings::default());
        }
        let global: serde_json::Value = read_json(&path)?;
        let global = global
            .as_object()
            .with_context(|| format!("{} must contain a JSON object.", path.display()))?;
        let Some(launcher) = global.get("launcher") else {
            return Ok(Settings::default());
        };
        let launcher = launcher
            .as_object()
            .with_context(|| format!("launcher in {} must be an object.", path.display()))?;
        let mut settings = Settings::default();
        if let Some(source) = launcher.get("cliSource") {
            let source = source.as_str().with_context(|| {
                format!(
                    "launcher.cliSource in {} must be github-releases or npm.",
                    path.display()
                )
            })?;
            settings.cli_source = Source::parse(source)
                .with_context(|| format!("Invalid launcher.cliSource in {}.", path.display()))?;
        }
        if let Some(version) = launcher.get("defaultCliVersion") {
            let version = version.as_str().with_context(|| {
                format!(
                    "launcher.defaultCliVersion in {} must be an exact version string.",
                    path.display()
                )
            })?;
            exact_version(version).with_context(|| {
                format!("Invalid launcher.defaultCliVersion in {}.", path.display())
            })?;
            settings.default_cli_version = Some(version.to_owned());
        }
        // The TypeScript config module owns validation and persistence of the
        // full config tree. Routing reads only these two global values, never
        // project config or unrelated settings introduced by another CLI.
        Ok(settings)
    }

    pub fn default_version<'a>(&'a self, settings: &'a Settings) -> Option<&'a str> {
        settings.default_cli_version.as_deref().or_else(|| {
            self.receipt
                .as_ref()
                .and_then(|r| r.default_cli_version.as_deref())
        })
    }

    pub fn cache_dir(&self, source: Source, version: &str, platform: &str) -> Result<PathBuf> {
        exact_version(version)?;
        ensure!(
            relative_path(platform)?.components().count() == 1,
            "Invalid platform."
        );
        Ok(self
            .home
            .join("engines")
            .join(source.name())
            .join(version)
            .join(platform))
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
pub fn lock(path: &Path) -> Result<File> {
    fs::create_dir_all(path.parent().context("Lock path has no parent.")?)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("Could not open {}.", path.display()))?;
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
