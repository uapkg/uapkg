use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::Command,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

fn node_path() -> PathBuf {
    if let Some(node) = std::env::var_os("UAPKG_TEST_NODE") {
        return node.into();
    }
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Run launcher tests through vp run launcher:test, or put Node on PATH");
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn exercise_terminal(script: &str, input: &[u8], expected: &str, exit_code: u32) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let launcher_name = if cfg!(windows) { "uapkg.exe" } else { "uapkg" };
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let launcher = root.join(launcher_name);
    fs::copy(env!("CARGO_BIN_EXE_uapkg"), &launcher).unwrap();
    let engine = root.join("cli");
    fs::create_dir(&engine).unwrap();
    let node = node_path();
    let bundled_node = engine.join(node_name);
    if fs::hard_link(&node, &bundled_node).is_err() {
        fs::copy(&node, &bundled_node).unwrap();
    }
    fs::write(engine.join("terminal.cjs"), script).unwrap();
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "win32-x64",
        ("windows", "aarch64") => "win32-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        _ => panic!("Unsupported test platform"),
    };
    fs::write(
        engine.join("engine.json"),
        json!({"schemaVersion":1,"version":"1.2.3","platform":platform,
            "kind":"node","executable":node_name,"args":["terminal.cjs"]})
        .to_string(),
    )
    .unwrap();
    fs::write(
        root.join("uapkg-install.json"),
        json!({"schemaVersion":1,"installMethod":"standalone", "defaultCliVersion":"1.2.3", "bundledEngine":"cli"}).to_string(),
    ).unwrap();

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(&launcher);
    command.arg("--offline");
    command.arg("terminal-fixture");
    command.cwd(root);
    command.env("HOME", root);
    command.env("USERPROFILE", root);
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
    let mut sent = false;
    let mut cursor_reports = 0;
    while Instant::now() < deadline && !transcript.contains(expected) {
        if let Ok(bytes) = receive.recv_timeout(Duration::from_millis(100)) {
            transcript.push_str(&String::from_utf8_lossy(&bytes));
            // ConPTY asks its terminal host for the initial cursor position.
            // We are the terminal host here, so answer before awaiting Node.
            let requests = transcript.matches("\u{1b}[6n").count();
            for _ in cursor_reports..requests {
                writer.write_all(b"\x1b[1;1R").unwrap();
                writer.flush().unwrap();
            }
            cursor_reports = requests;
            if !sent && transcript.contains("READY:true:true:true") {
                writer.write_all(input).unwrap();
                writer.flush().unwrap();
                sent = true;
            }
        }
    }
    let mut result = None;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            result = Some(status);
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    if result.is_none() {
        child.kill().unwrap();
    }
    drop(writer);
    drop(pair.master);
    // Closing the PTY unblocks its reader on both ConPTY and Unix.
    reader_thread.join().unwrap();
    assert!(
        sent,
        "The engine did not retain terminal streams: {transcript}"
    );
    assert!(
        transcript.contains(expected),
        "Missing {expected:?}: {transcript}"
    );
    assert_eq!(
        result.expect("Launcher did not exit").exit_code(),
        exit_code
    );
}

#[test]
fn terminal_input_and_nonzero_status_survive_delegation() {
    exercise_terminal(
        r#"
process.stdin.setRawMode(true);
process.stdin.resume();
console.log(`READY:${process.stdin.isTTY}:${process.stdout.isTTY}:${process.stderr.isTTY}`);
process.stdin.once('data', data => process.stdout.write(`KEY:${data.toString()}\n`, () => process.exit(37)));
"#,
        b"k",
        "KEY:k",
        37,
    );
}

#[test]
fn control_c_reaches_the_engine_and_preserves_its_status() {
    exercise_terminal(
        r#"
process.on('SIGINT', () => process.stdout.write('SIGNAL:SIGINT\n', () => process.exit(130)));
process.stdin.resume();
console.log(`READY:${process.stdin.isTTY}:${process.stdout.isTTY}:${process.stderr.isTTY}`);
"#,
        b"\x03",
        "SIGNAL:SIGINT",
        130,
    );
}
