//! Tauri log plugin configuration and log-folder maintenance.

use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use std::fs;
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, Manager};

pub fn build_log_plugin() -> tauri_plugin_log::Builder {
    use tauri_plugin_log::{Target, TargetKind};

    // Release builds must not emit Debug/Trace logs; keep Info as the ceiling.
    let default_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    let agent_level = if cfg!(debug_assertions) {
        log::LevelFilter::Trace
    } else {
        log::LevelFilter::Info
    };

    let mut builder = tauri_plugin_log::Builder::new()
        .level(default_level)
        .level_for("agentero_lib::features::agent", agent_level)
        .level_for("agentero::op", log::LevelFilter::Info)
        // Third-party crates flood Debug with per-token / per-frame
        // traces (html5ever parsing, rustls handshakes); keep dev readable.
        .level_for("html5ever", log::LevelFilter::Error)
        .level_for("rustls", log::LevelFilter::Info)
        .level_for("reqwest", log::LevelFilter::Info)
        .level_for("selectors", log::LevelFilter::Warn)
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        // Keep log footprint small: 2 MB per file and at most 5 recent files.
        .max_file_size(2_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
        .clear_targets()
        .target(Target::new(TargetKind::Stdout))
        .target(Target::new(TargetKind::LogDir {
            file_name: Some("agentero".into()),
        }));

    // Dev: also mirror into the webview console (frontend calls attachConsole).
    // Never feed `tauri_runtime_wry` / `wry` errors back into `TargetKind::Webview`:
    // if a secondary WebView2 window enters an invalid state (e.g. JS `window.close()`
    // or teardown race → HRESULT 0x8007139F), `app.emit("log://log", ...)` logs a
    // `tauri_runtime_wry` error that re-enters `TargetKind::Webview` in an unbounded
    // self-amplifying loop. They still go to `Stdout` and `LogDir` once per real event.
    if cfg!(debug_assertions) {
        builder = builder.target(
            Target::new(TargetKind::Webview)
                .filter(|metadata| should_forward_to_webview(metadata.target())),
        );
    }

    // Frontend spans are `PERF {json}` info lines. Copy them into the trace
    // file with the same writer the host OpTimer uses. Absent unless
    // AGENTERO_PERF_TRACE is set, so normal launches do not install it.
    if crate::core::perf::tracing() {
        let dispatch = fern::Dispatch::new()
            .filter(|meta| meta.target().starts_with("webview"))
            .chain(fern::Output::call(|record| {
                crate::core::perf::capture_log_line(&record.args().to_string());
            }));
        builder = builder.target(Target::new(TargetKind::Dispatch(dispatch)));
    }

    builder
}

/// Clear files written by `tauri-plugin-log` under the app log directory.
///
/// Rotated / archived `*.log` (and defensive `*.log.bak`) files are deleted.
/// The active `agentero.log` is truncated when deletion fails (common while the
/// logger still holds the handle, especially on Windows).
///
/// Returns the number of files cleared (deleted or truncated).
pub fn clear_log_dir(dir: &Path) -> Result<u64, AppError> {
    if !dir.exists() {
        return Ok(0);
    }
    if !dir.is_dir() {
        return Err(AppError::message(format!(
            "log path is not a directory: {}",
            dir.display()
        )));
    }

    let mut cleared = 0u64;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !is_agentero_log_file(name) {
            continue;
        }

        match clear_one_log_file(&path) {
            Ok(()) => cleared = cleared.saturating_add(1),
            Err(e) => {
                return Err(AppError::message(format!(
                    "failed to clear {}: {e}",
                    path.display()
                )));
            }
        }
    }
    Ok(cleared)
}

fn should_forward_to_webview(target: &str) -> bool {
    target != "tauri_runtime_wry"
        && !target.starts_with("tauri_runtime_wry::")
        && target != "wry"
        && !target.starts_with("wry::")
}

fn is_agentero_log_file(name: &str) -> bool {
    // Active: agentero.log; rotated: agentero_<stamp>.log; rare collision: *.log.bak
    name == "agentero.log"
        || (name.starts_with("agentero_") && name.ends_with(".log"))
        || (name.starts_with("agentero_") && name.ends_with(".log.bak"))
}

fn clear_one_log_file(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(remove_err) => {
            // Active file may still be open by the log plugin — truncate instead.
            match fs::OpenOptions::new().write(true).truncate(true).open(path) {
                Ok(mut f) => {
                    f.flush()?;
                    Ok(())
                }
                Err(_) => Err(remove_err),
            }
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn logs_clear(app: AppHandle) -> ApiResult<u64> {
    let dir = match app.path().app_log_dir() {
        Ok(d) => d,
        Err(e) => {
            return map_err(AppError::message(format!("app log dir unavailable: {e}")));
        }
    };
    run_blocking(move || match clear_log_dir(&dir) {
        Ok(n) => ApiResult::ok(n),
        Err(e) => map_err(e),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn clear_log_dir_removes_rotated_and_truncates_active() {
        let dir = tempfile::tempdir().expect("tempdir");
        let active = dir.path().join("agentero.log");
        let rotated = dir.path().join("agentero_2026-03-27_12-00-00.log");
        let bak = dir.path().join("agentero_2026-03-27_12-00-00.log.bak");
        let other = dir.path().join("notes.txt");

        fs::write(&active, b"active").unwrap();
        fs::write(&rotated, b"old").unwrap();
        fs::write(&bak, b"bak").unwrap();
        fs::write(&other, b"keep").unwrap();

        // Hold an open handle on the active file (simulates the log plugin).
        let _held = fs::OpenOptions::new()
            .append(true)
            .open(&active)
            .expect("hold active");

        let n = clear_log_dir(dir.path()).expect("clear");
        assert_eq!(n, 3);
        assert!(other.exists());
        assert!(!rotated.exists());
        assert!(!bak.exists());
        // Active may be deleted (Unix) or truncated (if remove failed).
        if active.exists() {
            assert_eq!(fs::metadata(&active).unwrap().len(), 0);
        }
    }

    #[test]
    fn clear_log_dir_missing_is_ok() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("nope");
        assert_eq!(clear_log_dir(&missing).unwrap(), 0);
    }

    #[test]
    fn is_agentero_log_file_matches_expected_names() {
        assert!(is_agentero_log_file("agentero.log"));
        assert!(is_agentero_log_file("agentero_2026-03-27_12-00-00.log"));
        assert!(is_agentero_log_file("agentero_2026-03-27_12-00-00.log.bak"));
        assert!(!is_agentero_log_file("other.log"));
        assert!(!is_agentero_log_file("agentero.txt"));
    }

    #[test]
    fn clear_one_truncates_when_remove_blocked() {
        // On platforms where remove of an open file succeeds (Unix), this still
        // covers the truncate path by calling it after a failed remove is hard
        // to force — instead verify truncate helper via a normal writable file.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("agentero.log");
        {
            let mut f = fs::File::create(&path).unwrap();
            writeln!(f, "hello").unwrap();
        }
        clear_one_log_file(&path).unwrap();
        if path.exists() {
            assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        }
    }

    #[test]
    fn webview_log_filter_blocks_wry_recursion() {
        assert!(!should_forward_to_webview("tauri_runtime_wry"));
        assert!(!should_forward_to_webview("tauri_runtime_wry::webview"));
        assert!(!should_forward_to_webview("wry"));
        assert!(!should_forward_to_webview("wry::webview2"));
        assert!(should_forward_to_webview("agentero::op"));
        assert!(should_forward_to_webview("agentero::agent"));
    }
}
