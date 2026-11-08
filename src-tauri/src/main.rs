// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_fs::FsExt;

/// PDF paths the app was started with (file association / "open with" / command line), waiting for
/// the page to collect them with `take_launch_paths`.
#[derive(Default)]
struct LaunchPaths(Mutex<Vec<String>>);

/// Picks the existing `.pdf` files out of a command line (the program name must already be removed),
/// resolving relative paths against `cwd`. Each one is also added to the fs scope: files the user
/// picks in a dialog or drops on the window are scoped automatically, command-line ones are not.
fn pdf_paths(app: &AppHandle, args: impl Iterator<Item = String>, cwd: Option<&Path>) -> Vec<String> {
    args.filter(|arg| !arg.starts_with('-'))
        .map(|arg| match cwd {
            Some(dir) => dir.join(arg),
            None => PathBuf::from(arg),
        })
        .filter(|path| {
            path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("pdf")) && path.is_file()
        })
        .filter_map(|path| {
            app.fs_scope().allow_file(&path).ok()?;
            path.to_str().map(str::to_owned)
        })
        .collect()
}

#[tauri::command]
fn take_launch_paths(state: State<LaunchPaths>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

fn main() {
    tauri::Builder::default()
        // Must be the first plugin. A second launch (e.g. double-clicking another PDF) hands its
        // command line to the running window instead of starting a new process.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = pdf_paths(app, argv.into_iter().skip(1), Some(Path::new(&cwd)));
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if !paths.is_empty() {
                let _ = app.emit("open-paths", paths);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Must come after the fs plugin: persists the scope that dialogs grant.
        .plugin(tauri_plugin_persisted_scope::init())
        .manage(LaunchPaths::default())
        .setup(|app| {
            let paths = pdf_paths(app.handle(), std::env::args().skip(1), None);
            *app.state::<LaunchPaths>().0.lock().unwrap() = paths;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![take_launch_paths])
        .run(tauri::generate_context!())
        .expect("error while running the PDF editor");
}
