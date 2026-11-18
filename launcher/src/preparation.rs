use crate::{
    catalog::{self, Resolution},
    diagnostics,
    engines::{self, InstalledEngine},
    maintenance,
    model::Settings,
    routing::{self, Invocation, Scope, VersionSelection},
    storage::ContextPaths,
};
use anyhow::Result;
use std::path::Path;

pub(crate) struct PreparedCli {
    pub selection: VersionSelection,
    pub resolution: Resolution,
    pub installed: InstalledEngine,
}

pub(crate) fn allows_optional_maintenance(invocation: &Invocation) -> bool {
    !invocation.offline && !diagnostics::requested(&invocation.args)
}

pub(crate) fn prepare(
    context: &ContextPaths,
    invocation: &Invocation,
    settings: &Settings,
    cwd: &Path,
) -> Result<PreparedCli> {
    prepare_with(
        context,
        invocation,
        settings,
        cwd,
        |version, offline| catalog::resolve(context, "cli", version, offline, false),
        |resolution| maintenance::maintain_cli(context, resolution, settings.auto_cli_update),
        |version, offline, reason| {
            engines::ensure_installed_with_reason(context, version, offline, Some(reason))
        },
    )
}

// Only acquisition boundaries are replaceable: selection, cache transactions,
// and successful alias activation use the same path for diagnostics and commands.
fn prepare_with(
    context: &ContextPaths,
    invocation: &Invocation,
    settings: &Settings,
    cwd: &Path,
    resolve: impl FnOnce(&str, bool) -> Result<Resolution>,
    update: impl FnOnce(&mut Resolution) -> Option<InstalledEngine>,
    install: impl FnOnce(&str, bool, &str) -> Result<InstalledEngine>,
) -> Result<PreparedCli> {
    let scope = match invocation.scope() {
        Scope::Launcher => Scope::Global,
        scope => scope,
    };
    let mut selection = routing::select(invocation, scope, cwd, context.default_version(settings))?;
    let allow_optional_maintenance = allows_optional_maintenance(invocation);
    let default_latest = selection.uses_default_latest();
    let active = if default_latest {
        catalog::active_version(context, "cli", "latest")?
    } else {
        None
    };
    let known_active = active.is_some();
    // Required bootstrap also paces ordinary update checks. Diagnostics skip
    // that optional bookkeeping while retaining normal required acquisition.
    let bootstrap = if default_latest && allow_optional_maintenance && !known_active {
        maintenance::claim(&maintenance::cli_directory(context), false)
            .ok()
            .flatten()
    } else {
        None
    };
    let mut resolution = if let Some(version) = active {
        Resolution {
            requested: "latest".into(),
            version,
            messages: vec![],
        }
    } else {
        resolve(&selection.version, invocation.offline)?
    };
    let updated = if known_active && allow_optional_maintenance {
        update(&mut resolution)
    } else {
        None
    };
    let installed = match updated {
        Some(installed) => installed,
        None => install(
            &resolution.version,
            invocation.offline,
            &selection.install_reason(&resolution.version),
        )?,
    };
    selection.version.clone_from(&resolution.version);
    if !known_active {
        catalog::activate(context, "cli", &resolution)?;
    }
    drop(bootstrap);
    Ok(PreparedCli {
        selection,
        resolution,
        installed,
    })
}

#[cfg(test)]
mod tests;
