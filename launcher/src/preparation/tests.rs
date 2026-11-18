use super::{allows_optional_maintenance, prepare_with};
use crate::{
    catalog::{self, Resolution},
    engines, maintenance,
    model::{Engine, Receipt, Settings, platform},
    routing::Invocation,
    storage::{ContextPaths, atomic_json},
};
use anyhow::{Result, bail};
use serde_json::json;
use std::{
    cell::Cell,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

fn context(root: &Path) -> ContextPaths {
    ContextPaths {
        home: root.join("profile"),
        executable: root.join("uapkg"),
        receipt: None,
    }
}

fn invocation(args: &[&str], offline: bool) -> Result<Invocation> {
    let mut invocation = Invocation::parse(args.iter().map(OsString::from).collect())?;
    // These unit tests provide the parsed policy explicitly without mutating
    // process-wide environment variables used by other tests.
    invocation.offline = offline;
    Ok(invocation)
}

fn settings(context: &ContextPaths, default: Option<&str>) -> Result<Settings> {
    let mut value = json!({"launcher":{},"unrelated":"preserved"});
    if let Some(default) = default {
        value["launcher"]["defaultCliVersion"] = json!(default);
    }
    atomic_json(&context.home.join("config.json"), &value)?;
    context.settings()
}

fn project(root: &Path, pin: Option<&str>) -> Result<PathBuf> {
    let cwd = root.join("project");
    let mut value = json!({"kind":"project","unrelated":"preserved"});
    if let Some(pin) = pin {
        value["uapkgVersion"] = json!(pin);
    }
    atomic_json(&cwd.join("uapkg.json"), &value)?;
    Ok(cwd)
}

fn stage_engine(stage: &Path, version: &str) -> Result<PathBuf> {
    let root = stage.join("engine");
    fs::create_dir_all(&root)?;
    let executable = if cfg!(windows) {
        "engine.exe"
    } else {
        "engine"
    };
    fs::copy(std::env::current_exe()?, root.join(executable))?;
    atomic_json(
        &root.join("engine.json"),
        &Engine {
            schema_version: 1,
            version: version.into(),
            platform: platform()?.into(),
            kind: "sea".into(),
            executable: executable.into(),
            args: vec![],
        },
    )?;
    Ok(root)
}

fn published(context: &ContextPaths) -> Result<()> {
    for (name, bytes, signature) in [
        (
            "index.json",
            include_str!("../../../tools/release/fixtures/index.json"),
            include_str!("../../../tools/release/fixtures/index.json.minisig"),
        ),
        (
            "replacements.json",
            include_str!("../../../tools/release/fixtures/replacements.json"),
            include_str!("../../../tools/release/fixtures/replacements.json.minisig"),
        ),
    ] {
        atomic_json(
            &context
                .home
                .join("catalog/cli")
                .join(format!("{name}.verified.json")),
            &json!({"bytes":bytes,"signature":signature}),
        )?;
    }
    Ok(())
}

#[test]
fn diagnostics_and_commands_install_the_selected_missing_engine_online() -> Result<()> {
    for (args, pin, expected, reason) in [
        (
            vec!["whoami", "--debug-info"],
            Some("2.0.0"),
            "1.2.3",
            "global-command",
        ),
        (
            vec!["install", "--debug-info"],
            Some("2.0.0"),
            "2.0.0",
            "project-pin",
        ),
        (
            vec!["install", "--debug-info"],
            None,
            "1.2.3",
            "global-default",
        ),
        (
            vec!["--cli-version", "3.0.0", "--debug-info"],
            Some("2.0.0"),
            "3.0.0",
            "override",
        ),
        (
            vec!["--debug-info", "--cli-version", "3.0.0"],
            Some("2.0.0"),
            "3.0.0",
            "override",
        ),
        (
            vec!["whoami", "--cli-version=3.0.0", "--debug-info"],
            Some("2.0.0"),
            "3.0.0",
            "override",
        ),
        (
            vec!["install", "--cli-version=3.0.0"],
            Some("2.0.0"),
            "3.0.0",
            "override",
        ),
        (
            vec!["whoami", "--cli-version=3.0.0"],
            Some("2.0.0"),
            "3.0.0",
            "override",
        ),
        (vec!["install"], Some("2.0.0"), "2.0.0", "project-pin"),
        (
            vec!["launcher-update", "--debug-info"],
            Some("2.0.0"),
            "1.2.3",
            "global-command",
        ),
    ] {
        let directory = tempfile::tempdir()?;
        let context = context(directory.path());
        let mut settings = settings(&context, Some("1.2.3"))?;
        settings.auto_cli_update = false;
        settings.auto_launcher_update = false;
        let cwd = project(directory.path(), pin)?;
        let invocation = invocation(&args, false)?;
        let downloads = Cell::new(0);
        let prepared = prepare_with(
            &context,
            &invocation,
            &settings,
            &cwd,
            |requested, offline| {
                assert_eq!(requested, expected);
                assert!(!offline, "{args:?}");
                catalog::resolve(&context, "cli", requested, true, false)
            },
            |_| panic!("Exact selections must not run latest maintenance"),
            |version, offline, explanation| {
                assert!(!offline, "{args:?}");
                assert!(explanation.contains(expected));
                engines::install_cached(&context, version, offline, |stage| {
                    downloads.set(downloads.get() + 1);
                    stage_engine(stage, version)
                })
            },
        )?;
        assert_eq!(downloads.get(), 1, "{args:?}");
        assert_eq!(prepared.selection.reason, reason, "{args:?}");
        assert_eq!(prepared.selection.version, expected);
        assert_eq!(prepared.installed.engine.version, expected);
        assert!(prepared.installed.root.join(".installed.json").is_file());
        assert_eq!(engines::list(&context)?, [expected]);
    }
    Ok(())
}

#[test]
fn cached_engines_are_reused_online_and_offline_without_a_downloader() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut context = context(directory.path());
    context.receipt = Some(Receipt {
        schema_version: 1,
        install_method: "standalone".into(),
        default_cli_version: Some("1.2.3".into()),
        development: None,
    });
    let settings = settings(&context, Some("1.2.3"))?;
    let installed = engines::install_cached(&context, "1.2.3", false, |stage| {
        stage_engine(stage, "1.2.3")
    })?;
    for offline in [false, true] {
        let invocation = invocation(&["--debug-info"], offline)?;
        let prepared = prepare_with(
            &context,
            &invocation,
            &settings,
            directory.path(),
            |requested, passed_offline| {
                assert_eq!(passed_offline, offline);
                catalog::resolve(&context, "cli", requested, true, false)
            },
            |_| panic!("Diagnostics must skip optional maintenance"),
            |version, passed_offline, _| {
                assert_eq!(passed_offline, offline);
                engines::install_cached(&context, version, passed_offline, |_| {
                    panic!("A valid cached engine must not invoke a downloader")
                })
            },
        )?;
        assert_eq!(prepared.installed.root, installed.root);
        assert_eq!(prepared.selection.reason, "global-default");
    }
    Ok(())
}

#[test]
fn diagnostics_reinstall_remembered_latest_without_advancing_or_check_bookkeeping() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let context = context(directory.path());
    let settings = settings(&context, Some("latest"))?;
    published(&context)?;
    catalog::activate(
        &context,
        "cli",
        &Resolution {
            requested: "latest".into(),
            version: "1.9.0".into(),
            messages: vec![],
        },
    )?;
    let installed = engines::install_cached(&context, "1.9.0", false, |stage| {
        stage_engine(stage, "1.9.0")
    })?;
    assert!(installed.root.starts_with(&context.home));
    fs::remove_dir_all(&installed.root)?;
    let tracking = context.home.join("catalog/cli/resolutions.json");
    let before = fs::read(&tracking)?;
    let invocation = invocation(&["--debug-info"], false)?;
    assert!(!allows_optional_maintenance(&invocation));
    let prepared = prepare_with(
        &context,
        &invocation,
        &settings,
        directory.path(),
        |_, _| panic!("Remembered global latest must retain its exact version"),
        |_| panic!("Diagnostics must not advance latest"),
        |version, offline, _| {
            assert_eq!(version, "1.9.0");
            assert!(!offline);
            engines::install_cached(&context, version, offline, |stage| {
                stage_engine(stage, version)
            })
        },
    )?;
    assert_eq!(prepared.installed.engine.version, "1.9.0");
    assert_eq!(fs::read(tracking)?, before);
    assert!(!maintenance::cli_directory(&context).exists());
    Ok(())
}

#[test]
fn diagnostics_activate_aliases_only_after_a_successful_installation() -> Result<()> {
    for (args, default, pin, requested, expected) in [
        (vec!["--debug-info"], "latest", None, "latest", "2.0.0"),
        (
            vec!["install", "--debug-info"],
            "1.2.3",
            Some("2.1.0-beta"),
            "2.1.0-beta",
            "2.1.0-beta.10",
        ),
        (
            vec!["--cli-version=latest", "--debug-info"],
            "1.2.3",
            None,
            "latest",
            "2.0.0",
        ),
    ] {
        let directory = tempfile::tempdir()?;
        let context = context(directory.path());
        let settings = settings(&context, Some(default))?;
        let cwd = project(directory.path(), pin)?;
        published(&context)?;
        let invocation = invocation(&args, false)?;
        let prepared = prepare_with(
            &context,
            &invocation,
            &settings,
            &cwd,
            |selector, offline| {
                assert_eq!(selector, requested);
                assert!(!offline);
                catalog::resolve(&context, "cli", selector, true, false)
            },
            |_| panic!("Diagnostics must skip optional latest updates"),
            |version, offline, _| {
                assert_eq!(version, expected);
                assert!(!offline);
                assert_eq!(catalog::active_version(&context, "cli", requested)?, None);
                engines::install_cached(&context, version, offline, |stage| {
                    assert_eq!(catalog::active_version(&context, "cli", requested)?, None);
                    stage_engine(stage, version)
                })
            },
        )?;
        assert_eq!(prepared.resolution.requested, requested);
        assert_eq!(prepared.selection.version, expected);
        assert_eq!(prepared.installed.engine.version, expected);
        assert_eq!(
            catalog::active_version(&context, "cli", requested)?.as_deref(),
            Some(expected)
        );
        assert!(!maintenance::cli_directory(&context).exists());
    }
    Ok(())
}

#[test]
fn failed_acquisition_preserves_selections_and_never_substitutes_a_cached_engine() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let context = context(directory.path());
    let settings = settings(&context, Some("1.2.3"))?;
    let cwd = project(directory.path(), Some("2.1.0-beta"))?;
    published(&context)?;
    catalog::activate(
        &context,
        "cli",
        &Resolution {
            requested: "2.1.0-beta".into(),
            version: "2.1.0-beta.1".into(),
            messages: vec![],
        },
    )?;
    engines::install_cached(&context, "1.2.3", false, |stage| {
        stage_engine(stage, "1.2.3")
    })?;
    let paths = [
        context.home.join("config.json"),
        cwd.join("uapkg.json"),
        context.home.join("catalog/cli/resolutions.json"),
    ];
    let before = paths
        .iter()
        .map(fs::read)
        .collect::<std::io::Result<Vec<_>>>()?;
    let invocation = invocation(&["install", "--debug-info"], false)?;
    let downloads = Cell::new(0);
    let error = prepare_with(
        &context,
        &invocation,
        &settings,
        &cwd,
        |requested, offline| {
            assert!(!offline);
            catalog::resolve(&context, "cli", requested, true, false)
        },
        |_| panic!("A project pin must not run global latest maintenance"),
        |version, offline, _| {
            assert_eq!(version, "2.1.0-beta.10");
            engines::install_cached(&context, version, offline, |stage| {
                downloads.set(downloads.get() + 1);
                fs::write(stage.join("partial-download"), b"incomplete")?;
                bail!("The selected engine download failed")
            })
        },
    )
    .err()
    .expect("The selected version must fail without falling back");
    assert!(error.to_string().contains("download failed"));
    assert_eq!(downloads.get(), 1);
    assert_eq!(
        paths
            .iter()
            .map(fs::read)
            .collect::<std::io::Result<Vec<_>>>()?,
        before
    );
    assert_eq!(engines::list(&context)?, ["1.2.3"]);
    assert_eq!(fs::read_dir(context.home.join("staging"))?.count(), 0);
    Ok(())
}

#[test]
fn preview_replacements_install_the_published_target_instead_of_a_cached_preview() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let context = context(directory.path());
    let settings = settings(&context, Some("1.2.3"))?;
    let cwd = project(directory.path(), Some("2.0.0-alpha.1"))?;
    published(&context)?;
    engines::install_cached(&context, "2.0.0-alpha.1", false, |stage| {
        stage_engine(stage, "2.0.0-alpha.1")
    })?;
    let invocation = invocation(&["install", "--debug-info"], false)?;
    let prepared = prepare_with(
        &context,
        &invocation,
        &settings,
        &cwd,
        |requested, offline| {
            assert!(!offline);
            catalog::resolve(&context, "cli", requested, true, false)
        },
        |_| panic!("Exact preview selections must not run latest maintenance"),
        |version, offline, reason| {
            assert_eq!(version, "2.0.0");
            assert!(reason.contains("2.0.0-alpha.1"));
            engines::install_cached(&context, version, offline, |stage| {
                stage_engine(stage, version)
            })
        },
    )?;
    assert_eq!(prepared.installed.engine.version, "2.0.0");
    assert!(prepared.resolution.messages[0].contains("2.0.0-alpha.1 -> 2.0.0"));
    Ok(())
}

#[test]
fn offline_diagnostics_resolve_cached_policy_but_never_download_missing_engines() -> Result<()> {
    for (args, pin, default) in [
        (vec!["--debug-info", "--offline"], None, "1.2.3"),
        (
            vec!["install", "--debug-info", "--offline"],
            Some("2.0.0"),
            "1.2.3",
        ),
        (
            vec!["--cli-version=3.0.0", "--debug-info", "--offline"],
            None,
            "1.2.3",
        ),
        (vec!["--debug-info", "--offline"], None, "latest"),
        (
            vec!["install", "--debug-info", "--offline"],
            Some("2.0.0-alpha.1"),
            "1.2.3",
        ),
    ] {
        let directory = tempfile::tempdir()?;
        let context = context(directory.path());
        let settings = settings(&context, Some(default))?;
        let cwd = project(directory.path(), pin)?;
        published(&context)?;
        let invocation = invocation(&args, true)?;
        assert!(!allows_optional_maintenance(&invocation));
        let error = prepare_with(
            &context,
            &invocation,
            &settings,
            &cwd,
            |requested, offline| {
                assert!(offline);
                catalog::resolve(&context, "cli", requested, offline, false)
            },
            |_| panic!("Offline diagnostics must skip optional maintenance"),
            |version, offline, _| {
                assert!(offline);
                engines::install_cached(&context, version, offline, |_| {
                    panic!("Offline mode must not invoke a downloader")
                })
            },
        )
        .err()
        .expect("A missing offline engine must fail");
        assert!(
            error
                .to_string()
                .contains("Offline mode prevents downloading")
        );
        assert!(engines::list(&context)?.is_empty());
        assert!(!context.home.join("staging").exists());
        assert!(!context.home.join("catalog/cli/resolutions.json").exists());
        assert!(!maintenance::cli_directory(&context).exists());
    }
    Ok(())
}
