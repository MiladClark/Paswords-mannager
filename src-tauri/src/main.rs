// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(caller) = std::env::args()
        .nth(1)
        .filter(|s| s.starts_with("chrome-extension://"))
    {
        tauri_smoke_test_lib::native_host(&caller);
        return;
    }
    tauri_smoke_test_lib::run()
}
