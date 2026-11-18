use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use uapkg_launcher::{
    archive,
    model::{VERSION, platform},
    storage::{ContextPaths, atomic_json},
    updater::{self, Transaction},
};

const TEST_ENGINE_VERSION: &str = "3.2.1";

// This test body doubles as a child-process fixture. It only replaces a copied
// test executable under a temporary directory, never the Cargo build artifact.
#[test]
fn replacement_child() {
    let Some(staged) = std::env::var_os("UAPKG_TEST_STAGED_LAUNCHER") else {
        return;
    };
    let executable = std::env::current_exe().unwrap();
    let context = ContextPaths {
        home: executable.parent().unwrap().join("profile"),
        executable,
        receipt: None,
    };
    updater::replace_staged(&context, &PathBuf::from(staged), VERSION).unwrap();
    if std::env::var_os("UAPKG_TEST_RESUME_UPDATE").is_some() {
        let args = [
            "--offline",
            "--exact",
            "resumed_engine_child",
            "--cli-version",
            TEST_ENGINE_VERSION,
            "--nocapture",
        ]
        .map(std::ffi::OsString::from);
        std::process::exit(updater::resume(&context, &args).unwrap().unwrap());
    }
}

#[test]
fn replaces_a_running_executable_and_removes_transaction_state() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory
        .path()
        .join(if cfg!(windows) { "uapkg.exe" } else { "uapkg" });
    fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
    let staged = PathBuf::from(env!("CARGO_BIN_EXE_uapkg"));
    let output = Command::new(&target)
        .args(["--exact", "replacement_child", "--nocapture"])
        .env("UAPKG_TEST_STAGED_LAUNCHER", &staged)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        archive::sha256(&target).unwrap(),
        archive::sha256(&staged).unwrap()
    );
    let version = Command::new(&target)
        .args(["launcher", "--version"])
        .output()
        .unwrap();
    assert!(version.status.success());
    assert_eq!(String::from_utf8_lossy(&version.stdout).trim(), VERSION);
    assert!(!directory.path().join("uapkg-update.json").exists());
    assert!(
        !directory
            .path()
            .join(if cfg!(windows) {
                "uapkg.exe.backup.exe"
            } else {
                "uapkg.backup"
            })
            .exists()
    );
}

#[test]
fn resumed_engine_child() {
    if std::env::var_os("UAPKG_TEST_RESUME_UPDATE").is_none() {
        return;
    }
    assert_eq!(
        std::env::args_os().skip(1).collect::<Vec<_>>(),
        ["--exact", "resumed_engine_child", "--nocapture"].map(std::ffi::OsString::from)
    );
    assert_eq!(std::env::var("UAPKG_LAUNCHER_VERSION").unwrap(), VERSION);
    assert_eq!(
        std::env::var("UAPKG_CLI_VERSION").unwrap(),
        TEST_ENGINE_VERSION
    );
    assert_eq!(
        std::env::current_dir().unwrap().file_name().unwrap(),
        "project with spaces"
    );
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
    assert_eq!(input.trim_end(), "input from parent");
    println!("Resumed command stdout");
    eprintln!("Resumed command stderr");
    std::process::exit(37);
}

#[test]
fn resumes_the_original_command_after_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory
        .path()
        .join(if cfg!(windows) { "uapkg.exe" } else { "uapkg" });
    let fixture = std::env::current_exe().unwrap();
    fs::copy(&fixture, &target).unwrap();
    let profile = directory.path().join(".uapkg");
    let platform = platform().unwrap();
    let engine = profile
        .join("engines")
        .join(TEST_ENGINE_VERSION)
        .join(platform);
    fs::create_dir_all(&engine).unwrap();
    let engine_exe = if cfg!(windows) {
        "engine.exe"
    } else {
        "engine"
    };
    fs::copy(fixture, engine.join(engine_exe)).unwrap();
    atomic_json(
        &engine.join("engine.json"),
        &serde_json::json!({
            "schemaVersion": 1,
            "version": TEST_ENGINE_VERSION,
            "platform": platform,
            "kind": "sea",
            "executable": engine_exe,
            "args": [],
        }),
    )
    .unwrap();
    atomic_json(
        &engine.join(".installed.json"),
        &serde_json::json!({
            "schemaVersion": 1,
            "version": TEST_ENGINE_VERSION,
            "platform": platform,
        }),
    )
    .unwrap();
    let cwd = directory.path().join("project with spaces");
    fs::create_dir(&cwd).unwrap();

    let mut child = Command::new(&target)
        .args(["--exact", "replacement_child", "--nocapture"])
        .current_dir(&cwd)
        .env(
            if cfg!(windows) { "USERPROFILE" } else { "HOME" },
            directory.path(),
        )
        .env("UAPKG_TEST_STAGED_LAUNCHER", env!("CARGO_BIN_EXE_uapkg"))
        .env("UAPKG_TEST_RESUME_UPDATE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"input from parent\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(37), "{stdout}\n{stderr}");
    assert_eq!(stdout.matches("Resumed command stdout").count(), 1);
    assert_eq!(stderr.matches("Resumed command stderr").count(), 1);
}

#[test]
fn returns_for_fallback_when_the_replacement_cannot_start() {
    let directory = tempfile::tempdir().unwrap();
    let context = ContextPaths {
        home: directory.path().join("profile"),
        executable: directory.path().join("missing-launcher"),
        receipt: None,
    };
    assert_eq!(updater::resume(&context, &[]).unwrap(), None);
}

#[test]
fn rejected_replacement_child() {
    let Some(staged) = std::env::var_os("UAPKG_TEST_REJECTED_STAGE") else {
        return;
    };
    let executable = std::env::current_exe().unwrap();
    let previous_sha256 = archive::sha256(&executable).unwrap();
    let context = ContextPaths {
        home: executable.parent().unwrap().join("profile"),
        executable,
        receipt: None,
    };
    let version = std::env::var("UAPKG_TEST_REJECTED_STAGE_VERSION").unwrap();
    let expected_errors = std::env::var("UAPKG_TEST_REJECTED_STAGE_ERROR").unwrap();
    let error = updater::replace_staged(&context, &PathBuf::from(staged), &version)
        .expect_err("A failed staged check must not replace the running launcher.");
    assert!(
        expected_errors
            .lines()
            .any(|expected| error.to_string() == expected),
        "{error:#}"
    );
    assert_eq!(
        archive::sha256(&context.executable).unwrap(),
        previous_sha256
    );
}

fn assert_rejected_staged_check(source: Option<&Path>, version: &str, expected_errors: &[&str]) {
    let directory = tempfile::tempdir().unwrap();
    let target = directory
        .path()
        .join(if cfg!(windows) { "uapkg.exe" } else { "uapkg" });
    fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
    let previous_sha256 = archive::sha256(&target).unwrap();
    let staged = directory.path().join(if cfg!(windows) {
        "staged.exe"
    } else {
        "staged"
    });
    if let Some(source) = source {
        fs::copy(source, &staged).unwrap();
    } else {
        fs::write(&staged, b"not an executable image").unwrap();
        // On Unix, exercise a bad executable image rather than a missing mode bit.
        fs::set_permissions(&staged, fs::metadata(&target).unwrap().permissions()).unwrap();
    }
    let staged_sha256 = archive::sha256(&staged).unwrap();
    let output = Command::new(&target)
        .args(["--exact", "rejected_replacement_child", "--nocapture"])
        .env("UAPKG_TEST_REJECTED_STAGE", &staged)
        .env("UAPKG_TEST_REJECTED_STAGE_VERSION", version)
        .env(
            "UAPKG_TEST_REJECTED_STAGE_ERROR",
            expected_errors.join("\n"),
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(archive::sha256(&target).unwrap(), previous_sha256);
    assert_eq!(archive::sha256(&staged).unwrap(), staged_sha256);
    assert!(!directory.path().join("uapkg-update.json").exists());
    assert!(
        !directory
            .path()
            .join(if cfg!(windows) {
                "uapkg.exe.backup.exe"
            } else {
                "uapkg.backup"
            })
            .exists()
    );
    // The original executable must remain runnable after the rejecting process exits.
    assert!(
        Command::new(&target)
            .args(["--exact", "rejected_replacement_child"])
            .env_remove("UAPKG_TEST_REJECTED_STAGE")
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[test]
fn rejects_an_invalid_staged_executable() {
    // Platforms can reject the image at spawn or return a child that exits unsuccessfully.
    assert_rejected_staged_check(
        None,
        VERSION,
        &[
            "Could not start the staged launcher.",
            "The staged launcher did not pass its version check.",
        ],
    );
}

#[test]
fn rejects_a_staged_executable_that_fails_the_version_command() {
    // The native Rust test harness rejects `launcher --version` with a nonzero exit.
    assert_rejected_staged_check(
        Some(&std::env::current_exe().unwrap()),
        VERSION,
        &["The staged launcher did not pass its version check."],
    );
}

#[test]
fn rejects_a_staged_executable_with_a_different_version() {
    let expected_version = format!("{VERSION}-staged-mismatch");
    assert_rejected_staged_check(
        Some(Path::new(env!("CARGO_BIN_EXE_uapkg"))),
        &expected_version,
        &["The staged launcher did not pass its version check."],
    );
}

#[test]
fn recovery_child() {
    if std::env::var_os("UAPKG_TEST_RECOVERY_CHILD").is_none() {
        return;
    }
    let error = updater::recover(&std::env::current_exe().unwrap()).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Recovered the previous launcher"),
        "{error:#}"
    );
}

#[test]
fn a_running_backup_can_restore_the_launcher_and_clean_itself_up() {
    let directory = tempfile::tempdir().unwrap();
    let executable = if cfg!(windows) { "uapkg.exe" } else { "uapkg" };
    let backup_name = if cfg!(windows) {
        "uapkg.exe.backup.exe"
    } else {
        "uapkg.backup"
    };
    let target = directory.path().join(executable);
    let backup = directory.path().join(backup_name);
    fs::copy(std::env::current_exe().unwrap(), &backup).unwrap();
    let previous_sha256 = archive::sha256(&backup).unwrap();
    fs::write(&target, b"interrupted replacement").unwrap();
    let transaction = Transaction {
        schema_version: 1,
        executable: executable.to_owned(),
        backup: backup_name.to_owned(),
        previous_sha256: previous_sha256.clone(),
        next_sha256: "0".repeat(64),
        next_version: "0.2.0".to_owned(),
    };
    atomic_json(&directory.path().join("uapkg-update.json"), &transaction).unwrap();
    let output = Command::new(&backup)
        .args(["--exact", "recovery_child", "--nocapture"])
        .env("UAPKG_TEST_RECOVERY_CHILD", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(archive::sha256(&target).unwrap(), previous_sha256);
    assert!(!directory.path().join("uapkg-update.json").exists());
    assert!(!backup.exists());
}
