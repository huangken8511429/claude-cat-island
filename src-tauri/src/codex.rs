use crate::provider::{
    ProviderKind, SessionProvider, UnifiedActivityInfo, UnifiedSession, UnifiedTranscriptMessage,
};
use std::path::PathBuf;

fn codex_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".codex")
}

/// Validate session ID to prevent SQL/shell injection.
/// Codex session IDs are UUIDs like "019db922-87fd-76a1-9b58-f456a66ac4d6".
fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Run a sqlite3 query via macOS built-in CLI to avoid adding rusqlite crate.
/// Uses WAL mode so we can read while Codex holds a write lock.
fn sqlite3_query(db_path: &std::path::Path, sql: &str) -> Result<String, Box<dyn std::error::Error>> {
    let wal_sql = format!("PRAGMA journal_mode=wal;\n{}", sql);
    let output = std::process::Command::new("sqlite3")
        .args([
            "-separator", "\t",
            db_path.to_str().unwrap_or(""),
            &wal_sql,
        ])
        .output()?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("sqlite3 failed: {}", err).into());
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn is_codex_running() -> bool {
    std::process::Command::new("pgrep")
        .args(["-f", "Codex"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn parse_response_items(content: &str) -> Vec<serde_json::Value> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let v: serde_json::Value = serde_json::from_str(line).ok()?;
            if v.get("type")?.as_str()? == "response_item" {
                Some(v)
            } else {
                None
            }
        })
        .collect()
}

fn extract_text_from_content(content: &[serde_json::Value], text_type: &str) -> String {
    content
        .iter()
        .filter_map(|c| {
            if c.get("type")?.as_str()? == text_type {
                c.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn response_item_to_message(item: &serde_json::Value) -> Option<UnifiedTranscriptMessage> {
    let payload = item.get("payload")?;
    let item_type = payload.get("type")?.as_str()?;
    let timestamp = item
        .get("timestamp")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());

    match item_type {
        "message" => {
            let role = payload.get("role")?.as_str()?;
            if role == "developer" {
                return None;
            }
            let content = payload.get("content")?.as_array()?;
            let text = if role == "user" {
                extract_text_from_content(content, "input_text")
            } else {
                extract_text_from_content(content, "output_text")
            };
            if text.is_empty() {
                return None;
            }
            Some(UnifiedTranscriptMessage {
                role: role.to_string(),
                text,
                tool_name: None,
                tool_input: None,
                timestamp,
            })
        }
        "function_call" => {
            let name = payload
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("unknown")
                .to_string();
            let arguments = payload
                .get("arguments")
                .map(|a| {
                    if a.is_string() {
                        a.as_str().unwrap_or("").to_string()
                    } else {
                        a.to_string()
                    }
                })
                .unwrap_or_default();
            Some(UnifiedTranscriptMessage {
                role: "assistant".to_string(),
                text: String::new(),
                tool_name: Some(name),
                tool_input: Some(arguments),
                timestamp,
            })
        }
        _ => None,
    }
}

fn resolve_rollout_path(session_id: &str) -> Option<PathBuf> {
    if !is_valid_session_id(session_id) {
        eprintln!("[codex] invalid session_id for rollout lookup: {}", session_id);
        return None;
    }
    let db = codex_dir().join("state_5.sqlite");
    if db.exists() {
        if let Ok(output) = sqlite3_query(
            &db,
            &format!(
                "SELECT rollout_path FROM threads WHERE id = '{}' LIMIT 1",
                session_id
            ),
        ) {
            // Take the last non-empty line (first line may be PRAGMA output like "wal")
            if let Some(path_str) = output.lines().rev().find(|l| !l.trim().is_empty()) {
                let path_str = path_str.trim();
                let p = PathBuf::from(path_str);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    let archived = codex_dir().join("archived_sessions");
    if archived.exists() {
        if let Ok(entries) = std::fs::read_dir(&archived) {
            for entry in entries.flatten() {
                let fname = entry.file_name().to_string_lossy().to_string();
                if fname.contains(session_id) && fname.ends_with(".jsonl") {
                    return Some(entry.path());
                }
            }
        }
    }

    None
}

fn read_rollout_content(session_id: &str) -> Result<String, Box<dyn std::error::Error>> {
    let path = resolve_rollout_path(session_id)
        .ok_or_else(|| format!("no rollout file found for session {}", session_id))?;
    std::fs::read_to_string(&path).map_err(|e| e.into())
}

fn read_rollout_tail(session_id: &str, tail_bytes: u64) -> Result<String, Box<dyn std::error::Error>> {
    use std::io::{Read as IoRead, Seek, SeekFrom};

    let path = resolve_rollout_path(session_id)
        .ok_or_else(|| format!("no rollout file found for session {}", session_id))?;

    let file = std::fs::File::open(&path)?;
    let file_len = file.metadata()?.len();
    if file_len <= tail_bytes {
        return std::fs::read_to_string(&path).map_err(|e| e.into());
    }

    let mut f = file;
    let seek_back = std::cmp::min(tail_bytes, i64::MAX as u64) as i64;
    f.seek(SeekFrom::End(-seek_back))?;
    let mut buf = Vec::with_capacity(tail_bytes as usize);
    f.read_to_end(&mut buf)?;

    let text = String::from_utf8_lossy(&buf).into_owned();
    if let Some(pos) = text.find('\n') {
        Ok(text[pos + 1..].to_string())
    } else {
        Ok(text)
    }
}

fn discover_from_sqlite() -> Result<Vec<UnifiedSession>, Box<dyn std::error::Error>> {
    let db = codex_dir().join("state_5.sqlite");
    if !db.exists() {
        return Err("state_5.sqlite not found".into());
    }

    let sql = "SELECT id, cwd, title, created_at, updated_at, archived FROM threads WHERE archived = 0";
    let output = sqlite3_query(&db, sql)?;

    let codex_alive = is_codex_running();
    let mut sessions = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 6 {
            continue;
        }

        let id = parts[0].to_string();
        let cwd = parts[1].to_string();
        let title = parts[2].to_string();
        let created_at: u64 = parts[3].parse().unwrap_or(0);
        let _updated_at: u64 = parts[4].parse().unwrap_or(0);
        let archived: i64 = parts[5].parse().unwrap_or(0);

        let started_at_ms = created_at * 1000;

        sessions.push(UnifiedSession {
            pid: 0,
            session_id: id,
            cwd,
            started_at: started_at_ms,
            kind: "codex".to_string(),
            entrypoint: title,
            is_alive: codex_alive && archived == 0,
            provider: ProviderKind::Codex,
        });
    }

    Ok(sessions)
}

/// Fallback when SQLite is unavailable — uses lightweight JSONL index.
fn discover_from_index() -> Result<Vec<UnifiedSession>, Box<dyn std::error::Error>> {
    let index_path = codex_dir().join("session_index.jsonl");
    if !index_path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&index_path)?;
    let codex_alive = is_codex_running();
    let mut sessions = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let id = v
            .get("id")
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string();
        let title = v
            .get("thread_name")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let updated_at = v
            .get("updated_at")
            .and_then(|u| u.as_str())
            .unwrap_or("");

        let started_at_ms = parse_iso8601_to_millis(updated_at);

        if !id.is_empty() {
            sessions.push(UnifiedSession {
                pid: 0,
                session_id: id,
                cwd: String::new(),
                started_at: started_at_ms,
                kind: "codex".to_string(),
                entrypoint: title,
                is_alive: codex_alive,
                provider: ProviderKind::Codex,
            });
        }
    }

    Ok(sessions)
}

fn parse_iso8601_to_millis(s: &str) -> u64 {
    let s = s.trim().trim_end_matches('Z');
    let parts: Vec<&str> = s.split('T').collect();
    if parts.is_empty() {
        return 0;
    }
    let date_parts: Vec<u64> = parts[0].split('-').filter_map(|p| p.parse().ok()).collect();
    if date_parts.len() < 3 {
        return 0;
    }
    let (y, m, d) = (date_parts[0], date_parts[1], date_parts[2]);

    let mut time_secs = 0u64;
    if parts.len() > 1 {
        let time_parts: Vec<u64> = parts[1]
            .split(':')
            .filter_map(|p| p.split('.').next().and_then(|pp| pp.parse().ok()))
            .collect();
        if time_parts.len() >= 3 {
            time_secs = time_parts[0] * 3600 + time_parts[1] * 60 + time_parts[2];
        }
    }

    let days = (y - 1970) * 365 + (y - 1970) / 4 + (m - 1) * 30 + d;
    (days * 86400 + time_secs) * 1000
}

/// Infer activity from the tail of the rollout JSONL — a function_call
/// without a matching function_call_output means the tool is still running.
fn derive_codex_activity(
    session_id: &str,
) -> (String, Option<String>) {
    let tail = match read_rollout_tail(session_id, 8192) {
        Ok(t) => t,
        Err(_) => return ("idle".to_string(), None),
    };

    let items = parse_response_items(&tail);
    if items.is_empty() {
        return ("idle".to_string(), None);
    }

    for item in items.iter().rev() {
        let payload = match item.get("payload") {
            Some(p) => p,
            None => continue,
        };
        let item_type = match payload.get("type").and_then(|t| t.as_str()) {
            Some(t) => t,
            None => continue,
        };

        match item_type {
            "function_call" => {
                let call_id = payload.get("call_id").and_then(|c| c.as_str()).unwrap_or("");
                let has_output = items.iter().any(|i| {
                    i.get("payload")
                        .and_then(|p| {
                            if p.get("type")?.as_str()? == "function_call_output" {
                                let out_id = p.get("call_id").and_then(|c| c.as_str()).unwrap_or("");
                                if out_id == call_id {
                                    return Some(true);
                                }
                            }
                            None
                        })
                        .is_some()
                });
                let tool_name = payload
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                if !has_output {
                    return ("working".to_string(), Some(tool_name));
                }
            }
            "message" => {
                let role = payload.get("role").and_then(|r| r.as_str()).unwrap_or("");
                match role {
                    "assistant" => return ("thinking".to_string(), None),
                    "user" => return ("waiting_input".to_string(), None),
                    _ => {}
                }
            }
            _ => {}
        }
    }

    ("idle".to_string(), None)
}

pub struct CodexProvider;

impl SessionProvider for CodexProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Codex
    }

    fn discover_sessions(&self) -> Result<Vec<UnifiedSession>, Box<dyn std::error::Error>> {
        match discover_from_sqlite() {
            Ok(sessions) => Ok(sessions),
            Err(e) => {
                eprintln!("[codex] sqlite discovery failed ({}), trying index fallback", e);
                discover_from_index()
            }
        }
    }

    fn read_transcript(
        &self,
        session_id: &str,
        _cwd: &str,
    ) -> Result<Vec<UnifiedTranscriptMessage>, Box<dyn std::error::Error>> {
        let content = read_rollout_content(session_id)?;
        let items = parse_response_items(&content);
        let messages: Vec<UnifiedTranscriptMessage> =
            items.iter().filter_map(response_item_to_message).collect();
        Ok(messages)
    }

    fn read_last_message(
        &self,
        session_id: &str,
        _cwd: &str,
    ) -> Result<Option<UnifiedTranscriptMessage>, Box<dyn std::error::Error>> {
        let tail = read_rollout_tail(session_id, 8192)?;
        let items = parse_response_items(&tail);

        let msg = items
            .iter()
            .rev()
            .filter_map(|item| {
                let payload = item.get("payload")?;
                let item_type = payload.get("type")?.as_str()?;
                if item_type != "message" {
                    return None;
                }
                let role = payload.get("role")?.as_str()?;
                if role == "user" || role == "assistant" {
                    response_item_to_message(item)
                } else {
                    None
                }
            })
            .next();

        Ok(msg)
    }

    fn read_activity(
        &self,
        session_id: &str,
        _cwd: &str,
    ) -> Result<UnifiedActivityInfo, Box<dyn std::error::Error>> {
        let (activity, tool_name) = derive_codex_activity(session_id);
        Ok(UnifiedActivityInfo {
            session_id: session_id.to_string(),
            activity,
            tool_name,
        })
    }

    fn supports_hooks(&self) -> bool {
        false
    }

    fn supports_approval(&self) -> bool {
        false
    }

    fn supports_jump(&self) -> bool {
        true
    }
}
