use crate::{
    model::{Settings, Source, VERSION},
    routing::{Invocation, ProjectSelection, VersionSelection, discover_project},
    storage::ContextPaths,
};
use anyhow::Result;
use serde::Serialize;
use std::{ffi::OsString, path::Path, process::Command};

pub const CONTEXT_ENV: &str = "UAPKG_LAUNCHER_CONTEXT";

/// Diagnostics are produced by the TypeScript CLI. This is only the bounded
/// routing metadata which that process cannot reconstruct after delegation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherContext {
    schema_version: u32,
    launcher_version: &'static str,
    launcher_path: String,
    install_method: String,
    cli_source: Option<Source>,
    global_settings_state: &'static str,
    global_cli_version: Option<String>,
    project_cli_version: Option<String>,
    project_state: &'static str,
    override_cli_version: Option<String>,
    selected_cli_version: String,
    selection_reason: &'static str,
    engine_kind: String,
    offline: bool,
}

pub fn requested(args: &[OsString]) -> bool {
    let mut requested = false;
    let mut informational = false;
    let mut value = false;
    for arg in args {
        if arg == "--" {
            break;
        }
        if value {
            value = false;
            continue;
        }
        match arg.to_str() {
            Some("--registry" | "--config") => value = true,
            Some("--debug-info" | "--debug-info=true") => requested = true,
            Some("--debug-info=false" | "--no-debug-info") => requested = false,
            Some("--help" | "-h" | "--help=true" | "--version" | "--version=true") => {
                informational = true
            }
            _ => {}
        }
    }
    requested && !informational
}

fn project(
    cwd: Option<&Path>,
    observed: Option<&ProjectSelection>,
) -> (&'static str, Option<String>) {
    if let Some(observed) = observed {
        return observed.diagnostic();
    }
    let Some(cwd) = cwd else {
        return ("unavailable", None);
    };
    match discover_project(cwd) {
        Ok(Some(project)) => match project.version {
            Some(version) => ("pinned", Some(version)),
            None => ("unpinned", None),
        },
        Ok(None) => ("none", None),
        Err(_) => ("unavailable", None),
    }
}

fn build(
    context: &ContextPaths,
    invocation: &Invocation,
    settings: Option<&Settings>,
    selection: &VersionSelection,
    engine_kind: &str,
    cwd: Option<&Path>,
) -> LauncherContext {
    let (project_state, project_cli_version) = project(cwd, selection.project.as_ref());
    LauncherContext {
        schema_version: 1,
        launcher_version: VERSION,
        launcher_path: context.executable.to_string_lossy().into_owned(),
        install_method: context.ownership().to_owned(),
        cli_source: settings.map(|settings| settings.cli_source),
        global_settings_state: if settings.is_some() {
            "available"
        } else {
            "unavailable"
        },
        global_cli_version: settings
            .and_then(|settings| context.default_version(settings).map(str::to_owned)),
        project_cli_version,
        project_state,
        override_cli_version: invocation.override_version.clone(),
        selected_cli_version: selection.version.clone(),
        selection_reason: selection.reason,
        engine_kind: engine_kind.to_owned(),
        offline: invocation.offline,
    }
}

pub fn for_release(
    context: &ContextPaths,
    invocation: &Invocation,
    settings: &Settings,
    selection: &VersionSelection,
    engine_kind: &str,
    cwd: &Path,
) -> Option<LauncherContext> {
    requested(&invocation.args).then(|| {
        build(
            context,
            invocation,
            Some(settings),
            selection,
            engine_kind,
            Some(cwd),
        )
    })
}

pub fn for_development(context: &ContextPaths, invocation: &Invocation) -> Option<LauncherContext> {
    if !requested(&invocation.args) {
        return None;
    }
    let version = context.receipt.as_ref()?.default_cli_version.clone()?;
    // A local checkout is runnable even when global configuration or an ancestor
    // manifest is damaged. Report only failure availability rather than raw
    // configuration, project paths, or errors from those failed reads.
    let settings = context.settings().ok();
    let cwd = std::env::current_dir().ok();
    let selection = VersionSelection {
        version,
        reason: "development",
        project: None,
    };
    Some(build(
        context,
        invocation,
        settings.as_ref(),
        &selection,
        "development",
        cwd.as_deref(),
    ))
}

pub fn apply(command: &mut Command, context: Option<&LauncherContext>) -> Result<()> {
    command.env_remove(CONTEXT_ENV);
    if let Some(context) = context {
        command.env(CONTEXT_ENV, serde_json::to_string(context)?);
    }
    Ok(())
}
