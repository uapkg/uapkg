pub mod archive;
pub mod catalog;
pub mod diagnostics;
pub mod engines;
pub mod github;
pub mod model;
pub mod routing;
pub mod storage;
pub mod updater;

use anyhow::{Context, Result, bail, ensure};
use model::VERSION;
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
            "Launcher commands: launcher, version, self-update. See `uapkg launcher --help`.\nLauncher options: --cli-version <version-selector>, --offline. Place them anywhere after uapkg, before --.\n"
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
    let mut selection = routing::select(&invocation, &cwd, context.default_version(&settings))?;
    let mut resolution = catalog::resolve(
        &context,
        "cli",
        &selection.version,
        invocation.offline || debug_info,
        false,
    )?;
    if !debug_info {
        resolution
            .messages
            .extend(catalog::launcher_notices(&context, invocation.offline)?);
    }
    selection.version.clone_from(&resolution.version);
    let installed = engines::ensure_installed(
        &context,
        &resolution.version,
        invocation.offline || debug_info,
    )?;
    if !debug_info {
        catalog::activate(&context, "cli", &resolution)?;
    }
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
                "UAPKG launcher\n\n  launcher --version\n  version install <version-selector>\n  version list\n  version default [version-selector]\n  version current\n  self-update [launcher-version]\n\nSelectors: exact versions, latest, or a base-scoped preview such as 1.6.0-alpha.\n\nLauncher options may appear anywhere after uapkg, before --:\n  uapkg install --cli-version <version-selector>\n  uapkg --version --cli-version <version-selector>\n  uapkg install --offline\n\n--cli-version overrides CLI version selection.\n--offline prohibits launcher downloads.\nArguments after -- are passed to the CLI unchanged."
            );
        }
        (Some("version"), ["install", version]) => {
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
            for (version, platform) in engines::list(context)? {
                println!("{version}\tgithub-releases\t{platform}");
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
            let resolution = catalog::resolve(context, "cli", version, invocation.offline, true)?;
            let installed =
                engines::ensure_installed(context, &resolution.version, invocation.offline)?;
            catalog::activate(context, "cli", &resolution)?;
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
            let resolution = catalog::resolve(context, "cli", &version, invocation.offline, false)?;
            catalog::emit(&resolution.messages);
            println!("{}", resolution.version);
            catalog::emit(&resolution.messages);
        }
        (Some("version"), ["--help"] | ["-h"] | []) => println!(
            "Usage: uapkg version install <version-selector> | list | default [version-selector] | current"
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
    catalog::apply_notices(&mut command, &[])?;
    engines::execute(command, diagnostic)
}
