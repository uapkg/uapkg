use serde_json::json;
use std::{
    ffi::OsString,
    fs,
    path::Path,
    process::{Command, Output},
};
use uapkg_launcher::{
    archive, diagnostics, engines, github,
    model::{Source, exact_version, platform, relative_path},
    npm,
    routing::{Invocation, Scope, discover_project, select_version},
    storage::{ContextPaths, atomic_json, lock},
    updater::{self, Transaction},
};

fn invocation(args: &[&str]) -> Invocation {
    Invocation::parse(args.iter().map(OsString::from).collect()).unwrap()
}

#[test]
fn diagnostic_requests_obey_boolean_order_delimiter_and_cli_value_boundaries() {
    for args in [
        vec!["--debug-info"],
        vec!["install", "--debug-info=true"],
        vec!["--no-debug-info", "--debug-info"],
        vec!["--debug-info=false", "--debug-info=true"],
        vec!["--help=false", "--debug-info"],
    ] {
        assert!(
            diagnostics::requested(&args.iter().map(OsString::from).collect::<Vec<_>>()),
            "{args:?}"
        );
    }
    for args in [
        vec!["--debug-info=false"],
        vec!["--debug-info", "--no-debug-info"],
        vec!["--debug-info", "--debug-info=false"],
        vec!["--", "--debug-info"],
        vec!["--registry", "--debug-info"],
        vec!["--config", "--debug-info=true"],
        vec!["--debug-info", "--help"],
        vec!["-h", "--debug-info"],
        vec!["--debug-info", "--version=true"],
    ] {
        assert!(
            !diagnostics::requested(&args.iter().map(OsString::from).collect::<Vec<_>>()),
            "{args:?}"
        );
    }
}
fn write(path: &Path, value: serde_json::Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value.to_string()).unwrap();
}

#[test]
fn command_scopes_are_independent_of_launcher_option_placement() {
    for command in ["login", "logout", "whoami"] {
        assert_eq!(invocation(&[command]).scope(), Scope::Global);
    }
    for command in ["install", "config", "init", "future-command"] {
        assert_eq!(invocation(&[command]).scope(), Scope::Project);
    }
    for command in ["launcher", "version", "self-update"] {
        assert_eq!(invocation(&[command]).scope(), Scope::Launcher);
    }
    assert_eq!(
        invocation(&["--registry", "team", "whoami"]).scope(),
        Scope::Global
    );
    for args in [
        vec!["--cli-version", "1.2.3", "whoami", "--offline"],
        vec!["whoami", "--cli-version=1.2.3", "--offline"],
        vec!["--offline", "whoami", "--cli-version", "1.2.3"],
    ] {
        let parsed = invocation(&args);
        assert_eq!(parsed.scope(), Scope::Global);
        assert_eq!(parsed.override_version.as_deref(), Some("1.2.3"));
        assert!(parsed.offline);
        assert_eq!(parsed.args, [OsString::from("whoami")]);
    }
}

#[test]
fn launcher_options_are_extracted_around_commands_arguments_and_version_output() {
    for args in [
        vec!["--cli-version", "1.2.3", "future", "a b", "--offline"],
        vec!["future", "--cli-version=1.2.3", "a b", "--offline"],
        vec!["future", "--offline", "a b", "--cli-version", "1.2.3"],
        vec![
            "--offline",
            "future",
            "a b",
            "--cli-version=1.2.3",
            "--offline",
        ],
    ] {
        let parsed = invocation(&args);
        assert_eq!(parsed.scope(), Scope::Project);
        assert_eq!(parsed.override_version.as_deref(), Some("1.2.3"));
        assert!(parsed.offline);
        assert_eq!(parsed.args, ["future", "a b"].map(OsString::from));
    }
    for args in [
        vec!["--version", "--cli-version", "1.2.3", "--offline"],
        vec!["--cli-version=1.2.3", "--version", "--offline"],
        vec!["--offline", "--cli-version", "1.2.3", "--version"],
    ] {
        let parsed = invocation(&args);
        assert_eq!(parsed.command, None);
        assert_eq!(parsed.override_version.as_deref(), Some("1.2.3"));
        assert!(parsed.offline);
        assert_eq!(parsed.args, [OsString::from("--version")]);
    }
}

#[test]
fn delimiter_and_known_cli_option_values_preserve_literal_launcher_looking_arguments() {
    let literal = [
        "future",
        "--",
        "--cli-version",
        "not-a-version",
        "--offline",
        "--cli-version=",
        "",
    ];
    let parsed = invocation(&literal);
    assert_eq!(parsed.args, literal.map(OsString::from));
    assert_eq!(parsed.override_version, None);
    assert_eq!(
        parsed.offline,
        std::env::var_os("UAPKG_OFFLINE").is_some_and(|value| value == "1")
    );

    let parsed = invocation(&[
        "future",
        "--registry",
        "--cli-version=9.0.0",
        "--config",
        "--offline",
        "--cli-version",
        "1.2.3",
    ]);
    assert_eq!(parsed.override_version.as_deref(), Some("1.2.3"));
    assert_eq!(
        parsed.args,
        [
            "future",
            "--registry",
            "--cli-version=9.0.0",
            "--config",
            "--offline"
        ]
        .map(OsString::from)
    );
    assert_eq!(
        parsed.offline,
        std::env::var_os("UAPKG_OFFLINE").is_some_and(|value| value == "1")
    );
    let delimiter = [
        "future",
        "--registry",
        "--",
        "--offline",
        "--cli-version",
        "literal",
    ];
    assert_eq!(invocation(&delimiter).args, delimiter.map(OsString::from));

    let parsed = invocation(&[
        "future",
        "--unknown",
        "--cli-version=1.2.3",
        "literal--cli-version=3.0.0",
        "--cli-version-extra",
        "--offline=1",
    ]);
    assert_eq!(parsed.override_version.as_deref(), Some("1.2.3"));
    assert_eq!(
        parsed.args,
        [
            "future",
            "--unknown",
            "literal--cli-version=3.0.0",
            "--cli-version-extra",
            "--offline=1"
        ]
        .map(OsString::from)
    );
}

#[test]
fn invalid_or_duplicate_overrides_fail_even_after_the_command() {
    for args in [
        vec!["future", "--cli-version"],
        vec!["future", "--cli-version="],
        vec!["future", "--cli-version", ""],
        vec!["future", "--cli-version", "latest"],
        vec!["future", "--cli-version=^1.2.3"],
        vec!["future", "--cli-version", "--"],
        vec!["future", "--cli-version", "--offline"],
        vec!["--cli-version=1.2.3", "future", "--cli-version", "1.2.3"],
        vec![
            "future",
            "--cli-version=1.2.3",
            "other",
            "--cli-version=2.0.0",
        ],
    ] {
        assert!(
            Invocation::parse(args.iter().map(OsString::from).collect()).is_err(),
            "{args:?}"
        );
    }
}

#[test]
fn launcher_management_accepts_trailing_offline_and_current_override() {
    let current = invocation(&["version", "current", "--cli-version=1.2.3", "--offline"]);
    assert_eq!(current.scope(), Scope::Launcher);
    assert!(current.offline);
    assert_eq!(current.override_version.as_deref(), Some("1.2.3"));
    assert_eq!(current.command_args().unwrap(), ["current"]);
    let install = invocation(&["version", "install", "1.2.3", "--offline"]);
    assert!(install.offline);
    assert_eq!(install.command_args().unwrap(), ["install", "1.2.3"]);
    let update = invocation(&["self-update", "--offline"]);
    assert!(update.offline);
    assert!(update.command_args().unwrap().is_empty());
}

#[test]
fn nearest_game_project_owns_the_pin_and_plugin_versions_do_not() {
    let dir = tempfile::tempdir().unwrap();
    write(
        &dir.path().join("uapkg.json"),
        json!({"kind":"project","uapkgVersion":"1.2.3"}),
    );
    let plugin = dir.path().join("Plugins/Thing");
    write(
        &plugin.join("uapkg.json"),
        json!({"kind":"plugin","version":"99.0.0"}),
    );
    let cwd = plugin.join("Source");
    fs::create_dir(&cwd).unwrap();
    assert_eq!(
        discover_project(&cwd).unwrap().unwrap().version.as_deref(),
        Some("1.2.3")
    );
    assert_eq!(
        select_version(&invocation(&["future"]), &cwd, Some("2.0.0")).unwrap(),
        "1.2.3"
    );
    assert_eq!(
        select_version(&invocation(&["whoami"]), &cwd, Some("2.0.0")).unwrap(),
        "2.0.0"
    );
    assert_eq!(
        select_version(
            &invocation(&["--cli-version", "3.0.0", "whoami"]),
            &cwd,
            Some("2.0.0")
        )
        .unwrap(),
        "3.0.0"
    );
    write(&plugin.join("Nested/uapkg.json"), json!({"kind":"project"}));
    assert_eq!(
        select_version(
            &invocation(&["install"]),
            &plugin.join("Nested"),
            Some("2.0.0")
        )
        .unwrap(),
        "2.0.0"
    );
}

#[test]
fn malformed_pins_fail_without_breaking_global_or_override_recovery() {
    let dir = tempfile::tempdir().unwrap();
    write(
        &dir.path().join("uapkg.json"),
        json!({"kind":"project","uapkgVersion":"^1.2.3"}),
    );
    assert!(select_version(&invocation(&["install"]), dir.path(), Some("2.0.0")).is_err());
    assert_eq!(
        select_version(&invocation(&["login"]), dir.path(), Some("2.0.0")).unwrap(),
        "2.0.0"
    );
    assert_eq!(
        select_version(
            &invocation(&["--cli-version", "3.0.0", "install"]),
            dir.path(),
            None
        )
        .unwrap(),
        "3.0.0"
    );
    fs::remove_file(dir.path().join("uapkg.json")).unwrap();
    assert_eq!(
        select_version(&invocation(&["init"]), dir.path(), Some("2.0.0")).unwrap(),
        "2.0.0"
    );
    assert!(select_version(&invocation(&["install"]), dir.path(), None).is_err());
}

#[test]
fn versions_and_paths_cannot_escape_the_cache() {
    for version in ["latest", "v1.2.3", "^1.2.3", "1.2", "../other", "1.02.3"] {
        assert!(exact_version(version).is_err(), "{version}");
    }
    assert!(exact_version("1.2.3-beta.1+build.2").is_ok());
    for path in [
        "../escape",
        "/absolute",
        "C:/absolute",
        "a/../../escape",
        "a\\..\\b",
        "a:stream",
        "CON",
        "a/LPT1.txt",
        "a/thing.",
        "a/thing ",
    ] {
        assert!(relative_path(path).is_err(), "{path}");
    }
    assert!(relative_path("node_modules/@uapkg/cli/dist/cli.js").is_ok());
}

#[test]
fn signed_release_metadata_rejects_tampering_and_wrong_version() {
    let bytes = include_bytes!("fixtures/release.payload");
    let signature = include_str!("fixtures/release.json.minisig");
    let public_key = include_str!("fixtures/release.pub");
    assert_eq!(
        github::verify_descriptor(bytes, signature, public_key, "1.2.3")
            .unwrap()
            .cli_version,
        "1.2.3"
    );
    assert!(github::verify_descriptor(bytes, signature, public_key, "9.0.0").is_err());
    let mut tampered = bytes.to_vec();
    tampered[0] ^= 1;
    assert!(github::verify_descriptor(&tampered, signature, public_key, "1.2.3").is_err());
    assert!(github::verify_descriptor(bytes, "invalid", public_key, "1.2.3").is_err());
    assert!(
        github::asset_url("1.2.3", "release.json")
            .unwrap()
            .as_str()
            .contains("%2F")
    );
}

fn tar_file(path: &Path, entries: &[(&str, &[u8], tar::EntryType)]) {
    let encoder = flate2::write::GzEncoder::new(
        fs::File::create(path).unwrap(),
        flate2::Compression::default(),
    );
    let mut archive = tar::Builder::new(encoder);
    for (name, content, kind) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_entry_type(*kind);
        header.set_path(name).unwrap();
        if kind.is_symlink() {
            header.set_link_name("../outside").unwrap();
        }
        header.set_cksum();
        archive.append(&header, *content).unwrap();
    }
    archive.into_inner().unwrap().finish().unwrap();
}

#[test]
fn archive_validation_rejects_links_and_duplicate_paths() {
    let dir = tempfile::tempdir().unwrap();
    let tar = dir.path().join("archive.tgz");
    tar_file(&tar, &[("link", b"", tar::EntryType::Symlink)]);
    assert!(archive::extract(&tar, &dir.path().join("link-stage")).is_err());
    tar_file(
        &tar,
        &[
            ("File", b"one", tar::EntryType::Regular),
            ("file", b"two", tar::EntryType::Regular),
        ],
    );
    assert!(archive::extract(&tar, &dir.path().join("duplicate-stage")).is_err());
    tar_file(&tar, &[("nested/ok", b"hello", tar::EntryType::Regular)]);
    archive::extract(&tar, &dir.path().join("safe-stage")).unwrap();
    assert_eq!(
        fs::read(dir.path().join("safe-stage/nested/ok")).unwrap(),
        b"hello"
    );
    assert!(
        archive::verify_file(&tar, fs::metadata(&tar).unwrap().len(), &"0".repeat(64)).is_err()
    );
}

#[test]
fn npm_integrity_and_engine_ranges_are_enforced() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("package.tgz");
    fs::write(&file, b"hello").unwrap();
    assert!(npm::verify_integrity(&file, "sha512-missing").is_err());
    assert!(npm::verify_integrity(&file, "sha1-unsupported").is_err());
    assert!(npm::satisfies("v26.13.1", ">=26 <27 || >=28").unwrap());
    assert!(!npm::satisfies("v24.0.0", ">=26").unwrap());
}

fn context(root: &Path) -> ContextPaths {
    ContextPaths {
        home: root.join("profile"),
        executable: root.join(if cfg!(windows) { "uapkg.exe" } else { "uapkg" }),
        receipt: None,
    }
}

#[test]
fn offline_cache_is_source_specific_and_partial_installations_never_run() {
    let dir = tempfile::tempdir().unwrap();
    let context = context(dir.path());
    let target = platform().unwrap();
    let github = context.cache_dir(Source::Github, "1.2.3", target).unwrap();
    fs::create_dir_all(&github).unwrap();
    fs::write(github.join("engine"), b"fixture").unwrap();
    write(
        &github.join("engine.json"),
        json!({"schemaVersion":1,"version":"1.2.3","platform":target,"kind":"sea","executable":"engine","args":[]}),
    );
    assert!(engines::ensure_installed(&context, Source::Github, "1.2.3", true).is_err());
    write(
        &github.join(".installed.json"),
        json!({"schemaVersion":1,"source":"github-releases","version":"1.2.3","platform":target}),
    );
    assert!(engines::ensure_installed(&context, Source::Github, "1.2.3", true).is_ok());
    assert!(engines::ensure_installed(&context, Source::Npm, "1.2.3", true).is_err());
    assert!(engines::ensure_installed(&context, Source::Github, "2.0.0", true).is_err());
}

#[test]
fn global_launcher_settings_are_read_without_changing_unrelated_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let context = context(dir.path());
    assert_eq!(context.settings().unwrap().cli_source, Source::Github);
    let path = context.home.join("config.json");
    write(
        &path,
        json!({"launcher":{"cliSource":"npm","defaultCliVersion":"1.2.3","futureSetting":true},"registry":"team","term":{"quiet":true},"futureCliObject":{"arbitrary":[1,2,3]}}),
    );
    let original = fs::read(&path).unwrap();
    let settings = context.settings().unwrap();
    assert_eq!(settings.cli_source, Source::Npm);
    assert_eq!(settings.default_cli_version.as_deref(), Some("1.2.3"));
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(!context.home.join("launcher.json").exists());
    let path = dir.path().join("lock");
    let first = lock(&path).unwrap();
    drop(first);
    assert!(lock(&path).is_ok());
}

#[test]
fn malformed_relevant_global_settings_fail_with_their_location() {
    let dir = tempfile::tempdir().unwrap();
    let context = context(dir.path());
    let path = context.home.join("config.json");
    for config in [
        json!([]),
        json!({"launcher":null}),
        json!({"launcher":{"cliSource":null}}),
        json!({"launcher":{"cliSource":"unrecognized"}}),
        json!({"launcher":{"defaultCliVersion":42}}),
        json!({"launcher":{"defaultCliVersion":"latest"}}),
        json!({"launcher":{"defaultCliVersion":null}}),
    ] {
        write(&path, config);
        let error = context.settings().unwrap_err();
        assert!(format!("{error:#}").contains("config.json"), "{error:#}");
    }
    write(&path, json!({"launcher":{},"unrelated":"ignored"}));
    assert_eq!(context.settings().unwrap().cli_source, Source::Github);
}

#[test]
fn updater_ownership_and_recovery_preserve_the_previous_binary() {
    assert!(updater::ownership_instructions("standalone").is_ok());
    for owner in [
        "npm",
        "winget",
        "homebrew",
        "scoop",
        "development",
        "unknown",
    ] {
        assert!(updater::ownership_instructions(owner).is_err());
    }
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("uapkg");
    let backup = dir.path().join("uapkg.backup");
    fs::write(&target, b"broken replacement").unwrap();
    fs::write(&backup, b"previous good binary").unwrap();
    let transaction = Transaction {
        schema_version: 1,
        executable: "uapkg".into(),
        backup: "uapkg.backup".into(),
        previous_sha256: archive::sha256(&backup).unwrap(),
        next_sha256: "0".repeat(64),
        next_version: "0.2.0".into(),
    };
    atomic_json(&dir.path().join("uapkg-update.json"), &transaction).unwrap();
    assert!(updater::recover(&target).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"previous good binary");
    assert!(!dir.path().join("uapkg-update.json").exists());
    fs::write(&backup, b"bad backup").unwrap();
    assert!(updater::rollback(dir.path(), &transaction).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"previous good binary");
}

fn run_cli(binary: &Path, home: &Path, cwd: &Path, args: &[&str]) -> Output {
    Command::new(binary)
        .args(args)
        .env("HOME", home.parent().unwrap())
        .env("USERPROFILE", home.parent().unwrap())
        .current_dir(cwd)
        .output()
        .unwrap()
}

#[test]
fn launcher_management_never_delegates_or_requires_an_engine() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".uapkg");
    let binary = Path::new(env!("CARGO_BIN_EXE_uapkg"));
    let version = run_cli(binary, &home, dir.path(), &["launcher", "--version"]);
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout).unwrap().trim(),
        env!("CARGO_PKG_VERSION")
    );
    let get = run_cli(
        binary,
        &home,
        dir.path(),
        &["launcher", "config", "get", "cliSource"],
    );
    assert!(!get.status.success());
    assert!(String::from_utf8_lossy(&get.stderr).contains("Unknown launcher command"));
    assert!(
        !run_cli(
            binary,
            &home,
            dir.path(),
            &["launcher", "config", "set", "cliSource", "npm"]
        )
        .status
        .success()
    );
    let cli_config = run_cli(
        binary,
        &home,
        dir.path(),
        &["config", "get", "launcher.cliSource", "--global"],
    );
    assert!(!cli_config.status.success());
    assert!(String::from_utf8_lossy(&cli_config.stderr).contains("No default CLI version"));
    assert!(!home.join("config.json").exists());
    let missing = run_cli(
        binary,
        &home,
        dir.path(),
        &["version", "install", "999.0.0", "--offline"],
    );
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("not cached"));
    let update = run_cli(binary, &home, dir.path(), &["self-update", "--offline"]);
    assert!(!update.status.success());
    assert!(String::from_utf8_lossy(&update.stderr).contains("requires an online connection"));
    assert!(
        run_cli(binary, &home, dir.path(), &["version", "list"])
            .status
            .success()
    );
}

#[test]
fn startup_recovery_does_not_modify_package_manager_owned_installations() {
    let dir = tempfile::tempdir().unwrap();
    let name = if cfg!(windows) { "uapkg.exe" } else { "uapkg" };
    let binary = dir.path().join(name);
    fs::copy(env!("CARGO_BIN_EXE_uapkg"), &binary).unwrap();
    let backup = dir.path().join("saved-launcher");
    fs::copy(&binary, &backup).unwrap();
    let before = archive::sha256(&binary).unwrap();
    let transaction = Transaction {
        schema_version: 1,
        executable: name.to_owned(),
        backup: "saved-launcher".to_owned(),
        previous_sha256: before.clone(),
        next_sha256: "0".repeat(64),
        next_version: "0.2.0".to_owned(),
    };
    atomic_json(&dir.path().join("uapkg-update.json"), &transaction).unwrap();
    write(
        &dir.path().join("uapkg-install.json"),
        json!({"schemaVersion":1,"installMethod":"npm","defaultCliVersion":"1.2.3"}),
    );
    let output = run_cli(
        &binary,
        &dir.path().join(".uapkg"),
        dir.path(),
        &["launcher", "--help"],
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("npm owns this launcher"));
    assert_eq!(archive::sha256(&binary).unwrap(), before);
    assert!(backup.exists());
    assert!(dir.path().join("uapkg-update.json").exists());
    assert!(!dir.path().join("uapkg-update.lock").exists());
}
