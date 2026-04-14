use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex, Condvar};
use std::thread;
use tiny_http::{Response, Server, Header};

const PORT: u16 = 57000;

fn approval_log(msg: &str) {
    eprintln!("{}", msg);
    if let Ok(home) = std::env::var("HOME") {
        let path = format!("{}/.claude-cat-monitor/approval.log", home);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{}", msg);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookPermissionRequest {
    pub session_id: String,
    pub hook_event_name: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    #[serde(default)]
    pub permission_suggestions: Vec<serde_json::Value>,
    pub permission_mode: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub id: String,
    pub session_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    pub suggestions: Vec<serde_json::Value>,
    pub cwd: Option<String>,
    pub received_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecision {
    pub behavior: String, // "allow" | "deny"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Shared state for pending approvals
struct ApprovalState {
    pending: HashMap<String, PendingApproval>,
    decisions: HashMap<String, ApprovalDecision>,
    next_id: u64,
    insert_order: Vec<String>,
}

/// Thread-safe approval queue with condition variable for waiting
pub struct ApprovalServer {
    state: Arc<(Mutex<ApprovalState>, Condvar)>,
}

impl ApprovalServer {
    pub fn new() -> Self {
        Self {
            state: Arc::new((
                Mutex::new(ApprovalState {
                    pending: HashMap::new(),
                    decisions: HashMap::new(),
                    next_id: 1,
                    insert_order: Vec::new(),
                }),
                Condvar::new(),
            )),
        }
    }

    /// Start the HTTP server in a background thread
    pub fn start(&self) {
        let state = self.state.clone();

        // Log immediately to verify start() is called
        approval_log("[approval] start() called, spawning server thread");

        thread::spawn(move || {
            approval_log("[approval] Thread spawned, binding port...");

            let server = match Server::http(format!("127.0.0.1:{}", PORT)) {
                Ok(s) => s,
                Err(e) => {
                    approval_log(&format!("[approval] Failed to start HTTP server on port {}: {}", PORT, e));
                    return;
                }
            };
            approval_log(&format!("[approval] HTTP server listening on 127.0.0.1:{}", PORT));

            for mut request in server.incoming_requests() {
                let url = request.url().to_string();
                let method = request.method().to_string();

                // CORS headers
                let cors_origin = Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap();
                let cors_headers = Header::from_bytes("Access-Control-Allow-Headers", "Content-Type").unwrap();
                let cors_methods = Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap();
                let content_type = Header::from_bytes("Content-Type", "application/json").unwrap();

                if method == "OPTIONS" {
                    let resp = Response::empty(200)
                        .with_header(cors_origin)
                        .with_header(cors_headers)
                        .with_header(cors_methods);
                    let _ = request.respond(resp);
                    continue;
                }

                match (method.as_str(), url.as_str()) {
                    // Hook sends permission request here
                    ("POST", "/hooks/permission-request") => {
                        let mut body = String::new();
                        if request.as_reader().read_to_string(&mut body).is_err() {
                            let resp = Response::from_string(r#"{"error":"bad body"}"#)
                                .with_status_code(400)
                                .with_header(content_type.clone())
                                .with_header(cors_origin.clone());
                            let _ = request.respond(resp);
                            continue;
                        }

                        let hook_req: HookPermissionRequest = match serde_json::from_str(&body) {
                            Ok(r) => r,
                            Err(e) => {
                                let resp = Response::from_string(format!(r#"{{"error":"parse error: {}"}}"#, e))
                                    .with_status_code(400)
                                    .with_header(content_type.clone())
                                    .with_header(cors_origin.clone());
                                let _ = request.respond(resp);
                                continue;
                            }
                        };

                        // Enqueue and wait for decision
                        let (lock, cvar) = &*state;
                        let approval_id;
                        {
                            let mut s = lock.lock().unwrap();
                            let id = format!("approval-{}", s.next_id);
                            s.next_id += 1;
                            let pending = PendingApproval {
                                id: id.clone(),
                                session_id: hook_req.session_id.clone(),
                                tool_name: hook_req.tool_name.clone(),
                                tool_input: hook_req.tool_input.clone(),
                                suggestions: hook_req.permission_suggestions.clone(),
                                cwd: hook_req.cwd.clone(),
                                received_at: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap()
                                    .as_millis() as u64,
                            };
                            s.pending.insert(id.clone(), pending);
                            s.insert_order.push(id.clone());
                            approval_id = id;
                        }

                        approval_log(&format!("[approval] Queued: {} (tool: {})", approval_id, hook_req.tool_name));

                        // Block until decision is made (with 5 min timeout)
                        let decision = {
                            let (lock, cvar) = &*state;
                            let mut s = lock.lock().unwrap();
                            let timeout = std::time::Duration::from_secs(300);
                            let start = std::time::Instant::now();

                            loop {
                                if let Some(d) = s.decisions.remove(&approval_id) {
                                    break Some(d);
                                }
                                if start.elapsed() >= timeout {
                                    // Timeout: remove from pending, deny
                                    s.pending.remove(&approval_id);
                                    s.insert_order.retain(|i| i != &approval_id);
                                    break None;
                                }
                                let remaining = timeout - start.elapsed();
                                let result = cvar.wait_timeout(s, remaining).unwrap();
                                s = result.0;
                            }
                        };

                        let hook_response = match decision {
                            Some(d) => {
                                let mut resp_obj = serde_json::json!({
                                    "hookSpecificOutput": {
                                        "hookEventName": "PermissionRequest",
                                        "decision": {
                                            "behavior": d.behavior
                                        }
                                    }
                                });
                                if let Some(msg) = &d.message {
                                    resp_obj["hookSpecificOutput"]["decision"]["message"] = serde_json::json!(msg);
                                }
                                resp_obj.to_string()
                            }
                            None => {
                                serde_json::json!({
                                    "hookSpecificOutput": {
                                        "hookEventName": "PermissionRequest",
                                        "decision": {
                                            "behavior": "deny",
                                            "message": "Approval timed out"
                                        }
                                    }
                                }).to_string()
                            }
                        };

                        let resp = Response::from_string(hook_response)
                            .with_header(content_type)
                            .with_header(cors_origin);
                        let _ = request.respond(resp);
                    }

                    _ => {
                        let resp = Response::from_string(r#"{"error":"not found"}"#)
                            .with_status_code(404)
                            .with_header(content_type)
                            .with_header(cors_origin);
                        let _ = request.respond(resp);
                    }
                }
            }
        });
    }

    /// Get all pending approvals (called by Tauri command)
    pub fn get_pending(&self) -> Vec<PendingApproval> {
        let (lock, _) = &*self.state;
        let s = lock.lock().unwrap();
        s.insert_order
            .iter()
            .filter_map(|id| s.pending.get(id).cloned())
            .collect()
    }

    /// Resolve a pending approval (called by Tauri command from UI)
    pub fn resolve(&self, id: &str, decision: ApprovalDecision) -> Result<(), String> {
        let (lock, cvar) = &*self.state;
        let mut s = lock.lock().unwrap();

        if !s.pending.contains_key(id) {
            return Err(format!("Approval {} not found", id));
        }

        s.pending.remove(id);
        s.insert_order.retain(|i| i != id);
        s.decisions.insert(id.to_string(), decision);
        cvar.notify_all();
        Ok(())
    }
}
