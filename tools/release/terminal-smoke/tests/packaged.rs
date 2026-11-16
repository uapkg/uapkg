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
fn read_json(path: &std::path::Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
struct Engine {
    version: String,
    platform: String,
    executable: String,
    args: Vec<String>,
}
fn relative_path(value: &str) -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(value);
    if path.is_absolute() || value.contains("..") || value.contains('\\') {
        return Err("Unsafe engine path");
    }
    Ok(path)
}

struct Installation {
    launcher: PathBuf,
    engine_root: PathBuf,
    engine: Engine,
}

impl Installation {
    fn load() -> Self {
        let launcher = PathBuf::from(
            std::env::var_os("UAPKG_TEST_LAUNCHER").expect("Expected verified launcher"),
        );
        let engine_root =
            PathBuf::from(std::env::var_os("UAPKG_TEST_ENGINE").expect("Expected CLI engine"));
        assert!(launcher.is_absolute() && engine_root.is_absolute());
        let descriptor = read_json(&engine_root.join("engine.json"));
        assert_eq!(descriptor["schemaVersion"], 1);
        assert!(matches!(
            descriptor["kind"].as_str().unwrap(),
            "node" | "sea"
        ));
        let engine = Engine {
            version: descriptor["version"].as_str().unwrap().to_owned(),
            platform: descriptor["platform"].as_str().unwrap().to_owned(),
            executable: descriptor["executable"].as_str().unwrap().to_owned(),
            args: descriptor["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|arg| arg.as_str().unwrap().to_owned())
                .collect(),
        };
        Self {
            launcher,
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
    installation: &Installation,
    delegated: bool,
    args: &[&str],
    actions: &[(&str, &[u8])],
) -> TerminalOutput {
    let scratch = tempfile::tempdir().unwrap();
    let home = scratch.path().join(".uapkg");
    let cached = home
        .join("engines")
        .join(&installation.engine.version)
        .join(&installation.engine.platform);
    fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }
    copy_tree(&installation.engine_root, &cached);
    fs::write(cached.join(".installed.json"), serde_json::json!({"schemaVersion":1,"version":installation.engine.version,"platform":installation.engine.platform}).to_string()).unwrap();
    fs::write(
        home.join("config.json"),
        serde_json::json!({"launcher":{"defaultCliVersion":installation.engine.version}})
            .to_string(),
    )
    .unwrap();
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
    let mut command = installation.command(delegated);
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
        manifest: manifest_path.exists().then(|| read_json(&manifest_path)),
    }
}

#[test]
fn packaged_init_accepts_real_terminal_input_through_launcher() {
    let installation = Installation::load();
    let result = run_terminal(
        &installation,
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
    assert_eq!(manifest["uapkgVersion"], installation.engine.version);
}

#[test]
fn packaged_interrupt_status_survives_launcher_delegation() {
    let installation = Installation::load();
    let args = ["init", "--type", "project"];
    let actions: &[(&str, &[u8])] = &[("Package name", b"\x03")];
    let direct = run_terminal(&installation, false, &args, actions);
    let delegated = run_terminal(&installation, true, &args, actions);
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
fn packaged_nonzero_status_survives_launcher_delegation() {
    let installation = Installation::load();
    let args = ["release-smoke-unknown-command"];
    let direct = run_terminal(&installation, false, &args, &[]);
    let delegated = run_terminal(&installation, true, &args, &[]);
    assert!(!direct.status.success(), "{}", direct.transcript);
    assert_eq!(delegated.status.exit_code(), direct.status.exit_code());
    assert_eq!(delegated.status.signal(), direct.status.signal());
}
