use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use uapkg_launcher::{
    archive,
    model::VERSION,
    storage::{ContextPaths, atomic_json},
    updater::{self, Transaction},
};

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
