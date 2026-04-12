//! Unix domain socket server for receiving hook events from the Python bridge.
//!
//! Listens on `/tmp/claude-cat-monitor.sock` and emits Tauri events to the
//! frontend whenever a hook event arrives. This provides real-time push
//! delivery instead of relying on file polling.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::os::unix::net::UnixListener;
use std::path::Path;
use tauri::{AppHandle, Emitter};

const SOCKET_PATH: &str = "/tmp/claude-cat-monitor.sock";

/// Payload sent by the Python bridge script over the Unix socket.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SocketEvent {
    pub event: String,
    pub ts: u64,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

/// Start the Unix socket server in a background thread.
///
/// Each incoming connection is expected to deliver a single JSON payload
/// (a `SocketEvent`), after which the connection is closed. The parsed
/// event is forwarded to the Tauri frontend via `app.emit()`.
pub fn start(app: AppHandle) {
    // Remove stale socket file from a previous run
    if Path::new(SOCKET_PATH).exists() {
        let _ = std::fs::remove_file(SOCKET_PATH);
    }

    let listener = match UnixListener::bind(SOCKET_PATH) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[socket] Failed to bind {}: {}", SOCKET_PATH, e);
            return;
        }
    };

    // Make the socket world-writable so the hook script (running as the same
    // user, but potentially from a different process group) can connect.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(SOCKET_PATH, std::fs::Permissions::from_mode(0o777));
    }

    eprintln!("[socket] Listening on {}", SOCKET_PATH);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(mut conn) => {
                    let app = app.clone();
                    // Handle each connection in a short-lived thread to avoid
                    // blocking the accept loop.
                    std::thread::spawn(move || {
                        let mut buf = String::new();
                        if conn.read_to_string(&mut buf).is_err() {
                            return;
                        }
                        match serde_json::from_str::<SocketEvent>(&buf) {
                            Ok(evt) => {
                                eprintln!("[socket] Received: {} (session={})", evt.event, evt.session_id);
                                // Emit a Tauri event that the frontend can listen to
                                let _ = app.emit("hook-event", &evt);
                            }
                            Err(e) => {
                                eprintln!("[socket] Parse error: {} — payload: {}", e, &buf[..buf.len().min(200)]);
                            }
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[socket] Accept error: {}", e);
                }
            }
        }
    });
}

