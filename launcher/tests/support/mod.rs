use std::{
    io,
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

const SPAWN_ATTEMPTS: usize = 20;
const RETRY_DELAY: Duration = Duration::from_millis(25);

// Parallel test children can briefly inherit the writable descriptor used to
// copy an executable, even after fs::copy returns. Retry only that pre-launch
// failure; once a child starts, its exit and output must never be retried.
pub fn retry_spawn<T, E>(
    mut attempt: impl FnMut() -> Result<T, E>,
    is_executable_busy: impl Fn(&E) -> bool,
) -> Result<T, E> {
    for number in 1..=SPAWN_ATTEMPTS {
        match attempt() {
            Err(error) if number < SPAWN_ATTEMPTS && is_executable_busy(&error) => {
                thread::sleep(RETRY_DELAY);
            }
            result => return result,
        }
    }
    unreachable!("The final spawn attempt always returns its result")
}

pub fn spawn(command: &mut Command) -> io::Result<Child> {
    let started = Instant::now();
    let result = retry_spawn(
        || command.spawn(),
        |error| error.kind() == io::ErrorKind::ExecutableFileBusy,
    );
    if let Err(error) = &result
        && error.kind() == io::ErrorKind::ExecutableFileBusy
    {
        // Command's Debug output includes environment overrides. Log only the
        // program, arguments and working directory, and return the original error.
        eprintln!(
            "Could not start {:?} with arguments {:?} in {:?} after {SPAWN_ATTEMPTS} attempts ({:?}): {error}",
            command.get_program(),
            command.get_args().collect::<Vec<_>>(),
            command.get_current_dir(),
            started.elapsed(),
        );
    }
    result
}

// These test call sites use Command::output's default stdio. Call spawn directly
// when a fixture needs explicit stdin or stream handling.
pub fn output(command: &mut Command) -> io::Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    spawn(command)?.wait_with_output()
}
