// Prevents an extra console window on Windows in release. Does nothing on other
// platforms.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    etta_lib::run();
}
