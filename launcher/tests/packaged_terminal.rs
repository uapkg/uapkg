//! Release qualification: exercise the actual shipped CLI and its launcher,
//! including SEA. These tests never substitute a system Node or a test engine.
use portable_pty::{CommandBuilder, ExitStatus, PtySize, native_pty_system};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use uapkg_launcher::model::{Engine, Receipt, platform, read_json, relative_path};

struct Bundle {
    launcher: PathBuf,
    engine_root: PathBuf,
    engine: Engine,
}

impl Bundle {
    fn load() -> Self {
        let root = PathBuf::from(
            std::env::var_os("UAPKG_TEST_BUNDLE")
                .expect("Set UAPKG_TEST_BUNDLE to the generated release bundle"),
        );
        assert!(root.is_absolute(), "The bundle path must be absolute");
        let receipt: Receipt = read_json(&root.join("uapkg-install.json")).unwrap();
        assert_eq!(receipt.install_method, "standalone");
        let engine_root = root.join(relative_path(&receipt.bundled_engine.unwrap()).unwrap());
        let engine = Engine::read(
            &engine_root,
            receipt.default_cli_version.as_ref().unwrap(),
            platform().unwrap(),
        )
        .unwrap();
        assert!(matches!(engine.kind.as_str(), "node" | "sea"));
        Self {
            launcher: root.join(if cfg!(windows) { "uapkg.exe" } else { "uapkg" }),
            engine_root,
            engine,
        }
    }

    fn command(&self, delegated: bool) -> CommandBuilder {
        if delegated {
            let mut command = CommandBuilder::new(&self.launcher);
            command.arg("--offline");
            command
        } else {
            let mut command = CommandBuilder::new(
                self.engine_root
                    .join(relative_path(&self.engine.executable).unwrap()),
            );
            for arg in &self.engine.args {
                command.arg(self.engine_root.join(relative_path(arg).unwrap()));
            }
            command
        }
    }
}

struct TerminalOutput {
    status: ExitStatus,
    transcript: String,
    manifest: Option<Value>,
}

fn run_terminal(
    bundle: &Bundle,
    delegated: bool,
    args: &[&str],
    actions: &[(&str, &[u8])],
) -> TerminalOutput {
    let scratch = tempfile::tempdir().unwrap();
    let cwd = scratch.path().join("input-project");
    fs::create_dir(&cwd).unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = bundle.command(delegated);
    command.args(args);
    command.cwd(&cwd);
    command.env("HOME", scratch.path());
    command.env("USERPROFILE", scratch.path());
    command.env("NODE_OPTIONS", "");
    command.env("NODE_PATH", "");
    // Deliberately exercise the interactive user path even on a CI runner.
    command.env("CI", "false");
    command.env("CONTINUOUS_INTEGRATION", "false");
    command.env("TERM", "xterm-256color");
    command.env("NO_COLOR", "1");
    command.env("FORCE_COLOR", "0");
    command.env("PATH", "");
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (send, receive) = mpsc::channel();
    let reader_thread = thread::spawn(move || {
        let mut buffer = [0; 4096];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 || send.send(buffer[..count].to_vec()).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut transcript = String::new();
    let mut action = 0;
    let mut cursor_reports = 0;
    let mut status = None;
    while Instant::now() < deadline {
        if let Ok(bytes) = receive.recv_timeout(Duration::from_millis(50)) {
            transcript.push_str(&String::from_utf8_lossy(&bytes));
            // ConPTY needs its terminal host to answer the initial cursor query.
            let requests = transcript.matches("\u{1b}[6n").count();
            for _ in cursor_reports..requests {
                writer.write_all(b"\x1b[1;1R").unwrap();
                writer.flush().unwrap();
            }
            cursor_reports = requests;
            if let Some((ready, input)) = actions.get(action)
                && transcript.contains(ready)
            {
                writer.write_all(input).unwrap();
                writer.flush().unwrap();
                action += 1;
            }
            if transcript.len() > 256 * 1024 {
                break;
            }
        }
        if let Some(result) = child.try_wait().unwrap() {
            status = Some(result);
            break;
        }
    }
    if status.is_none() {
        child.kill().unwrap();
        // Reap a timed-out process without turning a failed qualification into
        // an unbounded wait. portable-pty escalates Unix termination to SIGKILL.
        let reap_deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < reap_deadline && child.try_wait().unwrap().is_none() {
            thread::sleep(Duration::from_millis(25));
        }
    }
    drop(writer);
    drop(pair.master);
    let reader_deadline = Instant::now() + Duration::from_secs(5);
    while !reader_thread.is_finished() && Instant::now() < reader_deadline {
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        reader_thread.is_finished(),
        "PTY reader did not close: {transcript}"
    );
    reader_thread.join().unwrap();
    for bytes in receive.try_iter() {
        transcript.push_str(&String::from_utf8_lossy(&bytes));
    }
    assert_eq!(
        action,
        actions.len(),
        "The packaged CLI did not render or accept terminal input: {transcript}"
    );
    let status =
        status.unwrap_or_else(|| panic!("Packaged CLI did not exit within 20s: {transcript}"));
    let manifest_path = cwd.join("uapkg.json");
    TerminalOutput {
        status,
        transcript,
        manifest: manifest_path
            .exists()
            .then(|| read_json(&manifest_path).unwrap()),
    }
}

#[test]
#[ignore = "requires a built release bundle; invoked by release:smoke-native"]
fn packaged_init_accepts_real_terminal_input_through_launcher() {
    let bundle = Bundle::load();
    let result = run_terminal(
        &bundle,
        true,
        &["init", "--type", "project"],
        &[("Package name", b"-typed"), ("input-project-typed", b"\r")],
    );
    assert!(result.status.success(), "{}", result.transcript);
    let manifest = result
        .manifest
        .expect("Interactive init must write uapkg.json");
    assert_eq!(manifest["name"], "input-project-typed");
    assert_eq!(manifest["kind"], "project");
    assert_eq!(manifest["uapkgVersion"], bundle.engine.version);
}

#[test]
#[ignore = "requires a built release bundle; invoked by release:smoke-native"]
fn packaged_interrupt_status_survives_launcher_delegation() {
    let bundle = Bundle::load();
    let args = ["init", "--type", "project"];
    let actions: &[(&str, &[u8])] = &[("Package name", b"\x03")];
    let direct = run_terminal(&bundle, false, &args, actions);
    let delegated = run_terminal(&bundle, true, &args, actions);
    assert!(
        direct.manifest.is_none(),
        "Interrupted init wrote a manifest"
    );
    assert!(
        delegated.manifest.is_none(),
        "Interrupted init wrote a manifest"
    );
    assert_eq!(delegated.status.exit_code(), direct.status.exit_code());
    assert_eq!(delegated.status.signal(), direct.status.signal());
}

#[test]
#[ignore = "requires a built release bundle; invoked by release:smoke-native"]
fn packaged_nonzero_status_survives_launcher_delegation() {
    let bundle = Bundle::load();
    let args = ["release-smoke-unknown-command"];
    let direct = run_terminal(&bundle, false, &args, &[]);
    let delegated = run_terminal(&bundle, true, &args, &[]);
    assert!(!direct.status.success(), "{}", direct.transcript);
    assert_eq!(delegated.status.exit_code(), direct.status.exit_code());
    assert_eq!(delegated.status.signal(), direct.status.signal());
}
