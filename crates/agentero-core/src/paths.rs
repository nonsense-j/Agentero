//! Application data directories following the [XDG Base Directory
//! Specification](https://specifications.freedesktop.org/basedir-spec/latest/).
//!
//! | Kind | Env | Default (Unix) | Contents |
//! |------|-----|----------------|----------|
//! | config | `$XDG_CONFIG_HOME` | `~/.config` | `dovero/settings.json`, `agents.json` |
//! | cache | `$XDG_CACHE_HOME` | `~/.cache` | PDF blobs |
//! | data | `$XDG_DATA_HOME` | `~/.local/share` | `usage.sqlite` (device-local activity), `feeds.sqlite`, `collection.sqlite` |
//! | state | `$XDG_STATE_HOME` | `~/.local/state` | reserved |
//!
//! On Windows and iOS, when XDG env vars are unset, falls back to the platform
//! dirs crate (Windows: `config` → `%APPDATA%`, `cache` → `%LOCALAPPDATA%`;
//! iOS: `Library/Application Support` / `Library/Caches` — the container root
//! itself is not writable, so `~/.config` would fail with EPERM).

use std::path::{Path, PathBuf};

/// Current application directory leaf name under XDG / OS app-data roots.
pub const APP_DIR_NAME: &str = "dovero";
/// Legacy pre-rebrand directory leaf name migrated non-destructively on first run.
pub const LEGACY_APP_DIR_NAME: &str = "agentero";

/// Resolve XDG config home (`$XDG_CONFIG_HOME` or platform default).
pub fn xdg_config_home() -> PathBuf {
    if let Some(p) = env_dir("XDG_CONFIG_HOME") {
        return p;
    }
    #[cfg(any(windows, target_os = "ios"))]
    {
        dirs::config_dir().unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(any(windows, target_os = "ios")))]
    {
        home_dir().join(".config")
    }
}

/// Resolve XDG cache home (`$XDG_CACHE_HOME` or platform default).
pub fn xdg_cache_home() -> PathBuf {
    if let Some(p) = env_dir("XDG_CACHE_HOME") {
        return p;
    }
    #[cfg(any(windows, target_os = "ios"))]
    {
        dirs::cache_dir().unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(any(windows, target_os = "ios")))]
    {
        home_dir().join(".cache")
    }
}

/// `$XDG_CONFIG_HOME/dovero` (created on demand by callers).
pub fn agentero_config_dir() -> PathBuf {
    xdg_config_home().join(APP_DIR_NAME)
}

/// Resolve XDG data home (`$XDG_DATA_HOME` or platform default).
pub fn xdg_data_home() -> PathBuf {
    if let Some(p) = env_dir("XDG_DATA_HOME") {
        return p;
    }
    #[cfg(any(windows, target_os = "ios"))]
    {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(any(windows, target_os = "ios")))]
    {
        home_dir().join(".local").join("share")
    }
}

/// `$XDG_CACHE_HOME/dovero` (created on demand by callers).
pub fn agentero_cache_dir() -> PathBuf {
    xdg_cache_home().join(APP_DIR_NAME)
}

/// `$XDG_DATA_HOME/dovero` (created on demand by callers).
pub fn agentero_data_dir() -> PathBuf {
    xdg_data_home().join(APP_DIR_NAME)
}

/// Device-local activity log: `…/dovero/usage.sqlite`.
pub fn usage_db_path() -> PathBuf {
    agentero_data_dir().join("usage.sqlite")
}

/// Plaza feed subscriptions + item cache: `…/dovero/feeds.sqlite`.
pub fn feeds_db_path() -> PathBuf {
    agentero_data_dir().join("feeds.sqlite")
}

/// Plaza Paper Collection store: `…/dovero/collection.sqlite`.
pub fn collection_db_path() -> PathBuf {
    agentero_data_dir().join("collection.sqlite")
}

/// Resumable `.part` download cache for Collection seed shards:
/// `…/dovero/collection-seed`.
pub fn collection_seed_cache_dir() -> PathBuf {
    agentero_cache_dir().join("collection-seed")
}

/// App settings file: `…/dovero/settings.json`.
pub fn settings_path() -> PathBuf {
    agentero_config_dir().join("settings.json")
}

/// Agent registry file: `…/dovero/agents.json`.
pub fn agents_path() -> PathBuf {
    agentero_config_dir().join("agents.json")
}

/// Private working directory for a spawned ACP agent when no Vault is known
/// (initialize probe, warm before a Vault opens, history listing).
///
/// Never fall back to the process working directory: a macOS GUI app launched
/// by LaunchServices has `/` as its cwd, so an agent that inspects its process
/// cwd treats the whole filesystem as its workspace and enumerates `$HOME`.
/// That trips macOS TCC prompts for Music / Desktop / Downloads / iCloud Drive
/// / other apps' data (#570).
///
/// Created on demand; if the data dir is not writable, try a Dovero-only
/// subdirectory of the OS temp dir. If both locations fail, return an error
/// rather than use the process cwd or the whole temp directory.
pub fn agent_scratch_dir() -> std::io::Result<PathBuf> {
    agent_scratch_dir_in(&agentero_data_dir(), &std::env::temp_dir())
}

fn agent_scratch_dir_in(data_dir: &Path, temp_dir: &Path) -> std::io::Result<PathBuf> {
    let dir = data_dir.join("agent-cwd");
    match std::fs::create_dir_all(&dir) {
        Ok(()) => Ok(dir),
        Err(primary_error) => {
            let fallback = temp_dir.join(APP_DIR_NAME).join("agent-cwd");
            std::fs::create_dir_all(&fallback).map_err(|fallback_error| {
                std::io::Error::new(
                    fallback_error.kind(),
                    format!(
                        "cannot create agent scratch directory at {} ({primary_error}) or {} ({fallback_error})",
                        dir.display(),
                        fallback.display(),
                    ),
                )
            })?;
            Ok(fallback)
        }
    }
}

/// Legacy config directories checked in priority order for one-time migration:
/// 1. `$XDG_CONFIG_HOME/agentero` (pre-rebrand Dovero/Agentero path)
/// 2. `dirs::config_dir()/agentero` (pre-XDG macOS `~/Library/Application Support/agentero`)
pub fn legacy_config_dirs() -> Vec<PathBuf> {
    let mut dirs_out = vec![xdg_config_home().join(LEGACY_APP_DIR_NAME)];
    if let Some(platform) = dirs::config_dir().map(|p| p.join(LEGACY_APP_DIR_NAME)) {
        if !dirs_out.iter().any(|d| d == &platform) {
            dirs_out.push(platform);
        }
    }
    dirs_out
}

/// Legacy data directories checked in priority order for one-time migration.
pub fn legacy_data_dirs() -> Vec<PathBuf> {
    let mut dirs_out = vec![xdg_data_home().join(LEGACY_APP_DIR_NAME)];
    if let Some(platform) = dirs::data_dir().map(|p| p.join(LEGACY_APP_DIR_NAME)) {
        if !dirs_out.iter().any(|d| d == &platform) {
            dirs_out.push(platform);
        }
    }
    dirs_out
}

/// Pre-rebrand / pre-XDG config path (`…/agentero`).
pub fn legacy_config_dir() -> Option<PathBuf> {
    legacy_config_dirs()
        .into_iter()
        .find(|d| d.is_dir())
        .or_else(|| dirs::config_dir().map(|p| p.join(LEGACY_APP_DIR_NAME)))
}

fn migrate_legacy_file_from_dirs(file_name: &str, target: &Path, legacy_dirs: &[PathBuf]) {
    if target.exists() {
        return;
    }
    for legacy_dir in legacy_dirs {
        if target.parent() == Some(legacy_dir.as_path()) {
            continue;
        }
        let src = legacy_dir.join(file_name);
        if !src.is_file() {
            continue;
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::copy(&src, target) {
            Ok(_) => {
                log::info!(
                    target: "agentero::paths",
                    "migrated {file_name} from {} → {}",
                    src.display(),
                    target.display()
                );
                return;
            }
            Err(e) => {
                log::warn!(
                    target: "agentero::paths",
                    "failed to migrate {file_name} from {}: {e}",
                    src.display()
                );
            }
        }
    }
}

/// If `target` is missing but a legacy config file exists, copy it once (best-effort).
pub fn migrate_legacy_file(file_name: &str, target: &Path) {
    migrate_legacy_file_from_dirs(file_name, target, &legacy_config_dirs());
}

fn migrate_legacy_sqlite_from_dirs(file_name: &str, target: &Path, legacy_dirs: &[PathBuf]) {
    if target.exists() {
        return;
    }
    for legacy_dir in legacy_dirs {
        if target.parent() == Some(legacy_dir.as_path()) {
            continue;
        }
        let src = legacy_dir.join(file_name);
        if !src.is_file() {
            continue;
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::copy(&src, target) {
            Ok(_) => {
                for suffix in ["-wal", "-shm"] {
                    let side_name = format!("{file_name}{suffix}");
                    let src_side = legacy_dir.join(&side_name);
                    if src_side.is_file() {
                        if let Some(parent) = target.parent() {
                            let _ = std::fs::copy(&src_side, parent.join(&side_name));
                        }
                    }
                }
                log::info!(
                    target: "agentero::paths",
                    "migrated sqlite {file_name} from {} → {}",
                    src.display(),
                    target.display()
                );
                return;
            }
            Err(e) => {
                log::warn!(
                    target: "agentero::paths",
                    "failed to migrate sqlite {file_name} from {}: {e}",
                    src.display()
                );
            }
        }
    }
}

/// If a SQLite store at `target` is missing but exists under a legacy `agentero/`
/// data directory, copy it (plus `-wal` / `-shm` companions) non-destructively.
pub fn migrate_legacy_sqlite(file_name: &str, target: &Path) {
    migrate_legacy_sqlite_from_dirs(file_name, target, &legacy_data_dirs());
}

/// Non-destructive one-time startup migration from legacy `agentero/` config &
/// data directories into `dovero/`. Never overwrites existing Dovero files.
pub fn migrate_legacy_app_dirs() {
    let config_dir = agentero_config_dir();
    for file_name in [
        "settings.json",
        "agents.json",
        "config.toml",
        "finder-service.removed",
    ] {
        migrate_legacy_file(file_name, &config_dir.join(file_name));
    }
    migrate_legacy_sqlite("collection.sqlite", &collection_db_path());
    migrate_legacy_sqlite("feeds.sqlite", &feeds_db_path());
    migrate_legacy_sqlite("usage.sqlite", &usage_db_path());
}

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Fallback home directory for XDG defaults. Only used where the `~/.config`
/// convention applies (not Windows/iOS), hence the cfg gate to avoid a
/// dead-code warning on those builds.
#[cfg(not(any(windows, target_os = "ios")))]
fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_ends_with_dovero() {
        let p = agentero_config_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some(APP_DIR_NAME));
    }

    #[test]
    fn settings_and_agents_share_config_dir() {
        let settings = settings_path();
        let agents = agents_path();
        assert_eq!(settings.parent(), agents.parent());
    }

    #[test]
    fn cache_dir_ends_with_dovero() {
        let p = agentero_cache_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some(APP_DIR_NAME));
    }

    #[test]
    fn data_dir_ends_with_dovero() {
        let p = agentero_data_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some(APP_DIR_NAME));
    }

    #[test]
    fn agent_scratch_dir_prefers_and_reuses_the_data_directory() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("data");
        let temp_dir = root.path().join("temp");
        let expected = data_dir.join("agent-cwd");

        for _ in 0..2 {
            let cwd = agent_scratch_dir_in(&data_dir, &temp_dir).unwrap();
            assert_eq!(cwd, expected);
            assert!(cwd.is_dir());
        }
        assert!(!temp_dir.exists());
    }

    #[test]
    fn agent_scratch_fallback_stays_in_a_dedicated_subdirectory() {
        let root = tempfile::tempdir().unwrap();
        let blocked_data_dir = root.path().join("data-file");
        std::fs::write(&blocked_data_dir, b"not a directory").unwrap();
        let temp_dir = root.path().join("temp");
        std::fs::create_dir(&temp_dir).unwrap();

        let cwd = agent_scratch_dir_in(&blocked_data_dir, &temp_dir).unwrap();
        assert_eq!(cwd, temp_dir.join(APP_DIR_NAME).join("agent-cwd"));
        assert!(cwd.is_dir());
    }

    #[test]
    fn agent_scratch_dir_errors_when_both_locations_are_unavailable() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("data-file");
        let temp_dir = root.path().join("temp-file");
        std::fs::write(&data_dir, b"not a directory").unwrap();
        std::fs::write(&temp_dir, b"not a directory").unwrap();

        let error = agent_scratch_dir_in(&data_dir, &temp_dir).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("cannot create agent scratch directory"));
        assert!(message.contains(&data_dir.join("agent-cwd").display().to_string()));
        assert!(message.contains(
            &temp_dir
                .join(APP_DIR_NAME)
                .join("agent-cwd")
                .display()
                .to_string()
        ));
    }

    #[test]
    fn usage_db_under_data_dir() {
        let p = usage_db_path();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("usage.sqlite"));
        assert_eq!(p.parent(), Some(agentero_data_dir().as_path()));
    }

    #[test]
    fn feeds_db_under_data_dir() {
        let p = feeds_db_path();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("feeds.sqlite"));
        assert_eq!(p.parent(), Some(agentero_data_dir().as_path()));
    }

    #[test]
    fn collection_db_under_data_dir() {
        let p = collection_db_path();
        assert_eq!(
            p.file_name().and_then(|s| s.to_str()),
            Some("collection.sqlite")
        );
        assert_eq!(p.parent(), Some(agentero_data_dir().as_path()));
    }

    #[test]
    fn migrate_legacy_file_copies_once_and_preserves_existing_target() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("agentero");
        let target_dir = root.path().join("dovero");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("settings.json"), r#"{"theme":"light"}"#).unwrap();

        let target = target_dir.join("settings.json");
        migrate_legacy_file_from_dirs("settings.json", &target, std::slice::from_ref(&legacy));
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            r#"{"theme":"light"}"#
        );

        // Must never overwrite an already-present Dovero file.
        std::fs::write(&target, r#"{"theme":"dark"}"#).unwrap();
        migrate_legacy_file_from_dirs("settings.json", &target, std::slice::from_ref(&legacy));
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            r#"{"theme":"dark"}"#
        );
    }

    #[test]
    fn migrate_legacy_sqlite_copies_db_and_wal_companions() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("agentero");
        let target_dir = root.path().join("dovero");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("collection.sqlite"), b"db-bytes").unwrap();
        std::fs::write(legacy.join("collection.sqlite-wal"), b"wal-bytes").unwrap();
        std::fs::write(legacy.join("collection.sqlite-shm"), b"shm-bytes").unwrap();

        let target = target_dir.join("collection.sqlite");
        migrate_legacy_sqlite_from_dirs("collection.sqlite", &target, &[legacy]);
        assert_eq!(std::fs::read(&target).unwrap(), b"db-bytes");
        assert_eq!(
            std::fs::read(target_dir.join("collection.sqlite-wal")).unwrap(),
            b"wal-bytes"
        );
        assert_eq!(
            std::fs::read(target_dir.join("collection.sqlite-shm")).unwrap(),
            b"shm-bytes"
        );
    }
}
