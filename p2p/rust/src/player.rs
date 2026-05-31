//! Cross-platform player auto-detection.
//!
//! Discovers installed media players on macOS, Linux, and Windows.
//! Each player has known binary names and install paths per platform.
//! Resolution order: 1) absolute known paths, 2) PATH search, 3) registry/shell discovery.

use std::path::{Path, PathBuf};
use std::process::Command;

/// A supported media player.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Player {
    /// Display name (e.g. "mpv", "VLC media player")
    pub name: &'static str,
    /// Unique key for config/commands
    pub key: &'static str,
    /// Binary filenames tried in PATH search (e.g. ["mpv", "mpv.exe"])
    pub exe_names: &'static [&'static str],
    /// Known install paths per platform (checked first, before PATH)
    pub known_paths: &'static [&'static str],
}

/// All supported players.
pub const PLAYERS: &[Player] = &[MPV, VLC, MPC_HC, MPC_BE, MPVNET, IINA, MPLAYER, MEMENTO];

pub const MPV: Player = Player {
    name: "mpv",
    key: "mpv",
    exe_names: &["mpv", "mpv.exe"],
    known_paths: &[
        // Linux
        "/usr/bin/mpv",
        "/opt/mpv/mpv",
        // macOS
        "/Applications/mpv.app/Contents/MacOS/mpv",
        "/opt/homebrew/bin/mpv",
        "/usr/local/bin/mpv",
        // Windows
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files\mpv-player\mpv.exe",
        r"C:\Program Files (x86)\mpv\mpv.exe",
        r"C:\Program Files (x86)\mpv-player\mpv.exe",
    ],
};

pub const VLC: Player = Player {
    name: "VLC media player",
    key: "vlc",
    exe_names: &["vlc", "vlc.exe"],
    known_paths: &[
        // Linux
        "/usr/bin/vlc",
        "/usr/bin/cvlc",
        "/snap/bin/vlc",
        // macOS
        "/Applications/VLC.app/Contents/MacOS/VLC",
        // Windows
        r"C:\Program Files\VideoLAN\VLC\vlc.exe",
        r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
        r"C:\Program Files\VLC\vlc.exe",
    ],
};

pub const MPC_HC: Player = Player {
    name: "MPC-HC",
    key: "mpc-hc",
    exe_names: &["mpc-hc64.exe", "mpc-hc.exe"],
    known_paths: &[
        r"C:\Program Files\MPC-HC\mpc-hc64.exe",
        r"C:\Program Files\MPC-HC\mpc-hc.exe",
        r"C:\Program Files (x86)\MPC-HC\mpc-hc64.exe",
        r"C:\Program Files (x86)\MPC-HC\mpc-hc.exe",
    ],
};

pub const MPC_BE: Player = Player {
    name: "MPC-BE",
    key: "mpc-be",
    exe_names: &["mpc-be64.exe", "mpc-be.exe"],
    known_paths: &[
        r"C:\Program Files\MPC-BE x64\mpc-be64.exe",
        r"C:\Program Files\MPC-BE\mpc-be.exe",
        r"C:\Program Files (x86)\MPC-BE\mpc-be.exe",
    ],
};

pub const MPVNET: Player = Player {
    name: "mpv.net",
    key: "mpvnet",
    exe_names: &["mpvnet.com", "mpvnet.exe"],
    known_paths: &[
        r"C:\Program Files\mpv.net\mpvnet.com",
        r"C:\Program Files (x86)\mpv.net\mpvnet.com",
    ],
};

pub const IINA: Player = Player {
    name: "IINA",
    key: "iina",
    exe_names: &["iina", "IINA"],
    known_paths: &[
        "/Applications/IINA.app/Contents/MacOS/IINA",
        "/Applications/IINA.app/Contents/MacOS/iina-cli",
        "/opt/homebrew/bin/iina-cli",
    ],
};

pub const MPLAYER: Player = Player {
    name: "MPlayer",
    key: "mplayer",
    exe_names: &["mplayer", "mplayer2"],
    known_paths: &[
        "/usr/bin/mplayer",
        "/usr/bin/mplayer2",
        "/usr/local/bin/mplayer",
        r"C:\Program Files\SMPlayer\mplayer\mplayer.exe",
    ],
};

pub const MEMENTO: Player = Player {
    name: "Memento",
    key: "memento",
    exe_names: &["memento", "memento.exe"],
    known_paths: &[
        "/usr/bin/memento",
        "/usr/local/bin/memento",
        r"C:\Program Files\Memento\memento.exe",
    ],
};

// ── Detection ─────────────────────────────────────────────────────────

/// Information about a discovered player installation.
#[derive(Debug, Clone)]
pub struct DiscoveredPlayer {
    pub player: &'static Player,
    pub path: PathBuf,
    /// Whether this was found via a known path (true) or PATH search (false)
    pub via_known_path: bool,
}

/// Run a quick version check. Returns (stdout, stderr) or None if the binary
/// didn't run.
fn try_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{stdout}{stderr}");
        if !combined.trim().is_empty() {
            return Some(combined.trim().to_string());
        }
    }
    None
}

/// Check whether a path points to an executable file.
fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = path.metadata() {
            return meta.permissions().mode() & 0o111 != 0;
        }
    }
    // Windows: just being a .exe/com file is enough
    true
}

/// Expand environment variables and ~/ in a path.
fn expand_path(raw: &str) -> PathBuf {
    let expanded = if raw.starts_with("~/") {
        if let Some(home) = dirs_home() {
            raw.replacen("~", &home.to_string_lossy(), 1)
        } else {
            raw.to_string()
        }
    } else {
        raw.to_string()
    };

    // Expand %VAR% on Windows, $VAR everywhere
    let expanded = shellexpand::env(&expanded).unwrap_or_else(|_| expanded.clone().into());
    PathBuf::from(expanded.as_ref())
}

/// Get the user's home directory (cross-platform).
fn dirs_home() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .or_else(|_| {
                std::env::var("HOMEDRIVE")
                    .and_then(|hd| std::env::var("HOMEPATH").map(|hp| format!("{hd}{hp}")))
            })
            .ok()
            .map(PathBuf::from)
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

/// Search PATH for a binary name.
fn find_in_path(exe_name: &str) -> Option<PathBuf> {
    if let Ok(path_var) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(sep) {
            let candidate = Path::new(dir).join(exe_name);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Resolve a player's binary: try known paths first, then PATH.
fn resolve_player(player: &'static Player) -> Option<DiscoveredPlayer> {
    // 1) Try known paths
    for raw in player.known_paths {
        let path = expand_path(raw);
        if is_executable(&path) {
            log::debug!("Found {} at {} (known path)", player.name, path.display());
            return Some(DiscoveredPlayer {
                player,
                path,
                via_known_path: true,
            });
        }
    }

    // 2) Try PATH
    for exe_name in player.exe_names {
        if let Some(path) = find_in_path(exe_name) {
            log::debug!("Found {} at {} (PATH)", player.name, path.display());
            return Some(DiscoveredPlayer {
                player,
                path,
                via_known_path: false,
            });
        }
    }

    // 3) Windows-specific: try %LOCALAPPDATA%
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            for exe_name in player.exe_names {
                let candidates = &[
                    Path::new(&local)
                        .join("Microsoft")
                        .join("WindowsApps")
                        .join(exe_name),
                    Path::new(&local)
                        .join("Programs")
                        .join(player.key)
                        .join(exe_name),
                ];
                for p in candidates {
                    if is_executable(p) {
                        log::debug!("Found {} at {} (LOCALAPPDATA)", player.name, p.display());
                        return Some(DiscoveredPlayer {
                            player,
                            path: p.clone(),
                            via_known_path: false,
                        });
                    }
                }
            }
        }
    }

    None
}

/// Auto-detect all installed players. Returns a list of discovered players
/// ordered by priority (mpv first, then VLC, etc.).
pub fn detect_players() -> Vec<DiscoveredPlayer> {
    let mut found = Vec::new();

    for player in PLAYERS {
        if let Some(dp) = resolve_player(player) {
            // Verify it actually runs
            if let Some(ver) = try_version(&dp.path) {
                log::info!(
                    "Detected {}: {} ({})",
                    player.name,
                    dp.path.display(),
                    ver.lines().next().unwrap_or("")
                );
                found.push(dp);
            } else {
                log::debug!(
                    "{} found at {} but --version failed, skipping",
                    player.name,
                    dp.path.display()
                );
            }
        }
    }

    found
}

/// Convenience: detect and return only player keys.
pub fn detect_player_keys() -> Vec<String> {
    detect_players()
        .into_iter()
        .map(|d| d.player.key.to_string())
        .collect()
}

/// Get the best available player (prefer mpv, then VLC, then first found).
pub fn default_player() -> Option<DiscoveredPlayer> {
    // Prefer mpv
    if let Some(dp) = resolve_player(&MPV) {
        if try_version(&dp.path).is_some() {
            return Some(dp);
        }
    }
    // Then VLC
    if let Some(dp) = resolve_player(&VLC) {
        if try_version(&dp.path).is_some() {
            return Some(dp);
        }
    }
    // Then whatever else is found
    detect_players().into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_player_definitions_complete() {
        for player in PLAYERS {
            assert!(!player.key.is_empty(), "{} has empty key", player.name);
            assert!(
                !player.exe_names.is_empty(),
                "{} has no exe names",
                player.name
            );
        }
    }

    #[test]
    fn test_expand_path_home() {
        let expanded = expand_path("~/test");
        assert!(
            !expanded.to_string_lossy().contains('~'),
            "~ was not expanded: {expanded:?}"
        );
    }

    #[test]
    fn test_expand_path_absolute() {
        let path = if cfg!(windows) {
            r"C:\test\vlc.exe"
        } else {
            "/usr/bin/vlc"
        };
        let expanded = expand_path(path);
        assert_eq!(expanded, PathBuf::from(path));
    }

    #[test]
    fn test_detect_players_no_panic() {
        // Just ensure detection doesn't panic — may return empty on CI
        let found = detect_players();
        // On developer machines, at least one player is usually installed
        // but we don't assert that for CI friendliness
        println!("Found {} players", found.len());
        for dp in &found {
            println!("  {} -> {}", dp.player.name, dp.path.display());
        }
    }

    #[test]
    fn test_resolve_mpv() {
        // mpv is very likely installed on dev machines
        if let Some(dp) = resolve_player(&MPV) {
            println!("mpv resolved: {}", dp.path.display());
            assert!(dp.path.exists(), "resolved path doesn't exist");
        }
    }
}
