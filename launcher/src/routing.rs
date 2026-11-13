use crate::model::exact_version;
use anyhow::{Context, Result, bail, ensure};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq, Eq)]
pub enum Scope {
    Launcher,
    Global,
    Project,
}

#[derive(Debug)]
pub struct Invocation {
    pub args: Vec<OsString>,
    pub command: Option<String>,
    pub command_index: Option<usize>,
    pub override_version: Option<String>,
    pub offline: bool,
}

impl Invocation {
    pub fn parse(input: Vec<OsString>) -> Result<Self> {
        let mut args = Vec::new();
        let mut override_version = None;
        let mut iter = input.into_iter();
        let mut option_value = false;
        let mut offline = std::env::var_os("UAPKG_OFFLINE").is_some_and(|value| value == "1");
        while let Some(arg) = iter.next() {
            if arg == "--" {
                args.push(arg);
                args.extend(iter);
                break;
            }
            let text = arg.to_str().unwrap_or_default();
            if option_value {
                option_value = false;
                args.push(arg);
                continue;
            }
            if text == "--offline" {
                offline = true;
                continue;
            }
            if text == "--cli-version" || text.starts_with("--cli-version=") {
                ensure!(
                    override_version.is_none(),
                    "Specify --cli-version only once."
                );
                let value = if let Some(value) = text.strip_prefix("--cli-version=") {
                    value.to_owned()
                } else {
                    iter.next()
                        .context("--cli-version requires an exact version.")?
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("CLI versions must be UTF-8."))?
                };
                exact_version(&value)?;
                override_version = Some(value);
            } else {
                if matches!(text, "--registry" | "--config") {
                    option_value = true;
                }
                args.push(arg);
            }
        }
        let mut command_index = None;
        let mut skip_value = false;
        for (index, arg) in args.iter().enumerate() {
            if skip_value {
                skip_value = false;
                continue;
            }
            let text = arg.to_str().unwrap_or_default();
            if text == "--" {
                break;
            }
            // These are existing string-valued CLI options. Unknown options are
            // left untouched so future project CLI versions can interpret them.
            if matches!(text, "--registry" | "--config") {
                skip_value = true;
                continue;
            }
            if !text.starts_with('-') {
                command_index = Some(index);
                break;
            }
        }
        let command = command_index.and_then(|index| args[index].to_str().map(str::to_owned));
        Ok(Self {
            args,
            command,
            command_index,
            override_version,
            offline,
        })
    }

    pub fn scope(&self) -> Scope {
        match self.command.as_deref() {
            Some("launcher" | "version" | "self-update") => Scope::Launcher,
            Some("login" | "logout" | "whoami") => Scope::Global,
            _ => Scope::Project,
        }
    }

    pub fn command_args(&self) -> Result<Vec<String>> {
        let index = self.command_index.context("Expected a launcher command.")?;
        ensure!(
            index == 0,
            "Place launcher commands before other arguments."
        );
        ensure!(
            self.override_version.is_none()
                || (self.command.as_deref() == Some("version")
                    && self.args[index + 1..] == [OsString::from("current")]),
            "--cli-version only applies to delegated CLI commands and version current."
        );
        self.args[index + 1..]
            .iter()
            .map(|s| {
                s.to_str()
                    .map(str::to_owned)
                    .context("Launcher arguments must be UTF-8.")
            })
            .collect()
    }
}

#[derive(Debug)]
pub struct Project {
    pub manifest: PathBuf,
    pub version: Option<String>,
}

#[derive(Debug)]
pub enum ProjectSelection {
    None,
    Unpinned,
    Pinned(String),
}

impl ProjectSelection {
    pub fn diagnostic(&self) -> (&'static str, Option<String>) {
        match self {
            Self::None => ("none", None),
            Self::Unpinned => ("unpinned", None),
            Self::Pinned(version) => ("pinned", Some(version.clone())),
        }
    }
}

pub struct VersionSelection {
    pub version: String,
    pub reason: &'static str,
    pub project: Option<ProjectSelection>,
}

pub fn discover_project(cwd: &Path) -> Result<Option<Project>> {
    for directory in cwd.ancestors() {
        let manifest = directory.join("uapkg.json");
        let content = match fs::read(&manifest) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Could not read {}.", manifest.display()));
            }
        };
        let value: serde_json::Value = serde_json::from_slice(&content)
            .with_context(|| format!("Invalid JSON in {}.", manifest.display()))?;
        match value.get("kind").and_then(|v| v.as_str()) {
            Some("plugin") => continue,
            Some("project") => {
                let version = match value.get("uapkgVersion") {
                    None => None,
                    Some(serde_json::Value::String(version)) => {
                        exact_version(version).with_context(|| {
                            format!("Invalid uapkgVersion in {}.", manifest.display())
                        })?;
                        Some(version.clone())
                    }
                    Some(_) => bail!(
                        "uapkgVersion in {} must be an exact version string.",
                        manifest.display()
                    ),
                };
                return Ok(Some(Project { manifest, version }));
            }
            _ => bail!(
                "{} must declare kind: project or kind: plugin.",
                manifest.display()
            ),
        }
    }
    Ok(None)
}

pub fn select_version(
    invocation: &Invocation,
    cwd: &Path,
    default: Option<&str>,
) -> Result<String> {
    Ok(select(invocation, cwd, default)?.version)
}

pub fn select(
    invocation: &Invocation,
    cwd: &Path,
    default: Option<&str>,
) -> Result<VersionSelection> {
    if let Some(version) = &invocation.override_version {
        return Ok(VersionSelection {
            version: version.clone(),
            reason: "override",
            project: None,
        });
    }
    let project = if invocation.scope() == Scope::Project {
        match discover_project(cwd)? {
            Some(Project {
                version: Some(version),
                ..
            }) => {
                return Ok(VersionSelection {
                    version: version.clone(),
                    reason: "project-pin",
                    project: Some(ProjectSelection::Pinned(version)),
                });
            }
            Some(_) => Some(ProjectSelection::Unpinned),
            None => Some(ProjectSelection::None),
        }
    } else {
        None
    };
    let version = default.context("No default CLI version is configured. Run `uapkg version default <exact-version>` or install a full UAPKG bundle.")?;
    exact_version(version)?;
    Ok(VersionSelection {
        version: version.to_owned(),
        reason: if invocation.scope() == Scope::Global {
            "global-command"
        } else {
            "global-default"
        },
        project,
    })
}
