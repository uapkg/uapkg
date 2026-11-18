pub mod archive;
mod banner;
pub mod catalog;
pub mod diagnostics;
pub mod engines;
pub mod github;
mod listings;
mod maintenance;
pub mod model;
mod preparation;
pub mod release_age;
pub mod routing;
pub mod storage;
pub mod updater;

use anyhow::{Context, Result, bail, ensure};
use model::VERSION;
use routing::{Invocation, Scope};
use std::{ffi::OsString, io::Write, process::Command};
use storage::ContextPaths;

pub fn run(args: Vec<OsString>) -> Result<i32> {
    banner::development();
    let invocation = Invocation::parse(args.clone())?;
    let debug_info = diagnostics::requested(&invocation.args);
    // Build identity checks validate staged executables without loading a
    // profile or entering update recovery recursively.
    if invocation.command.as_deref() == Some("launcher") && !debug_info {
        let args = invocation.command_args()?;
        if args == ["--version"] {
            println!("{VERSION}");
            return Ok(0);
        }
        if args == ["--platform"] {
            println!("{}", model::platform()?);
            return Ok(0);
        }
    }
    let context = ContextPaths::load()?;
    if !debug_info && let Some(target) = updater::recover_installation(&context)? {
        let recovered = ContextPaths::for_executable(target)?;
        return updater::resume_required(&recovered, &args);
    }
    let explicit_updater = invocation.command.as_deref() == Some("launcher-update") && !debug_info;
    let policy = if context.ownership() != "development" && !explicit_updater {
        let refreshed = maintenance::refresh_policy(&context, invocation.offline)?;
        // Explicit updater commands remain available even if latest is absent.
        if updater::enforce_policy(&context, invocation.offline)? {
            return updater::resume_required(&context, &args);
        }
        refreshed
    } else {
        maintenance::PolicyRefresh::default()
    };
    if invocation.scope() == Scope::Launcher && !debug_info {
        return launcher_command(&context, &invocation);
    }
    let settings = if context.ownership() == "development" {
        None
    } else {
        let config_scope = if invocation.scope() == Scope::Launcher {
            uapkg_slim_config::Scope::Global
        } else {
            uapkg_slim_config::Scope::Effective
        };
        Some(context.settings_at(&std::env::current_dir()?, config_scope)?)
    };
    let mut launcher_notices = vec![];
    if let Some(settings) = &settings
        && preparation::allows_optional_maintenance(&invocation)
    {
        let update = updater::maintain(
            &context,
            settings.auto_launcher_update,
            policy.launcher_fresh,
            settings.minimum_release_age,
        );
        if update.restart
            && let Some(code) = updater::resume(&context, &args)?
        {
            return Ok(code);
        }
        launcher_notices = update.notices;
    }
    if invocation.command.is_none()
        && (invocation.args.is_empty()
            || invocation
                .args
                .iter()
                .any(|arg| arg == "--help" || arg == "-h"))
    {
        println!(
            "Launcher commands: launcher, version, launcher-update. See `uapkg launcher --help`.\nLauncher options: --cli-version <version-selector>, --offline. Place them anywhere after uapkg, before --.\n"
        );
        std::io::stdout().flush()?;
    }
    let Some(settings) = settings else {
        ensure!(
            invocation.override_version.is_none(),
            "--cli-version is unavailable for a development checkout binding. Use an official launcher for released CLI versions."
        );
        let diagnostic = diagnostics::for_development(&context, &invocation);
        return delegate_development(&context, &invocation.args, diagnostic.as_ref());
    };
    let cwd = std::env::current_dir()?;
    let preparation::PreparedCli {
        selection,
        mut resolution,
        installed,
    } = preparation::prepare(&context, &invocation, &settings, &cwd, policy.cli_fresh)?;
    resolution.messages.extend(launcher_notices);
    let diagnostic = diagnostics::for_release(
        &context,
        &invocation,
        &settings,
        &selection,
        &installed.engine.kind,
        &cwd,
    );
    engines::delegate(
        &context,
        &installed,
        &invocation.args,
        diagnostic.as_ref(),
        &resolution.messages,
    )
}

fn launcher_command(context: &ContextPaths, invocation: &Invocation) -> Result<i32> {
    let args = invocation.command_args()?;
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    match (invocation.command.as_deref(), args.as_slice()) {
        (Some("launcher"), ["--help"] | ["-h"] | []) => {
            println!(
                "UAPKG launcher\n\n  launcher --version\n  launcher --platform\n  version install <version-selector>\n  version list [available]\n  version default [version-selector]\n  version current\n  launcher-update [launcher-version]\n\nSelectors: exact versions, latest, or a base-scoped preview such as 1.6.0-alpha.\n\nLauncher options may appear anywhere after uapkg, before --:\n  uapkg install --cli-version <version-selector>\n  uapkg --version --cli-version <version-selector>\n  uapkg version list --cli-version <version-selector>\n  uapkg install --offline\n\n--cli-version overrides CLI version selection.\n--offline prohibits launcher downloads.\nArguments after -- are passed to the CLI unchanged."
            );
        }
        (Some("version"), ["install", version]) => {
            let _check = track_explicit_cli_check(context, version, invocation.offline)?;
            let resolution = catalog::resolve(context, "cli", version, invocation.offline, true)?;
            catalog::emit(&resolution.messages);
            let installed =
                engines::ensure_installed(context, &resolution.version, invocation.offline)?;
            catalog::activate(context, "cli", &resolution)?;
            println!(
                "CLI {} is installed at {}.",
                installed.engine.version,
                installed.root.display()
            );
            catalog::emit(&resolution.messages);
        }
        (Some("version"), ["list"]) => {
            print!(
                "{}",
                listings::local(context, invocation, &std::env::current_dir()?)?
            );
        }
        (Some("version"), ["list", "available"]) => {
            print!("{}", listings::available(context, invocation.offline)?);
        }
        (Some("version"), ["default"]) => {
            let settings = context.settings()?;
            println!(
                "{}",
                context
                    .default_version(&settings)
                    .context("No default CLI version is configured.")?
            );
        }
        (Some("version"), ["default", version]) => {
            let _check = track_explicit_cli_check(context, version, invocation.offline)?;
            let resolution = catalog::resolve(context, "cli", version, invocation.offline, true)?;
            let installed =
                engines::ensure_installed(context, &resolution.version, invocation.offline)?;
            catalog::activate(context, "cli", &resolution)?;
            drop(_check);
            let args = [
                "config",
                "set",
                "launcher.defaultCliVersion",
                version,
                "--global",
            ]
            .map(OsString::from);
            if context
                .receipt
                .as_ref()
                .is_some_and(|receipt| receipt.development.is_some())
            {
                return delegate_development(context, &args, None);
            }
            return engines::delegate(context, &installed, &args, None, &resolution.messages);
        }
        (Some("version"), ["current"]) => {
            let settings = context.settings_at(
                &std::env::current_dir()?,
                uapkg_slim_config::Scope::Effective,
            )?;
            let (version, explicit) = if let Some(receipt) = context
                .receipt
                .as_ref()
                .filter(|receipt| receipt.development.is_some())
            {
                ensure!(
                    invocation.override_version.is_none(),
                    "--cli-version is unavailable for a development checkout binding."
                );
                (
                    receipt
                        .default_cli_version
                        .clone()
                        .context("Development binding is missing its CLI version.")?,
                    false,
                )
            } else {
                let selection = routing::select(
                    invocation,
                    Scope::Project,
                    &std::env::current_dir()?,
                    context.default_version(&settings),
                )?;
                let explicit = !selection.uses_default_latest();
                (selection.version, explicit)
            };
            let resolution =
                catalog::resolve(context, "cli", &version, invocation.offline, explicit)?;
            catalog::emit(&resolution.messages);
            println!("{}", resolution.version);
            catalog::emit(&resolution.messages);
        }
        (Some("version"), ["--help"] | ["-h"] | []) => println!(
            "Usage: uapkg version install <version-selector> | list [available] | default [version-selector] | current"
        ),
        (Some("launcher-update"), ["--help"] | ["-h"]) => println!(
            "Usage: uapkg launcher-update [launcher-version]\nUpdates a standalone launcher."
        ),
        (Some("launcher-update"), [] | [_]) => {
            ensure!(
                !invocation.offline,
                "Launcher updates require an online connection."
            );
            updater::update(context, args.first().copied())?;
        }
        _ => bail!("Unknown launcher command. Run `uapkg launcher --help` for usage."),
    }
    Ok(0)
}

fn track_explicit_cli_check(
    context: &ContextPaths,
    _version: &str,
    offline: bool,
) -> Result<Option<std::fs::File>> {
    if !offline && context.ownership() != "development" {
        let guard = maintenance::claim(&maintenance::cli_directory(context), true)?;
        let index = catalog::index(context, "cli", false)?;
        if let Some(index) = index
            && let Err(error) = engines::purge_quarantined(context, &index)
        {
            eprintln!("uapkg: Could not finish quarantined CLI cleanup. {error:#}");
        }
        return Ok(guard);
    }
    Ok(None)
}

fn delegate_development(
    context: &ContextPaths,
    args: &[OsString],
    diagnostic: Option<&diagnostics::LauncherContext>,
) -> Result<i32> {
    let development = context
        .receipt
        .as_ref()
        .and_then(|receipt| receipt.development.as_ref())
        .context("Development checkout binding is missing.")?;
    ensure!(
        development.engine_path.is_file()
            && development.node_path.is_file()
            && development.checkout_path.is_dir(),
        "The development checkout binding is unavailable. Rebuild or relink the checkout."
    );
    let mut command = Command::new(&development.node_path);
    command
        .arg(&development.engine_path)
        .args(args)
        .env("UAPKG_LAUNCHER_VERSION", VERSION)
        .env("UAPKG_LAUNCHER_EXECUTABLE", &context.executable);
    catalog::apply_notices(&mut command, &[])?;
    engines::execute(command, diagnostic)
}
