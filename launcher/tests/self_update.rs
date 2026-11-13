use std::{fs, path::PathBuf, process::Command};
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
