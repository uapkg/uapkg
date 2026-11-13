fn main() {
    match uapkg_launcher::run(std::env::args_os().skip(1).collect()) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("uapkg: {error:#}");
            std::process::exit(1);
        }
    }
}
