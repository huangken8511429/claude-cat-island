mod claude;
mod approval;

use approval::{ApprovalDecision, ApprovalServer, PendingApproval};
use claude::{ClaudeSession, HookEvent, LatestNotification, LiveStats, PermissionConfig, SessionActivityInfo, SessionPendingState, SkillInfo, TokenStats, TranscriptMessage};
use tauri::PhysicalPosition;
use std::sync::Arc;

#[tauri::command]
fn get_sessions() -> Result<Vec<ClaudeSession>, String> {
    claude::read_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_token_stats() -> Result<TokenStats, String> {
    claude::read_token_stats().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_live_stats() -> Result<LiveStats, String> {
    claude::read_live_stats().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_recent_events(limit: usize) -> Result<Vec<HookEvent>, String> {
    claude::read_recent_events(limit).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_latest_notification() -> Result<LatestNotification, String> {
    claude::read_latest_notification().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_session_transcript(session_id: String, cwd: String) -> Result<Vec<TranscriptMessage>, String> {
    claude::read_session_transcript(&session_id, &cwd).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_session_last_message(session_id: String, cwd: String) -> Result<Option<TranscriptMessage>, String> {
    claude::read_session_last_message(&session_id, &cwd).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_session_activity(session_id: String, cwd: String) -> Result<SessionActivityInfo, String> {
    claude::read_session_activity(&session_id, &cwd).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_skills() -> Result<Vec<SkillInfo>, String> {
    claude::read_skills().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_permissions() -> Result<PermissionConfig, String> {
    claude::read_permissions().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_skip_dangerous(enabled: bool) -> Result<(), String> {
    claude::set_permission_skip_dangerous(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_auto_approve(enabled: bool) -> Result<(), String> {
    claude::set_auto_approve(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_session_pending_states() -> Result<Vec<SessionPendingState>, String> {
    claude::read_session_pending_states().map_err(|e| e.to_string())
}

#[tauri::command]
fn jump_to_session(pid: u32) -> Result<(), String> {
    claude::jump_to_session(pid).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_and_jump(pid: u32, text: String) -> Result<String, String> {
    claude::copy_and_jump(pid, text).map_err(|e| e.to_string())
}

// ── Cursor position (for click-through detection) ──

#[tauri::command]
fn get_cursor_position(window: tauri::WebviewWindow) -> Result<(f64, f64), String> {
    // Get window position
    let win_pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;

    // Get global cursor position via CGEvent
    #[cfg(target_os = "macos")]
    {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "Failed to create event source".to_string())?;
        let event = CGEvent::new(source)
            .map_err(|_| "Failed to create event".to_string())?;
        let loc = event.location();

        // Convert to window-local coordinates (in logical pixels)
        // loc is in points (logical), win_pos is in physical pixels
        let x = loc.x - win_pos.x as f64 / scale;
        let y = loc.y - win_pos.y as f64 / scale;
        return Ok((x, y));
    }

    #[cfg(not(target_os = "macos"))]
    Err("Not supported on this platform".to_string())
}

// ── Approval commands ──

#[tauri::command]
fn get_pending_approvals(state: tauri::State<'_, Arc<ApprovalServer>>) -> Result<Vec<PendingApproval>, String> {
    Ok(state.get_pending())
}

#[tauri::command]
fn resolve_approval(
    state: tauri::State<'_, Arc<ApprovalServer>>,
    id: String,
    behavior: String,
    message: Option<String>,
) -> Result<(), String> {
    state.resolve(&id, ApprovalDecision { behavior, message })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Start approval HTTP server
    let approval_server = Arc::new(ApprovalServer::new());
    approval_server.start();

    let server_for_tauri = approval_server.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(server_for_tauri)
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            get_session_transcript,
            get_session_last_message,
            get_session_activity,
            get_token_stats,
            get_live_stats,
            get_recent_events,
            get_latest_notification,
            get_skills,
            get_permissions,
            set_skip_dangerous,
            set_auto_approve,
            get_session_pending_states,
            jump_to_session,
            copy_and_jump,
            get_cursor_position,
            get_pending_approvals,
            resolve_approval,
        ])
        .setup(|app| {
            use tauri::Manager;
            use tauri::tray::TrayIconBuilder;

            // ── System Tray (pixel cat icon) ──
            let tray_icon = {
                let png_data = include_bytes!("../icons/tray@2x.png");
                let decoder = png::Decoder::new(std::io::Cursor::new(png_data));
                let mut reader = decoder.read_info().expect("Failed to decode tray icon");
                let mut buf = vec![0u8; reader.output_buffer_size()];
                let info = reader.next_frame(&mut buf).expect("Failed to read tray icon frame");
                buf.truncate(info.buffer_size());
                tauri::image::Image::new_owned(buf, info.width, info.height)
            };

            let menu = tauri::menu::MenuBuilder::new(app)
                .text("reload", "Reload")
                .separator()
                .text("quit", "Quit")
                .build()?;

            TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("Claude Cat Monitor")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "reload" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.eval("location.reload()");
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // ── Position window slightly left of center (clear the notch) ──
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let screen = monitor.size();
                    let scale = monitor.scale_factor();
                    let win_w = 240.0 * scale;
                    let x = ((screen.width as f64 - win_w) / 2.0 - 20.0 * scale) as i32;
                    let _ = window.set_position(tauri::Position::Physical(
                        PhysicalPosition::new(x, 0),
                    ));
                }

                // Set window level above menu bar
                #[cfg(target_os = "macos")]
                {
                    use cocoa::appkit::NSWindow;
                    let ns_win: cocoa::base::id = window.ns_window().unwrap() as cocoa::base::id;
                    unsafe {
                        ns_win.setLevel_(25); // NSStatusWindowLevel
                    }
                }
            }

            // ── Hide from Dock ──
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // ── Install hook if needed ──
            if let Err(e) = claude::install_approval_hook() {
                eprintln!("[approval] Failed to install hook: {}", e);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
