mod support;

use std::{
    fs,
    io::{self, Read},
    process::Command,
};

fn executable_busy(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::ExecutableFileBusy
}

#[test]
fn successful_spawns_are_not_repeated() {
    let mut attempts = 0;
    let result: io::Result<_> = support::retry_spawn(
        || {
            attempts += 1;
            Ok("started")
        },
        executable_busy,
    );
    assert_eq!(result.unwrap(), "started");
    assert_eq!(attempts, 1);
}

#[test]
fn busy_spawns_retry_until_the_child_starts() {
    let mut attempts = 0;
    let result = support::retry_spawn(
        || {
            attempts += 1;
            if attempts < 3 {
                Err(io::Error::from(io::ErrorKind::ExecutableFileBusy))
            } else {
                Ok("started")
            }
        },
        executable_busy,
    );
    assert_eq!(result.unwrap(), "started");
    assert_eq!(attempts, 3);
}

#[test]
fn busy_spawns_stop_at_the_bound_and_return_the_last_error() {
    let mut attempts = 0;
    let result: io::Result<()> = support::retry_spawn(
        || {
            attempts += 1;
            Err(io::Error::new(
                io::ErrorKind::ExecutableFileBusy,
                format!("busy attempt {attempts}"),
            ))
        },
        executable_busy,
    );
    let error = result.unwrap_err();
    assert_eq!(attempts, 20);
    assert_eq!(error.kind(), io::ErrorKind::ExecutableFileBusy);
    assert_eq!(error.to_string(), "busy attempt 20");
}

#[test]
fn other_spawn_errors_are_returned_without_retry() {
    for kind in [
        io::ErrorKind::NotFound,
        io::ErrorKind::PermissionDenied,
        io::ErrorKind::Interrupted,
        io::ErrorKind::WouldBlock,
        io::ErrorKind::InvalidInput,
        io::ErrorKind::Other,
    ] {
        let mut attempts = 0;
        let result: io::Result<()> = support::retry_spawn(
            || {
                attempts += 1;
                Err(io::Error::new(kind, "original spawn error"))
            },
            executable_busy,
        );
        let error = result.unwrap_err();
        assert_eq!(attempts, 1);
        assert_eq!(error.kind(), kind);
        assert_eq!(error.to_string(), "original spawn error");
    }
}

#[test]
fn a_different_error_after_a_busy_spawn_stops_immediately() {
    let mut attempts = 0;
    let result: io::Result<()> = support::retry_spawn(
        || {
            attempts += 1;
            if attempts == 1 {
                Err(io::Error::from(io::ErrorKind::ExecutableFileBusy))
            } else {
                Err(io::Error::from_raw_os_error(2))
            }
        },
        executable_busy,
    );
    assert_eq!(attempts, 2);
    assert_eq!(result.unwrap_err().raw_os_error(), Some(2));
}

#[test]
fn output_preserves_spawn_errors() {
    let directory = tempfile::tempdir().unwrap();
    let error = support::output(&mut Command::new(
        directory.path().join("missing-executable"),
    ))
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
    assert!(error.raw_os_error().is_some());
}

#[test]
fn output_fixture_child() {
    let Some(marker) = std::env::var_os("UAPKG_TEST_OUTPUT_MARKER") else {
        return;
    };
    let mut contents = fs::read(&marker).unwrap_or_default();
    contents.push(b'x');
    fs::write(marker, contents).unwrap();
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    assert!(input.is_empty());
    println!("captured fixture stdout");
    eprintln!("captured fixture stderr");
    std::process::exit(37);
}

#[test]
fn output_preserves_streams_and_nonzero_status_without_restarting_the_child() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("starts");
    let output = support::output(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "output_fixture_child", "--nocapture"])
            .env("UAPKG_TEST_OUTPUT_MARKER", &marker),
    )
    .unwrap();
    assert_eq!(output.status.code(), Some(37));
    assert!(String::from_utf8_lossy(&output.stdout).contains("captured fixture stdout"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("captured fixture stderr"));
    assert_eq!(fs::read(marker).unwrap(), b"x");
}
