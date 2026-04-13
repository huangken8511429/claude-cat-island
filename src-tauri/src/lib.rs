mod claude;
mod approval;
mod socket;

use approval::{ApprovalDecision, ApprovalServer, PendingApproval};
use claude::{ClaudeSession, HookEvent, LatestNotification, LiveStats, PendingQuestion, PermissionConfig, Prerequisites, SessionActivityInfo, SessionPendingState, SkillDetail, SkillInfo, TokenStats, TranscriptMessage};
use tauri::PhysicalPosition;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};

#[tauri::command]
fn check_prerequisites() -> Prerequisites {
    claude::check_prerequisites()
}

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
fn get_skill_detail(name: String) -> Result<SkillDetail, String> {
    claude::read_skill_detail(&name).map_err(|e| e.to_string())
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

#[tauri::command]
fn get_pending_questions() -> Result<Vec<PendingQuestion>, String> {
    match claude::read_pending_questions() {
        Ok(qs) => {
            if !qs.is_empty() {
                eprintln!("[questions] found {} pending question(s)", qs.len());
                for q in &qs {
                    eprintln!("[questions]   session={} q={} opts={}", q.session_id.chars().take(12).collect::<String>(), q.question.chars().take(30).collect::<String>(), q.options.len());
                }
            }
            Ok(qs)
        }
        Err(e) => {
            eprintln!("[questions] ERROR: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
fn answer_question(pid: u32, answer: String) -> Result<String, String> {
    claude::copy_and_jump(pid, answer).map_err(|e| e.to_string())
}

#[tauri::command]
fn select_multi_option(pid: u32, selected_indices: Vec<u32>, total_options: u32) -> Result<String, String> {
    eprintln!("[select_multi] pid={} indices={:?} total={}", pid, selected_indices, total_options);
    claude::select_multi_option(pid, &selected_indices, total_options).map_err(|e| {
        eprintln!("[select_multi] ERROR: {}", e);
        e.to_string()
    })
}

#[tauri::command]
fn select_question_option(pid: u32, down_presses: u32) -> Result<String, String> {
    eprintln!("[select] select_question_option called: pid={} down_presses={}", pid, down_presses);
    let result = claude::select_option(pid, down_presses).map_err(|e| {
        eprintln!("[select] ERROR: {}", e);
        e.to_string()
    });
    eprintln!("[select] result: {:?}", result);
    result
}

// ── Notch detection ──

#[derive(serde::Serialize, Clone)]
struct NotchInfo {
    has_notch: bool,
    notch_width: f64,
    notch_height: f64,
    pill_width: f64,
}

#[cfg(target_os = "macos")]
fn detect_notch() -> NotchInfo {
    use objc::{msg_send, sel, sel_impl, class};
    use cocoa::foundation::NSRect;

    unsafe {
        let screens: cocoa::base::id = msg_send![class!(NSScreen), screens];
        let main_screen: cocoa::base::id = msg_send![screens, objectAtIndex: 0usize];

        // safeAreaInsets maps to NSEdgeInsets { top, left, bottom, right }
        // via NSRect fields: origin.x=top, origin.y=left, size.width=bottom, size.height=right
        let insets: cocoa::foundation::NSRect = msg_send![main_screen, safeAreaInsets];
        let top_inset = insets.origin.x;

        if top_inset > 0.0 {
            let frame: NSRect = msg_send![main_screen, frame];
            let aux_left: NSRect = msg_send![main_screen, auxiliaryTopLeftArea];
            let aux_right: NSRect = msg_send![main_screen, auxiliaryTopRightArea];

            // notch = the gap between the two auxiliary top areas
            let notch_width = frame.size.width - aux_left.size.width - aux_right.size.width;
            let notch_height = top_inset;
            let pill_width = (notch_width + 120.0).max(350.0);

            NotchInfo {
                has_notch: true,
                notch_width,
                notch_height,
                pill_width,
            }
        } else {
            NotchInfo {
                has_notch: false,
                notch_width: 0.0,
                notch_height: 0.0,
                pill_width: 240.0,
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn detect_notch() -> NotchInfo {
    NotchInfo { has_notch: false, notch_width: 0.0, notch_height: 0.0, pill_width: 240.0 }
}

#[tauri::command]
fn get_notch_info() -> NotchInfo {
    detect_notch()
}

// ── Click-through state for fixed-window mode ──

struct ClickThroughState {
    /// Island bounds (x, y, w, h) in logical pixels relative to window
    bounds: Mutex<(f64, f64, f64, f64)>,
    cursor_inside: AtomicBool,
}

#[tauri::command]
fn update_island_bounds(
    state: tauri::State<'_, Arc<ClickThroughState>>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) {
    *state.bounds.lock().unwrap() = (x, y, w, h);
}

#[tauri::command]
fn center_window(window: tauri::WebviewWindow) -> Result<(), String> {
    let notch = detect_notch();
    if let Ok(Some(monitor)) = window.current_monitor() {
        let screen = monitor.size();
        let scale = monitor.scale_factor();
        let logical_w = if notch.has_notch { notch.pill_width } else { 350.0 };
        let logical_h = 500.0;
        let phys_w = (logical_w * scale) as u32;
        let phys_h = (logical_h * scale) as u32;
        let x = ((screen.width as f64 - phys_w as f64) / 2.0) as i32;
        let _ = window.set_size(tauri::Size::Physical(
            tauri::PhysicalSize::new(phys_w, phys_h),
        ));
        window.set_position(tauri::Position::Physical(PhysicalPosition::new(x, 0)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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

    let ct_state = Arc::new(ClickThroughState {
        bounds: Mutex::new((55.0, 0.0, 240.0, 36.0)),
        cursor_inside: AtomicBool::new(false),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(approval_server.clone())
        .manage(ct_state.clone())
        .invoke_handler(tauri::generate_handler![
            check_prerequisites,
            get_sessions,
            get_session_transcript,
            get_session_last_message,
            get_session_activity,
            get_token_stats,
            get_live_stats,
            get_recent_events,
            get_latest_notification,
            get_skills,
            get_skill_detail,
            get_permissions,
            set_skip_dangerous,
            set_auto_approve,
            get_session_pending_states,
            jump_to_session,
            copy_and_jump,
            get_pending_approvals,
            resolve_approval,
            get_pending_questions,
            answer_question,
            select_question_option,
            select_multi_option,
            get_notch_info,
            update_island_bounds,
            center_window,
        ])
        .setup(move |app| {
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

            // ── macOS adjustments first (these can shift the window) ──
            let notch = detect_notch();

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    use cocoa::appkit::NSWindow;
                    let ns_win: cocoa::base::id = window.ns_window().unwrap() as cocoa::base::id;
                    unsafe {
                        ns_win.setLevel_(25);
                    }
                }
            }

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // ── Fixed-size transparent window (positioned AFTER macOS adjustments) ──
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let screen = monitor.size();
                    let scale = monitor.scale_factor();
                    let logical_w = if notch.has_notch { notch.pill_width } else { 350.0 };
                    let logical_h = 500.0;
                    let phys_w = (logical_w * scale) as u32;
                    let phys_h = (logical_h * scale) as u32;

                    let x = ((screen.width as f64 - phys_w as f64) / 2.0) as i32;
                    let _ = window.set_size(tauri::Size::Physical(
                        tauri::PhysicalSize::new(phys_w, phys_h),
                    ));
                    let _ = window.set_position(tauri::Position::Physical(
                        PhysicalPosition::new(x, 0),
                    ));
                }

                // Start fully click-through; cursor tracking thread toggles this
                let _ = window.set_ignore_cursor_events(true);

                // ── Cursor tracking thread: toggle click-through based on island bounds ──
                #[cfg(target_os = "macos")]
                {
                    let win = window.clone();
                    let cts = ct_state;
                    std::thread::spawn(move || {
                        use core_graphics::event::CGEvent;
                        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

                        loop {
                            std::thread::sleep(std::time::Duration::from_millis(20));

                            let loc = match CGEventSource::new(CGEventSourceStateID::HIDSystemState)
                                .ok()
                                .and_then(|src| CGEvent::new(src).ok())
                            {
                                Some(evt) => evt.location(),
                                None => continue,
                            };

                            let (local_x, local_y) = match (win.outer_position(), win.scale_factor()) {
                                (Ok(pos), Ok(scale)) => (
                                    loc.x - pos.x as f64 / scale,
                                    loc.y - pos.y as f64 / scale,
                                ),
                                _ => continue,
                            };

                            let (bx, by, bw, bh) = *cts.bounds.lock().unwrap();
                            let inside = local_x >= bx && local_x <= bx + bw
                                      && local_y >= by && local_y <= by + bh;

                            let was = cts.cursor_inside.load(Ordering::Relaxed);
                            if inside != was {
                                cts.cursor_inside.store(inside, Ordering::Relaxed);
                                let _ = win.set_ignore_cursor_events(!inside);
                            }
                        }
                    });
                }
            }

            // ── Start Unix socket server for hook events ──
            socket::start(app.handle().clone());

            // ── Install hooks (approval + bridge) ──
            if let Err(e) = claude::install_hooks() {
                eprintln!("[hooks] Failed to install hooks: {}", e);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
