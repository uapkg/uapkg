pub mod archive;
pub mod diagnostics;
pub mod engines;
pub mod github;
pub mod model;
pub mod npm;
pub mod routing;
pub mod storage;
pub mod updater;

use anyhow::{Context, Result, bail, ensure};
use model::{Source, VERSION, exact_version};
use routing::{Invocation, Scope};
use std::{ffi::OsString, io::Write, process::Command};
use storage::ContextPaths;

pub fn run(args: Vec<OsString>) -> Result<i32> {
    let invocation = Invocation::parse(args)?;
    let debug_info = diagnostics::requested(&invocation.args);
    // This pure version check also validates staged update executables without
    // loading a profile or entering update recovery recursively.
    if invocation.command.as_deref() == Some("launcher")
        && !debug_info
        && invocation.command_args()? == ["--version"]
    {
        println!("{VERSION}");
        return Ok(0);
    }
    let context = ContextPaths::load()?;
    if !debug_info {
        updater::recover_installation(&context)?;
    }
    if invocation.scope() == Scope::Launcher && !debug_info {
        return launcher_command(&context, &invocation);
    }
    if invocation.command.is_none()
        && (invocation.args.is_empty()
            || invocation
                .args
                .iter()
                .any(|arg| arg == "--help" || arg == "-h"))
    {
        println!(
            "Launcher commands: launcher, version, self-update. See `uapkg launcher --help`.\nLauncher options: --cli-version <exact-version>, --offline. Place them anywhere after uapkg, before --.\n"
        );
        std::io::stdout().flush()?;
    }
    if context
        .receipt
        .as_ref()
        .and_then(|receipt| receipt.development.as_ref())
        .is_some()
    {
        ensure!(
            invocation.override_version.is_none(),
            "--cli-version is unavailable for a development checkout binding. Use an official launcher for released CLI versions."
        );
        let diagnostic = diagnostics::for_development(&context, &invocation);
        return delegate_development(&context, &invocation.args, diagnostic.as_ref());
    }
    let settings = context.settings()?;
    let cwd = std::env::current_dir()?;
    let selection = routing::select(&invocation, &cwd, context.default_version(&settings))?;
    let installed = engines::ensure_installed(
        &context,
        settings.cli_source,
        &selection.version,
        invocation.offline || debug_info,
    )?;
    let diagnostic = diagnostics::for_release(
        &context,
        &invocation,
        &settings,
        &selection,
        &installed.engine.kind,
        &cwd,
    );
    engines::delegate(&context, &installed, &invocation.args, diagnostic.as_ref())
}

fn launcher_command(context: &ContextPaths, invocation: &Invocation) -> Result<i32> {
    let args = invocation.command_args()?;
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    match (invocation.command.as_deref(), args.as_slice()) {
        (Some("launcher"), ["--help"] | ["-h"] | []) => {
            println!(
                "UAPKG launcher\n\n  launcher --version\n  version install <exact-version|latest>\n  version list\n  version default [exact-version|latest]\n  version current\n  self-update [launcher-version]\n\nSettings use the CLI's config command, for example:\n  uapkg config set launcher.cliSource npm --global\n\nLauncher options may appear anywhere after uapkg, before --:\n  uapkg install --cli-version <exact-version>\n  uapkg --version --cli-version <exact-version>\n  uapkg install --offline\n\n--cli-version overrides CLI version selection.\n--offline prohibits launcher downloads.\nArguments after -- are passed to the CLI unchanged."
            );
        }
        (Some("version"), ["install", version]) => {
            let source = context.settings()?.cli_source;
            let version = resolve_requested_version(source, version, invocation.offline)?;
            let installed =
                engines::ensure_installed(context, source, &version, invocation.offline)?;
            println!(
                "CLI {} is installed at {}.",
                installed.engine.version,
                installed.root.display()
            );
        }
        (Some("version"), ["list"]) => {
            for (source, version, platform) in engines::list(context)? {
                println!("{version}\t{source}\t{platform}");
            }
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
            let source = context.settings()?.cli_source;
            let version = resolve_requested_version(source, version, invocation.offline)?;
            let installed =
                engines::ensure_installed(context, source, &version, invocation.offline)?;
            ensure!(
                context.settings()?.cli_source == source,
                "CLI source changed while installing. Run the command again."
            );
            let args = [
                "config",
                "set",
                "launcher.defaultCliVersion",
                &version,
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
            return engines::delegate(context, &installed, &args, None);
        }
        (Some("version"), ["current"]) => {
            let settings = context.settings()?;
            let version = if let Some(receipt) = context
                .receipt
                .as_ref()
                .filter(|receipt| receipt.development.is_some())
            {
                ensure!(
                    invocation.override_version.is_none(),
                    "--cli-version is unavailable for a development checkout binding."
                );
                receipt
                    .default_cli_version
                    .clone()
                    .context("Development binding is missing its CLI version.")?
            } else {
                let mut selection = Invocation::parse(Vec::new())?;
                selection
                    .override_version
                    .clone_from(&invocation.override_version);
                routing::select_version(
                    &selection,
                    &std::env::current_dir()?,
                    context.default_version(&settings),
                )?
            };
            println!("{version}");
        }
        (Some("version"), ["--help"] | ["-h"] | []) => println!(
            "Usage: uapkg version install <exact-version|latest> | list | default [exact-version|latest] | current"
        ),
        (Some("self-update"), []) => {
            ensure!(
                !invocation.offline,
                "Self-update requires an online connection."
            );
            updater::update(context, None)?;
        }
        (Some("self-update"), ["--help"] | ["-h"]) => println!(
            "Usage: uapkg self-update [launcher-version]\nUpdates only a standalone launcher. CLI defaults and project pins are unchanged."
        ),
        (Some("self-update"), [version]) => {
            ensure!(
                !invocation.offline,
                "Self-update requires an online connection."
            );
            updater::update(context, Some(version))?;
        }
        _ => bail!("Unknown launcher command. Run `uapkg launcher --help` for usage."),
    }
    Ok(0)
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
    engines::execute(command, diagnostic)
}

fn resolve_requested_version(source: Source, requested: &str, offline: bool) -> Result<String> {
    if requested != "latest" {
        exact_version(requested)?;
        return Ok(requested.to_owned());
    }
    ensure!(
        !offline,
        "Resolving latest requires an online connection. Select an exact cached version while offline."
    );
    let client = github::client()?;
    match source {
        Source::Github => github::latest_version(&client),
        Source::Npm => npm::latest_version(&client),
    }
}
