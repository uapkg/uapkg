pub(crate) fn development() {
    #[cfg(feature = "development")]
    {
        use colored::Colorize;
        use std::io::{IsTerminal, Write};

        let mut stderr = std::io::stderr().lock();
        let color_disabled = std::env::var_os("NO_COLOR").is_some()
            || std::env::var_os("FORCE_COLOR").is_some_and(|value| value == "0")
            || std::env::var_os("TERM").is_some_and(|value| value == "dumb");
        // colored enables Windows VT processing through stdout's console handle.
        // Use plain text if that handle is redirected instead of emitting raw ANSI.
        let color_terminal =
            stderr.is_terminal() && (!cfg!(windows) || std::io::stdout().is_terminal());
        if color_terminal && !color_disabled {
            // colored normally checks stdout; this banner belongs to stderr.
            colored::control::set_override(true);
            #[cfg(windows)]
            let _ = colored::control::set_virtual_terminal(true);
            // Halfway between black and red: RGB(128, 0, 0), with white text.
            let _ = writeln!(
                stderr,
                "{}",
                "DEVELOPMENT BUILD [LAUNCHER]"
                    .white()
                    .on_truecolor(128, 0, 0)
            );
            colored::control::unset_override();
        } else {
            let _ = writeln!(stderr, "DEVELOPMENT BUILD [LAUNCHER]");
        }
    }
}
