use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use uapkg_launcher::model::platform;

fn node_path() -> PathBuf {
    if let Some(path) = std::env::var_os("UAPKG_TEST_NODE") {
        return path.into();
    }
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Run these tests through vp run launcher:test or set UAPKG_TEST_NODE");
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn write(path: &Path, value: Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value.to_string()).unwrap();
}

fn link_node(directory: &Path) -> PathBuf {
    fs::create_dir_all(directory).unwrap();
    let destination = directory.join(if cfg!(windows) { "node.exe" } else { "node" });
    let node = node_path();
    if fs::hard_link(&node, &destination).is_err() {
        fs::copy(&node, &destination).unwrap();
    }
    destination
}

fn fixture_engine(home: &Path, _source: &str, version: &str) {
    let root = home.join("engines").join(version).join(platform().unwrap());
    fs::create_dir_all(&root).unwrap();
    let executable = link_node(&root)
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    fs::write(root.join("fixture.cjs"), r#"
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.UAPKG_TEST_CONFIG_WRITER === '1' && args[0] === 'config' && args[1] === 'set' && args[2] === 'launcher.defaultCliVersion' && args[4] === '--global') {
  const profile = path.join(process.env.USERPROFILE || process.env.HOME, '.uapkg');
  const file = path.join(profile, 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.launcher = {...config.launcher, defaultCliVersion: args[3]};
  fs.writeFileSync(file, JSON.stringify(config));
}
process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),version:process.env.UAPKG_CLI_VERSION,sentinel:process.env.UAPKG_TEST_SENTINEL,input:fs.readFileSync(0,'utf8'),debugContext:process.env.UAPKG_LAUNCHER_CONTEXT ? JSON.parse(process.env.UAPKG_LAUNCHER_CONTEXT) : null}));
process.stderr.write('fixture-stderr');
process.exit(Number(process.env.UAPKG_TEST_EXIT || '0'));
"#).unwrap();
    write(
        &root.join("engine.json"),
        json!({"schemaVersion":1,"version":version,"platform":platform().unwrap(),"kind":"node","executable":executable,"args":["fixture.cjs"]}),
    );
    write(
        &root.join(".installed.json"),
        json!({"schemaVersion":1,"version":version,"platform":platform().unwrap()}),
    );
}

fn run(home: &Path, cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_uapkg"))
        .args(args)
        .current_dir(cwd)
        .env("HOME", home.parent().unwrap())
        .env("USERPROFILE", home.parent().unwrap())
        .env("UAPKG_TEST_SENTINEL", "unchanged")
        .env(
            "UAPKG_LAUNCHER_CONTEXT",
            "stale-parent-context-must-not-survive",
        )
        .env_remove("UAPKG_OFFLINE")
        .env("PATH", "")
        .output()
        .unwrap()
}

fn selected(output: Output, expected: &str) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stderr), "fixture-stderr");
    let body: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(body["version"], expected);
    body
}

fn fixture_cache(home: &Path, version: &str, target: &str) {
    let root = home.join("engines").join(version).join(target);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("engine"), b"listing fixture").unwrap();
    write(
        &root.join("engine.json"),
        json!({"schemaVersion":1,"version":version,"platform":target,"kind":"sea","executable":"engine","args":[]}),
    );
    write(
        &root.join(".installed.json"),
        json!({"schemaVersion":1,"version":version,"platform":target}),
    );
}

fn listed(output: Output) -> String {
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn local_list_orders_all_selections_before_valid_current_platform_installations() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".uapkg");
    let target = platform().unwrap();
    for version in ["1.7.0", "1.6.0", "1.10.0", "1.7.1", "1.6.1"] {
        fixture_cache(&home, version, target);
    }
    fixture_cache(&home, "9.0.0", target);
    fs::remove_file(home.join("engines/9.0.0").join(target).join("engine")).unwrap();
    let foreign = if target == "darwin-x64" {
        "win-x64"
    } else {
        "darwin-x64"
    };
    fixture_cache(&home, "10.0.0", foreign);
    write(
        &home.join("config.json"),
        json!({"launcher":{"defaultCliVersion":"1.7.0"},"registry":"preserve"}),
    );
    write(
        &dir.path().join("uapkg.json"),
        json!({"kind":"project","uapkgVersion":"1.7.2"}),
    );
    let configuration = fs::read(home.join("config.json")).unwrap();
    let manifest = fs::read(dir.path().join("uapkg.json")).unwrap();
    let output = listed(run(
        &home,
        dir.path(),
        &["version", "list", "--cli-version=1.6.0"],
    ));
    assert_eq!(
        output,
        concat!(
            "1.7.0 (global default, installed)\n",
            "1.7.2 (project pin, not installed)\n",
            "1.6.0 (cli override, installed)\n",
            "\n1.10.0\n1.7.1\n1.6.1\n",
            "\nTo see the list of available versions, run `uapkg version list available`.\n"
        )
    );
    assert_eq!(fs::read(home.join("config.json")).unwrap(), configuration);
    assert_eq!(fs::read(dir.path().join("uapkg.json")).unwrap(), manifest);
    for name in ["catalog", "staging", "locks", "maintenance"] {
        assert!(!home.join(name).exists(), "Listing created {name}");
    }
    assert!(!home.join("engines/1.7.2").exists());
}

#[test]
fn local_list_merges_roles_and_names_only_the_roles_using_an_alias() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".uapkg");
    fixture_cache(&home, "1.7.2", platform().unwrap());
    write(
        &home.join("config.json"),
        json!({"launcher":{"defaultCliVersion":"1.7.2"}}),
    );
    write(
        &dir.path().join("uapkg.json"),
        json!({"kind":"project","uapkgVersion":"latest"}),
    );
    write(
        &home.join("catalog/cli/resolutions.json"),
        json!({"active":{"latest":"1.7.2"}}),
    );
    let resolutions = fs::read(home.join("catalog/cli/resolutions.json")).unwrap();
    let output = listed(run(
        &home,
        dir.path(),
        &["version", "list", "--cli-version=1.7.2"],
    ));
    assert_eq!(
        output,
        concat!(
            "1.7.2 (global default, project pin, cli override, installed) (project pin uses alias `latest`)\n",
            "\nTo see the list of available versions, run `uapkg version list available`.\n"
        )
    );
    assert_eq!(
        fs::read(home.join("catalog/cli/resolutions.json")).unwrap(),
        resolutions
    );
    assert_eq!(fs::read_dir(home.join("catalog/cli")).unwrap().count(), 1);
    assert!(!home.join("staging").exists());
}

#[test]
fn local_list_omits_unset_selections_and_keeps_uncached_aliases_visible() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".uapkg");
    let footer = "\nTo see the list of available versions, run `uapkg version list available`.\n";
    assert_eq!(
        listed(run(&home, dir.path(), &["version", "list"])),
        format!("No CLI versions are installed for this platform.\n{footer}")
    );
    assert!(!home.exists());
    fixture_cache(&home, "1.7.0", platform().unwrap());
    assert_eq!(
        listed(run(&home, dir.path(), &["version", "list"])),
        format!("1.7.0\n{footer}")
    );
    write(&dir.path().join("uapkg.json"), json!({"kind":"project"}));
    write(
        &home.join("config.json"),
        json!({"launcher":{"defaultCliVersion":"latest"}}),
    );
    assert_eq!(
        listed(run(&home, dir.path(), &["version", "list"])),
        format!("latest (global default, unresolved)\n\n1.7.0\n{footer}")
    );
    assert!(!home.join("catalog").exists());
}

#[test]
fn two_project_pins_global_commands_unknown_commands_and_override_delegate_correctly() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".uapkg");
    fixture_engine(&home, "github-releases", "1.2.3");
    fixture_engine(&home, "github-releases", "2.0.0");
    write(
        &home.join("config.json"),
        json!({"launcher":{"defaultCliVersion":"1.2.3"},"registry":"team"}),
    );
    let a = dir.path().join("Project A");
    let b = dir.path().join("Project B");
    write(
        &a.join("uapkg.json"),
        json!({"kind":"project","uapkgVersion":"1.2.3"}),
    );
    write(
        &b.join("uapkg.json"),
        json!({"kind":"project","uapkgVersion":"2.0.0"}),
    );
    write(
        &b.join(".uapkg/config.json"),
        json!({"launcher":{"defaultCliVersion":"99.0.0"}}),
    );
    selected(run(&home, &a, &["--offline", "install"]), "1.2.3");
    let body = selected(
        run(
            &home,
            &b,
            &[
                "--offline",
                "future-command",
                "a b",
                "--offline",
                "--",
                "--offline",
                "--cli-version",
                "literal-value",
                "\"quoted\"",
                "",
            ],
        ),
        "2.0.0",
    );
    assert_eq!(
        body["args"],
        json!([
            "future-command",
            "a b",
            "--",
            "--offline",
            "--cli-version",
            "literal-value",
            "\"quoted\"",
            ""
        ])
    );
    assert_eq!(body["sentinel"], "unchanged");
    assert!(body["debugContext"].is_null());
    assert_eq!(
        Path::new(body["cwd"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        b.canonicalize().unwrap()
    );
    selected(run(&home, &b, &["--offline", "whoami"]), "1.2.3");
    selected(
        run(
            &home,
            &a,
            &["--offline", "--cli-version", "2.0.0", "whoami"],
        ),
        "2.0.0",
    );
    selected(run(&home, &b, &["--offline", "--version"]), "2.0.0");
    for args in [
        vec!["--version", "--cli-version", "2.0.0", "--offline"],
        vec!["--cli-version=2.0.0", "--version", "--offline"],
        vec!["--offline", "--version", "--cli-version=2.0.0"],
    ] {
        let body = selected(run(&home, &a, &args), "2.0.0");
        assert_eq!(body["args"], json!(["--version"]));
    }
    for command in ["login", "logout", "whoami"] {
        let body = selected(
            run(&home, &a, &[command, "--cli-version", "2.0.0", "--offline"]),
            "2.0.0",
        );
        assert_eq!(body["args"], json!([command]));
    }
    let body = selected(
        run(
            &home,
            &a,
            &[
                "future-command",
                "payload",
                "--cli-version=2.0.0",
                "--offline",
            ],
        ),
        "2.0.0",
    );
    assert_eq!(body["args"], json!(["future-command", "payload"]));
    let body = selected(
        run(
            &home,
            &a,
            &[
                "future-command",
                "--registry",
                "--cli-version=9.0.0",
                "--config",
                "--offline",
                "--cli-version=2.0.0",
                "--offline",
            ],
        ),
        "2.0.0",
    );
    assert_eq!(
        body["args"],
        json!([
            "future-command",
            "--registry",
            "--cli-version=9.0.0",
            "--config",
            "--offline"
        ])
    );
    let current = run(&home, &a, &["--cli-version", "2.0.0", "version", "current"]);
    assert!(current.status.success());
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "2.0.0");
    let current = run(
        &home,
        &a,
        &["version", "current", "--cli-version=2.0.0", "--offline"],
    );
    assert!(current.status.success());
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "2.0.0");
    let failure = Command::new(env!("CARGO_BIN_EXE_uapkg"))
        .args(["--offline", "install"])
        .current_dir(&b)
        .env("HOME", dir.path())
        .env("USERPROFILE", dir.path())
        .env("UAPKG_TEST_EXIT", "37")
        .output()
        .unwrap();
    assert_eq!(failure.status.code(), Some(37));
}

#[test]
fn diagnostics_report_launcher_location_without_raw_arguments_or_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".uapkg");
    fixture_engine(&home, "github-releases", "1.2.3");
    fixture_engine(&home, "github-releases", "2.0.0");
    write(
        &home.join("config.json"),
        json!({"launcher":{"defaultCliVersion":"1.2.3"},"unrelatedSecret":"config-secret-token"}),
    );
    let project = dir.path().join("private-project-name");
    write(
        &project.join("uapkg.json"),
        json!({"kind":"project","uapkgVersion":"2.0.0","unrelatedSecret":"manifest-secret-token"}),
    );
    let pinned = selected(
        run(
            &home,
            &project,
            &[
                "install",
                "--debug-info",
                "raw-argument-secret-token",
                "--offline",
            ],
        ),
        "2.0.0",
    );
    let context = &pinned["debugContext"];
    let launcher_path = context["launcherPath"].as_str().unwrap();
    assert!(Path::new(launcher_path).is_absolute());
    assert_eq!(
        Path::new(launcher_path).canonicalize().unwrap(),
        Path::new(env!("CARGO_BIN_EXE_uapkg"))
            .canonicalize()
            .unwrap()
    );
    assert_eq!(
        context,
        &json!({"schemaVersion":1,"launcherVersion":env!("CARGO_PKG_VERSION"),"launcherPath":launcher_path,"installMethod":"standalone","globalSettingsState":"available","globalCliVersion":"1.2.3","projectCliVersion":"2.0.0","projectState":"pinned","overrideCliVersion":null,"selectedCliVersion":"2.0.0","selectionReason":"project-pin","engineKind":"node","offline":true})
    );
    let serialized = context.to_string();
    for forbidden in [
        "private-project-name",
        "config-secret-token",
        "manifest-secret-token",
        "raw-argument-secret-token",
        "stale-parent-context",
    ] {
        assert!(!serialized.contains(forbidden));
    }
    assert!(!serialized.contains(&dir.path().to_string_lossy().to_string()));

    let overridden = selected(
        run(
            &home,
            &project,
            &["install", "--cli-version", "1.2.3", "--debug-info=true"],
        ),
        "1.2.3",
    );
    assert_eq!(overridden["debugContext"]["selectionReason"], "override");
    assert_eq!(overridden["debugContext"]["overrideCliVersion"], "1.2.3");
    assert_eq!(overridden["debugContext"]["projectCliVersion"], "2.0.0");
    assert_eq!(overridden["debugContext"]["offline"], false);
    let global = selected(run(&home, &project, &["whoami", "--debug-info"]), "1.2.3");
    assert_eq!(global["debugContext"]["selectionReason"], "global-command");
    assert_eq!(global["debugContext"]["projectCliVersion"], "2.0.0");
    let no_project = selected(run(&home, dir.path(), &["--debug-info"]), "1.2.3");
    assert_eq!(
        no_project["debugContext"]["selectionReason"],
        "global-default"
    );
    assert_eq!(no_project["debugContext"]["projectState"], "none");
    let unpinned = project.join("nested");
    write(&unpinned.join("uapkg.json"), json!({"kind":"project"}));
    let unpinned = selected(run(&home, &unpinned, &["--debug-info"]), "1.2.3");
    assert_eq!(unpinned["debugContext"]["projectState"], "unpinned");
    assert!(unpinned["debugContext"]["projectCliVersion"].is_null());

    fs::write(
        project.join("uapkg.json"),
        "malformed-secret-manifest-content",
    )
    .unwrap();
    for args in [
        vec!["whoami", "--debug-info"],
        vec!["install", "--cli-version=1.2.3", "--debug-info"],
    ] {
        let result = selected(run(&home, &project, &args), "1.2.3");
        assert_eq!(result["debugContext"]["projectState"], "unavailable");
        assert!(result["debugContext"]["projectCliVersion"].is_null());
        assert!(
            !result["debugContext"]
                .to_string()
                .contains("malformed-secret")
        );
    }
    for args in [
        vec!["install"],
        vec!["install", "--debug-info=false"],
        vec!["install", "--debug-info", "--no-debug-info"],
        vec!["install", "--debug-info", "--debug-info=false"],
        vec!["install", "--", "--debug-info"],
        vec!["install", "--registry", "--debug-info"],
        vec!["--version", "--debug-info"],
    ] {
        let mut args = args;
        args.insert(0, "--offline");
        let result = selected(run(&home, dir.path(), &args), "1.2.3");
        assert!(result["debugContext"].is_null(), "{args:?}");
    }
    let missing = run(
        &home,
        dir.path(),
        &["--debug-info", "--cli-version=999.0.0", "--offline"],
    );
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("not cached"));
    assert!(!home.join("staging").exists());
    let configuration_before = fs::read(home.join("config.json")).unwrap();
    for args in [
        vec!["launcher-update", "--debug-info"],
        vec!["version", "install", "999.0.0", "--debug-info"],
        vec!["launcher", "--debug-info"],
    ] {
        let body = selected(run(&home, &project, &args), "1.2.3");
        assert_eq!(body["args"], json!(args));
        assert_eq!(body["debugContext"]["selectionReason"], "global-command");
        assert_eq!(body["debugContext"]["projectState"], "unavailable");
    }
    assert_eq!(
        fs::read(home.join("config.json")).unwrap(),
        configuration_before
    );
    assert!(!home.join("engines/github-releases/999.0.0").exists());
    assert!(!home.join("staging").exists());
    write(
        &home.join("config.json"),
        json!({"launcher":{"defaultCliVersion":"999.0.0"}}),
    );
    let missing = run(
        &home,
        dir.path(),
        &["launcher-update", "--debug-info", "--offline"],
    );
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("not cached"));
    assert!(!home.join("staging").exists());
}

#[test]
fn diagnostics_honor_environment_offline_for_cached_and_missing_overrides() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".uapkg");
    fixture_engine(&home, "github-releases", "1.2.3");
    let run_offline = |version: &str| {
        Command::new(env!("CARGO_BIN_EXE_uapkg"))
            .args(["--debug-info", "--cli-version", version])
            .current_dir(dir.path())
            .env("HOME", dir.path())
            .env("USERPROFILE", dir.path())
            .env("UAPKG_OFFLINE", "1")
            .env("PATH", "")
            .output()
            .unwrap()
    };

    let cached = selected(run_offline("1.2.3"), "1.2.3");
    assert_eq!(cached["debugContext"]["offline"], true);
    assert_eq!(cached["debugContext"]["selectionReason"], "override");
    assert_eq!(cached["args"], json!(["--debug-info"]));

    let missing = run_offline("999.0.0");
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("not cached"));
    assert!(!home.join("staging").exists());
    assert!(
        !home
            .join("engines/999.0.0")
            .join(platform().unwrap())
            .exists()
    );
}

#[test]
fn diagnostics_leave_pending_update_recovery_files_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".uapkg");
    fixture_engine(&home, "github-releases", "1.2.3");
    write(
        &home.join("config.json"),
        json!({"launcher":{"defaultCliVersion":"1.2.3"}}),
    );
    let name = if cfg!(windows) { "uapkg.exe" } else { "uapkg" };
    let executable = dir.path().join(name);
    fs::copy(env!("CARGO_BIN_EXE_uapkg"), &executable).unwrap();
    let backup = dir.path().join("saved-launcher");
    fs::copy(&executable, &backup).unwrap();
    let digest = uapkg_launcher::archive::sha256(&executable).unwrap();
    let journal = dir.path().join("uapkg-update.json");
    write(
        &journal,
        json!({"schemaVersion":1,"executable":name,"backup":"saved-launcher","previousSha256":digest,"nextSha256":"0".repeat(64),"nextVersion":"0.2.0"}),
    );
    let before = fs::read(&journal).unwrap();
    let output = Command::new(&executable)
        .arg("--debug-info")
        .current_dir(dir.path())
        .env("HOME", dir.path())
        .env("USERPROFILE", dir.path())
        .output()
        .unwrap();
    selected(output, "1.2.3");
    assert_eq!(fs::read(journal).unwrap(), before);
    assert!(backup.exists());
    assert!(!dir.path().join("uapkg-update.lock").exists());
}

#[cfg(feature = "development")]
#[test]
fn development_binding_uses_checkout_and_reports_its_actual_version() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let binary = root.join(if cfg!(windows) { "uapkg.exe" } else { "uapkg" });
    fs::copy(env!("CARGO_BIN_EXE_uapkg"), &binary).unwrap();
    fs::write(root.join("local.cjs"), r#"
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
if(args.includes('--debug-info')) {
  console.log(JSON.stringify(JSON.parse(process.env.UAPKG_LAUNCHER_CONTEXT)));
} else if(args[0]==='config' && args[1]==='set' && args[2]==='launcher.defaultCliVersion' && args[4]==='--global') {
  const file=path.join(process.env.USERPROFILE || process.env.HOME,'.uapkg-development','config.json');
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  config.launcher={...config.launcher,defaultCliVersion:args[3]};
  fs.writeFileSync(file,JSON.stringify(config));
  console.log('local config writer');
} else console.log('local checkout');
"#).unwrap();
    write(
        &root.join("uapkg-install.json"),
        json!({"schemaVersion":1,"installMethod":"development","defaultCliVersion":"1.2.3","development":{"enginePath":root.join("local.cjs"),"nodePath":node_path(),"checkoutPath":root}}),
    );
    write(
        &root.join("uapkg.json"),
        json!({"kind":"project","uapkgVersion":"99.0.0"}),
    );
    let output = Command::new(&binary)
        .args(["--offline", "install"])
        .current_dir(root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "local checkout"
    );
    let output = Command::new(&binary)
        .args(["version", "current"])
        .current_dir(root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "1.2.3");
    let development_profile = root.join(".uapkg-development");
    fixture_engine(&development_profile, "github-releases", "2.0.0");
    write(
        &development_profile.join("config.json"),
        json!({"launcher":{"defaultCliVersion":"1.2.3"},"registry":"development"}),
    );
    let production_config = root.join(".uapkg/config.json");
    write(
        &production_config,
        json!({"launcher":{"defaultCliVersion":"8.0.0"},"registry":"production"}),
    );
    let production_before = fs::read(&production_config).unwrap();
    let output = Command::new(&binary)
        .args(["--offline", "version", "default", "2.0.0"])
        .current_dir(root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "local config writer"
    );
    let config: Value =
        serde_json::from_slice(&fs::read(development_profile.join("config.json")).unwrap())
            .unwrap();
    assert_eq!(config["launcher"]["defaultCliVersion"], "2.0.0");
    assert_eq!(config["registry"], "development");
    assert_eq!(fs::read(production_config).unwrap(), production_before);
    let debug = Command::new(&binary)
        .arg("--debug-info")
        .current_dir(root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("UAPKG_LAUNCHER_CONTEXT", "stale-parent-context")
        .output()
        .unwrap();
    assert!(
        debug.status.success(),
        "{}",
        String::from_utf8_lossy(&debug.stderr)
    );
    let context: Value = serde_json::from_slice(&debug.stdout).unwrap();
    assert_eq!(context["selectionReason"], "development");
    assert_eq!(context["selectedCliVersion"], "1.2.3");
    assert_eq!(context["engineKind"], "development");
    assert_eq!(context["installMethod"], "development");
    let launcher_path = context["launcherPath"].as_str().unwrap();
    assert!(Path::new(launcher_path).is_absolute());
    assert_eq!(
        Path::new(launcher_path).canonicalize().unwrap(),
        binary.canonicalize().unwrap()
    );
    assert_eq!(context["globalCliVersion"], "2.0.0");
    assert_eq!(context["projectCliVersion"], "99.0.0");
    for command in ["current", "list"] {
        let output = Command::new(&binary)
            .args(["version", command, "--cli-version=2.0.0", "--offline"])
            .current_dir(root)
            .env("HOME", root)
            .env("USERPROFILE", root)
            .output()
            .unwrap();
        assert!(!output.status.success(), "{command}: {output:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("--cli-version is unavailable for a development checkout binding"),
            "{command}: {output:?}"
        );
    }
    fs::write(
        development_profile.join("config.json"),
        "secret-malformed-config",
    )
    .unwrap();
    fs::write(root.join("uapkg.json"), "secret-malformed-project").unwrap();
    let debug = Command::new(&binary)
        .arg("--debug-info")
        .current_dir(root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .output()
        .unwrap();
    assert!(
        debug.status.success(),
        "{}",
        String::from_utf8_lossy(&debug.stderr)
    );
    let context: Value = serde_json::from_slice(&debug.stdout).unwrap();
    assert_eq!(context["globalSettingsState"], "unavailable");
    assert!(context["cliSource"].is_null());
    assert!(context["globalCliVersion"].is_null());
    assert_eq!(context["projectState"], "unavailable");
    assert!(context["projectCliVersion"].is_null());
    assert!(!String::from_utf8_lossy(&debug.stdout).contains("secret-malformed"));
}

#[test]
fn changing_the_default_delegates_configuration_writes_to_the_selected_engine() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".uapkg");
    fixture_engine(&home, "github-releases", "1.2.3");
    fixture_engine(&home, "github-releases", "2.0.0");
    let global = json!({"launcher":{"defaultCliVersion":"1.2.3"},"registry":"keep-this","term":{"quiet":true}});
    write(&home.join("config.json"), global.clone());

    // A CLI which only reports its arguments cannot mutate configuration. This
    // proves the launcher does not write behind the delegated engine's back.
    let reporting = selected(
        run(
            &home,
            dir.path(),
            &["--offline", "version", "default", "2.0.0"],
        ),
        "2.0.0",
    );
    assert_eq!(
        reporting["args"],
        json!([
            "config",
            "set",
            "launcher.defaultCliVersion",
            "2.0.0",
            "--global"
        ])
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(home.join("config.json")).unwrap()).unwrap(),
        global
    );

    let output = Command::new(env!("CARGO_BIN_EXE_uapkg"))
        .args(["--offline", "version", "default", "2.0.0"])
        .current_dir(dir.path())
        .env("HOME", dir.path())
        .env("USERPROFILE", dir.path())
        .env("UAPKG_TEST_CONFIG_WRITER", "1")
        .env("PATH", "")
        .output()
        .unwrap();
    selected(output, "2.0.0");
    let updated: Value =
        serde_json::from_slice(&fs::read(home.join("config.json")).unwrap()).unwrap();
    assert_eq!(updated["launcher"]["defaultCliVersion"], "2.0.0");
    assert_eq!(updated["registry"], global["registry"]);
    assert_eq!(updated["term"], global["term"]);
    assert!(!home.join("launcher.json").exists());
}
