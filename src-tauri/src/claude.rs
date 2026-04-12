use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

fn claude_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".claude")
}

fn monitor_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".claude-cat-monitor")
}

/// Collect session IDs of all currently-alive sessions (quick, reads small JSON files).
fn alive_session_ids() -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    let sessions_dir = claude_dir().join("sessions");
    if let Ok(entries) = fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            if let Ok(content) = fs::read_to_string(entry.path()) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let (Some(pid), Some(sid)) = (
                        val.get("pid").and_then(|v| v.as_u64()),
                        val.get("sessionId").and_then(|v| v.as_str()),
                    ) {
                        if is_process_alive(pid as u32) {
                            ids.insert(sid.to_string());
                        }
                    }
                }
            }
        }
    }
    ids
}

/// Find the best transcript file for a session.
///
/// After a context compaction, Claude Code creates a NEW transcript file with a
/// different session ID while the process (PID) stays the same. The session
/// metadata still references the OLD session ID. So the exact-match file becomes
/// stale and we need to find the compacted transcript.
///
/// Strategy:
/// 1. If exact match exists and was modified recently (< 2 min) → use it.
/// 2. If exact match is stale → find the newest recently-modified .jsonl in the
///    project dir, EXCLUDING files that are exact matches for other alive sessions
///    (to avoid cross-session contamination).
/// 3. If no recent file found → use exact match (best effort for dead sessions).
/// 4. If no exact match at all → use newest .jsonl in project dir.
fn find_transcript_path(session_id: &str, cwd: &str) -> Option<PathBuf> {
    let project_key = cwd.replace('/', "-");
    let project_dir = claude_dir().join("projects").join(&project_key);

    let exact = project_dir.join(format!("{}.jsonl", session_id));
    if exact.exists() {
        // Check freshness: was this file modified within the last 2 minutes?
        let is_fresh = fs::metadata(&exact)
            .and_then(|m| m.modified())
            .ok()
            .map_or(false, |t| t.elapsed().map_or(true, |d| d.as_secs() < 120));

        if is_fresh {
            return Some(exact);
        }

        // Exact match is stale — likely compacted. Look for the real transcript.
        // Exclude files that belong to other alive sessions to avoid cross-contamination.
        let other_alive: std::collections::HashSet<String> = alive_session_ids()
            .into_iter()
            .filter(|id| id != session_id)
            .collect();

        if let Ok(entries) = fs::read_dir(&project_dir) {
            let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                // Skip the stale exact match
                if path == exact {
                    continue;
                }
                // Skip files that are exact matches for other alive sessions
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if other_alive.contains(stem) {
                        continue;
                    }
                }
                if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                    if newest.as_ref().map_or(true, |(_, t)| modified > *t) {
                        newest = Some((path, modified));
                    }
                }
            }
            if let Some((path, mod_time)) = newest {
                // Only use the newer file if it was modified recently (within 5 min)
                if mod_time.elapsed().map_or(true, |d| d.as_secs() < 300) {
                    return Some(path);
                }
            }
        }

        // No recent replacement found — use stale exact match (dead session or gap)
        return Some(exact);
    }

    // No exact match — find newest .jsonl in project dir
    if let Ok(entries) = fs::read_dir(&project_dir) {
        let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                    if newest.as_ref().map_or(true, |(_, t)| modified > *t) {
                        newest = Some((path, modified));
                    }
                }
            }
        }
        return newest.map(|(p, _)| p);
    }

    None
}

// ── Session ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClaudeSession {
    pub pid: u32,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub cwd: String,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
    pub kind: String,
    pub entrypoint: String,
    #[serde(default, rename = "isAlive")]
    pub is_alive: bool,
}

pub fn read_sessions() -> Result<Vec<ClaudeSession>, Box<dyn std::error::Error>> {
    let sessions_dir = claude_dir().join("sessions");
    let mut sessions = Vec::new();

    if !sessions_dir.exists() {
        return Ok(sessions);
    }

    for entry in fs::read_dir(&sessions_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "json") {
            let content = fs::read_to_string(&path)?;
            if let Ok(mut session) = serde_json::from_str::<ClaudeSession>(&content) {
                session.is_alive = is_process_alive(session.pid);
                sessions.push(session);
            }
        }
    }

    sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(sessions)
}

fn is_process_alive(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Get the last text message (user or assistant) from a session transcript.
/// Reads only the tail of the file for efficiency.
pub fn read_session_last_message(
    session_id: &str,
    cwd: &str,
) -> Result<Option<TranscriptMessage>, Box<dyn std::error::Error>> {
    let transcript_path = match find_transcript_path(session_id, cwd) {
        Some(p) => p,
        None => return Ok(None),
    };

    // Read only last ~16KB for speed
    let file = fs::File::open(&transcript_path)?;
    let file_len = file.metadata()?.len();
    let tail_size: u64 = 16 * 1024;
    let content = if file_len > tail_size {
        use std::io::{Read as IoRead, Seek, SeekFrom};
        let mut f = file;
        f.seek(SeekFrom::End(-(tail_size as i64)))?;
        let mut buf = String::new();
        f.read_to_string(&mut buf)?;
        if let Some(pos) = buf.find('\n') {
            buf.drain(..=pos);
        }
        buf
    } else {
        fs::read_to_string(&transcript_path)?
    };

    let mut last_msg: Option<TranscriptMessage> = None;

    for line in content.lines() {
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if msg_type != "user" && msg_type != "assistant" {
            continue;
        }

        let content_val = val.pointer("/message/content");
        if let Some(content_arr) = content_val.and_then(|v| v.as_array()) {
            for block in content_arr {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if !text.is_empty() {
                        last_msg = Some(TranscriptMessage {
                            role: msg_type.to_string(),
                            text: text.to_string(),
                            tool_name: None,
                            tool_input: None,
                            timestamp: val
                                .get("timestamp")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                        });
                    }
                }
            }
        } else if let Some(text) = content_val.and_then(|v| v.as_str()) {
            if !text.is_empty() {
                last_msg = Some(TranscriptMessage {
                    role: msg_type.to_string(),
                    text: text.to_string(),
                    tool_name: None,
                    tool_input: None,
                    timestamp: val
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                });
            }
        }
    }

    Ok(last_msg)
}

// ── Session Activity ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionActivityInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub activity: String,
    #[serde(rename = "toolName")]
    pub tool_name: Option<String>,
}

/// Derive what a session is currently doing from the tail of its transcript.
pub fn read_session_activity(
    session_id: &str,
    cwd: &str,
) -> Result<SessionActivityInfo, Box<dyn std::error::Error>> {
    let default = SessionActivityInfo {
        session_id: session_id.to_string(),
        activity: "idle".to_string(),
        tool_name: None,
    };

    let transcript_path = match find_transcript_path(session_id, cwd) {
        Some(p) => p,
        None => return Ok(default),
    };

    // Read last ~8KB
    let file = fs::File::open(&transcript_path)?;
    let file_len = file.metadata()?.len();
    let tail_size: u64 = 8 * 1024;
    let content = if file_len > tail_size {
        use std::io::{Read as IoRead, Seek, SeekFrom};
        let mut f = file;
        f.seek(SeekFrom::End(-(tail_size as i64)))?;
        let mut buf = String::new();
        f.read_to_string(&mut buf)?;
        if let Some(pos) = buf.find('\n') {
            buf.drain(..=pos);
        }
        buf
    } else {
        fs::read_to_string(&transcript_path)?
    };

    let (activity, tool_name) = derive_activity_from_content(&content);

    Ok(SessionActivityInfo {
        session_id: session_id.to_string(),
        activity,
        tool_name,
    })
}

/// Pure function: derive activity from JSONL content string.
/// Returns (activity_string, optional_tool_name).
fn derive_activity_from_content(content: &str) -> (String, Option<String>) {
    let mut last_type = "";
    let mut last_tool: Option<String> = None;
    let mut last_val: Option<serde_json::Value> = None;

    for line in content.lines() {
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let msg_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if msg_type == "user" || msg_type == "assistant" {
            let mut found_tool = None;
            if let Some(arr) = val.pointer("/message/content").and_then(|v| v.as_array()) {
                for block in arr {
                    if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        found_tool = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                }
            }
            last_type = if msg_type == "user" {
                "user"
            } else {
                "assistant"
            };
            last_tool = found_tool;
            last_val = Some(val);
        }
    }

    let activity = match (last_type, &last_tool) {
        ("user", _) => "waiting_input",
        ("assistant", Some(tool)) => match tool.as_str() {
            "Read" => "reading",
            "Write" | "Edit" => "writing",
            "Bash" => "building",
            "Grep" | "Glob" => "searching",
            "Agent" => "thinking",
            _ => "working",
        },
        ("assistant", None) => {
            if let Some(val) = &last_val {
                let stop = val
                    .get("stop_reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if stop == "end_turn" {
                    "done"
                } else {
                    "thinking"
                }
            } else {
                "idle"
            }
        }
        _ => "idle",
    };

    (activity.to_string(), last_tool)
}

// ── Token Stats ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DailyActivity {
    pub date: String,
    #[serde(rename = "messageCount")]
    pub message_count: u64,
    #[serde(rename = "sessionCount")]
    pub session_count: u64,
    #[serde(rename = "toolCallCount")]
    pub tool_call_count: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TokenStats {
    pub version: u32,
    #[serde(rename = "lastComputedDate")]
    pub last_computed_date: String,
    #[serde(rename = "dailyActivity")]
    pub daily_activity: Vec<DailyActivity>,
}

pub fn read_token_stats() -> Result<TokenStats, Box<dyn std::error::Error>> {
    let stats_path = claude_dir().join("stats-cache.json");
    let content = fs::read_to_string(&stats_path)?;
    let stats: TokenStats = serde_json::from_str(&content)?;
    Ok(stats)
}

// ── Rate Limits (from statusline hook) ──

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RateBucket {
    pub used_percentage: f64,
    pub resets_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RateLimits {
    #[serde(default)]
    pub five_hour: RateBucket,
    #[serde(default)]
    pub seven_day: RateBucket,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ContextInfo {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub context_used: f64,
    #[serde(default)]
    pub context_total: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct LiveStats {
    #[serde(rename = "rateLimits")]
    pub rate_limits: RateLimits,
    pub context: ContextInfo,
}

pub fn read_live_stats() -> Result<LiveStats, Box<dyn std::error::Error>> {
    let cache = monitor_dir().join("cache");
    let mut stats = LiveStats::default();

    // Read rate limits
    let rl_path = cache.join("rate-limits.json");
    if rl_path.exists() {
        if let Ok(content) = fs::read_to_string(&rl_path) {
            if let Ok(rl) = serde_json::from_str::<RateLimits>(&content) {
                stats.rate_limits = rl;
            }
        }
    }

    // Read context info
    let ctx_path = cache.join("context.json");
    if ctx_path.exists() {
        if let Ok(content) = fs::read_to_string(&ctx_path) {
            if let Ok(ctx) = serde_json::from_str::<ContextInfo>(&content) {
                stats.context = ctx;
            }
        }
    }

    Ok(stats)
}

// ── Recent Events (from bridge hook) ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HookEvent {
    pub event: String,
    pub ts: u64,
    #[serde(default)]
    pub data: serde_json::Value,
}

pub fn read_recent_events(limit: usize) -> Result<Vec<HookEvent>, Box<dyn std::error::Error>> {
    let events_path = monitor_dir().join("events.jsonl");
    if !events_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&events_path)?;
    let events: Vec<HookEvent> = content
        .lines()
        .rev()
        .take(limit)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    Ok(events)
}

// ── Latest Notification (written by bridge on Stop/Notification) ──

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct LatestNotification {
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub ts: u64,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub message: String,
}

pub fn read_latest_notification() -> Result<LatestNotification, Box<dyn std::error::Error>> {
    let path = monitor_dir().join("latest-notification.json");
    if !path.exists() {
        return Ok(LatestNotification::default());
    }
    let content = fs::read_to_string(&path)?;
    let notif: LatestNotification = serde_json::from_str(&content)?;
    Ok(notif)
}

// ── Session Transcript ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptMessage {
    pub role: String, // "user" | "assistant" | "system"
    pub text: String, // main text content
    #[serde(rename = "toolName")]
    pub tool_name: Option<String>,
    #[serde(rename = "toolInput")]
    pub tool_input: Option<String>, // short summary
    pub timestamp: Option<String>,
}

pub fn read_session_transcript(
    session_id: &str,
    cwd: &str,
) -> Result<Vec<TranscriptMessage>, Box<dyn std::error::Error>> {
    let transcript_path = match find_transcript_path(session_id, cwd) {
        Some(p) => p,
        None => return Ok(vec![]),
    };

    // Only read the tail of the file for performance (last ~256KB)
    let file = fs::File::open(&transcript_path)?;
    let file_len = file.metadata()?.len();
    let tail_size: u64 = 256 * 1024;
    let content = if file_len > tail_size {
        use std::io::{Read as IoRead, Seek, SeekFrom};
        let mut f = file;
        f.seek(SeekFrom::End(-(tail_size as i64)))?;
        let mut buf = String::new();
        f.read_to_string(&mut buf)?;
        // Drop the first (likely partial) line
        if let Some(pos) = buf.find('\n') {
            buf.drain(..=pos);
        }
        buf
    } else {
        fs::read_to_string(&transcript_path)?
    };

    let mut messages = Vec::new();

    for line in content.lines() {
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match msg_type {
            "user" | "assistant" => {
                let content_val = val.pointer("/message/content");
                if let Some(content_arr) = content_val.and_then(|v| v.as_array()) {
                    for block in content_arr {
                        let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match block_type {
                            "text" => {
                                let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                                if !text.is_empty() {
                                    messages.push(TranscriptMessage {
                                        role: msg_type.to_string(),
                                        text: text.to_string(),
                                        tool_name: None,
                                        tool_input: None,
                                        timestamp: val
                                            .get("timestamp")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string()),
                                    });
                                }
                            }
                            "tool_use" => {
                                let name = block
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown");
                                let input_summary = extract_tool_summary(name, block.get("input"));
                                messages.push(TranscriptMessage {
                                    role: "tool".to_string(),
                                    text: String::new(),
                                    tool_name: Some(name.to_string()),
                                    tool_input: Some(input_summary),
                                    timestamp: None,
                                });
                            }
                            _ => {}
                        }
                    }
                } else if let Some(text) = content_val.and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        messages.push(TranscriptMessage {
                            role: msg_type.to_string(),
                            text: text.to_string(),
                            tool_name: None,
                            tool_input: None,
                            timestamp: val
                                .get("timestamp")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                        });
                    }
                }
            }
            _ => {}
        }
    }

    // Only keep the last 50 messages so the UI shows recent activity
    let max_messages = 50;
    if messages.len() > max_messages {
        messages.drain(..messages.len() - max_messages);
    }

    Ok(messages)
}

fn extract_tool_summary(tool_name: &str, input: Option<&serde_json::Value>) -> String {
    let input = match input {
        Some(v) => v,
        None => return String::new(),
    };
    match tool_name {
        "Read" => input
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "Write" => input
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "Edit" => input
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "Bash" => {
            let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
            cmd.chars().take(80).collect()
        }
        "Grep" => {
            let pat = input.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
            format!("/{}/", pat)
        }
        "Glob" => input
            .get("pattern")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => {
            let s = serde_json::to_string(input).unwrap_or_default();
            s.chars().take(80).collect()
        }
    }
}

// ── Skills ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillInfo {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub name: String,
    pub path: String,
    /// Ordered frontmatter key/value pairs. Empty if the file has no frontmatter.
    pub frontmatter: Vec<(String, String)>,
    /// Markdown body — the content after the closing `---`, or the whole file if no frontmatter.
    pub body: String,
    /// Absolute path of the .md file we actually read.
    pub source_file: String,
}

pub fn read_skills() -> Result<Vec<SkillInfo>, Box<dyn std::error::Error>> {
    let skills_dir = claude_dir().join("skills");
    let mut skills = Vec::new();

    if !skills_dir.exists() {
        return Ok(skills);
    }

    for entry in fs::read_dir(&skills_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            let desc = read_skill_description(&path).unwrap_or_default();
            skills.push(SkillInfo {
                name,
                path: path.to_string_lossy().to_string(),
                description: desc,
            });
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

pub fn read_skill_detail(name: &str) -> Result<SkillDetail, Box<dyn std::error::Error>> {
    let skill_dir = claude_dir().join("skills").join(name);
    if !skill_dir.is_dir() {
        return Err(format!("skill not found: {}", name).into());
    }
    let md_path = find_primary_md(&skill_dir)
        .ok_or_else(|| format!("no markdown file in skill: {}", name))?;
    let content = fs::read_to_string(&md_path)?;
    let (frontmatter, body) = match split_frontmatter(&content) {
        Some((fm, body_str)) => {
            let pairs = serde_yaml::from_str::<serde_yaml::Value>(fm)
                .map(|v| yaml_to_pairs(&v))
                .unwrap_or_default();
            (pairs, body_str.to_string())
        }
        None => (Vec::new(), content.clone()),
    };
    Ok(SkillDetail {
        name: name.to_string(),
        path: skill_dir.to_string_lossy().to_string(),
        frontmatter,
        body,
        source_file: md_path.to_string_lossy().to_string(),
    })
}

fn find_primary_md(skill_dir: &PathBuf) -> Option<PathBuf> {
    let skill_md = skill_dir.join("SKILL.md");
    if skill_md.is_file() {
        return Some(skill_md);
    }
    let mut candidates: Vec<PathBuf> = fs::read_dir(skill_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().map_or(false, |ext| ext == "md"))
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

/// Split a markdown file into (frontmatter, body) if it starts with a `---`-delimited YAML block.
/// Returns None if the file does not begin with `---`.
fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    let rest = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    // Find the closing `---` on its own line.
    let mut idx = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            let fm = &rest[..idx];
            let body_start = idx + line.len();
            let body = if body_start <= rest.len() {
                &rest[body_start..]
            } else {
                ""
            };
            return Some((fm, body));
        }
        idx += line.len();
    }
    None
}

/// Flatten a YAML mapping into ordered (key, display-value) pairs.
/// Nested structures are rendered via serde_yaml's to_string for readability.
fn yaml_to_pairs(value: &serde_yaml::Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let serde_yaml::Value::Mapping(map) = value {
        for (k, v) in map {
            let key = match k {
                serde_yaml::Value::String(s) => s.clone(),
                other => serde_yaml::to_string(other)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
            };
            let display = match v {
                serde_yaml::Value::String(s) => s.clone(),
                serde_yaml::Value::Bool(b) => b.to_string(),
                serde_yaml::Value::Number(n) => n.to_string(),
                serde_yaml::Value::Null => String::new(),
                other => serde_yaml::to_string(other)
                    .unwrap_or_default()
                    .trim_end()
                    .to_string(),
            };
            out.push((key, display));
        }
    }
    out
}

fn read_skill_description(skill_dir: &PathBuf) -> Option<String> {
    let md_path = find_primary_md(skill_dir)?;
    let content = fs::read_to_string(&md_path).ok()?;

    // Prefer YAML frontmatter `description` field when present.
    if let Some((fm, _body)) = split_frontmatter(&content) {
        if let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(fm) {
            if let Some(desc) = value.get("description").and_then(|v| v.as_str()) {
                let trimmed = desc.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.chars().take(200).collect());
                }
            }
        }
    }

    // Fallback: first non-empty, non-heading, non-delimiter line (legacy behaviour).
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') && !trimmed.starts_with("---") {
            return Some(trimmed.chars().take(100).collect());
        }
    }
    None
}

// ── Permissions ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PermissionConfig {
    #[serde(rename = "skipDangerousMode")]
    pub skip_dangerous_mode: bool,
    #[serde(rename = "autoApproveAll")]
    pub auto_approve_all: bool,
    #[serde(rename = "currentHooks")]
    pub current_hooks: Vec<String>,
}

pub fn read_permissions() -> Result<PermissionConfig, Box<dyn std::error::Error>> {
    let settings_path = claude_dir().join("settings.json");
    let content = fs::read_to_string(&settings_path)?;
    let settings: serde_json::Value = serde_json::from_str(&content)?;

    let skip = settings
        .get("skipDangerousModePermissionPrompt")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Check flag file for auto-approve
    let auto_approve = monitor_dir().join("auto-approve").exists();

    let current_hooks: Vec<String> = settings
        .get("hooks")
        .and_then(|v| v.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default();

    Ok(PermissionConfig {
        skip_dangerous_mode: skip,
        auto_approve_all: auto_approve,
        current_hooks,
    })
}

pub fn set_permission_skip_dangerous(enabled: bool) -> Result<(), Box<dyn std::error::Error>> {
    let settings_path = claude_dir().join("settings.json");
    let content = fs::read_to_string(&settings_path)?;
    let mut settings: serde_json::Value = serde_json::from_str(&content)?;

    settings["skipDangerousModePermissionPrompt"] = serde_json::Value::Bool(enabled);

    let output = serde_json::to_string_pretty(&settings)?;
    fs::write(&settings_path, output)?;
    Ok(())
}

pub fn set_auto_approve(enabled: bool) -> Result<(), Box<dyn std::error::Error>> {
    let flag_path = monitor_dir().join("auto-approve");
    if enabled {
        fs::write(&flag_path, "1")?;
    } else if flag_path.exists() {
        fs::remove_file(&flag_path)?;
    }
    Ok(())
}

// ── Session Pending State (Ask/Approve detection) ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionPendingState {
    pub session_id: String,
    /// "none" | "needs_approval" | "waiting_input"
    pub pending: String,
    #[serde(default)]
    pub tool_name: String,
    #[serde(default)]
    pub message: String,
    pub ts: u64,
}

pub fn read_session_pending_states() -> Result<Vec<SessionPendingState>, Box<dyn std::error::Error>>
{
    let events_path = monitor_dir().join("events.jsonl");
    if !events_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&events_path)?;

    // Build a map of session_id -> latest meaningful event
    let mut latest: std::collections::HashMap<String, (String, u64, serde_json::Value)> =
        std::collections::HashMap::new();

    for line in content.lines() {
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event = val.get("event").and_then(|v| v.as_str()).unwrap_or("");
        let ts = val.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
        let data = val.get("data").cloned().unwrap_or(serde_json::Value::Null);
        let session_id = data
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if session_id.is_empty() {
            continue;
        }

        // Only track events that indicate state changes
        match event {
            "PermissionRequest" | "Stop" | "SessionStart" | "Notification" => {
                let existing_ts = latest.get(session_id).map(|e| e.1).unwrap_or(0);
                if ts >= existing_ts {
                    latest.insert(session_id.to_string(), (event.to_string(), ts, data));
                }
            }
            _ => {}
        }
    }

    let mut states = Vec::new();
    for (session_id, (event, ts, data)) in &latest {
        let pending = match event.as_str() {
            "PermissionRequest" => "needs_approval",
            "Notification" => {
                let ntype = data
                    .get("notification_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if ntype == "permission_prompt" {
                    "needs_approval"
                } else {
                    "none"
                }
            }
            "Stop" => "waiting_input",
            _ => "none",
        };

        if pending == "none" {
            continue;
        }

        let tool_name = data
            .get("tool_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let message = data
            .get("last_assistant_message")
            .or_else(|| data.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(120)
            .collect();

        states.push(SessionPendingState {
            session_id: session_id.clone(),
            pending: pending.to_string(),
            tool_name,
            message,
            ts: *ts,
        });
    }

    Ok(states)
}

// ── Jump to Terminal ──

pub fn jump_to_session(pid: u32) -> Result<(), Box<dyn std::error::Error>> {
    // 1. Find the TTY for this PID
    let output = std::process::Command::new("lsof")
        .args(["-p", &pid.to_string(), "-a", "-d", "0"])
        .output()?;

    let lsof_out = String::from_utf8_lossy(&output.stdout);
    let tty = lsof_out
        .lines()
        .skip(1) // header
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            parts.last().map(|s| s.to_string())
        })
        .find(|s| s.starts_with("/dev/ttys"));

    // 2. Detect which terminal app is running
    let terminal_app = detect_terminal_for_pid(pid);

    // 3. Use AppleScript to activate the correct terminal window
    if let Some(tty_path) = tty {
        match terminal_app.as_str() {
            "iTerm2" | "iTerm" => {
                let script = format!(
                    r#"tell application "iTerm2"
                         activate
                         repeat with w in windows
                             repeat with t in tabs of w
                                 repeat with s in sessions of t
                                     if tty of s contains "{}" then
                                         select t
                                         set index of w to 1
                                         return
                                     end if
                                 end repeat
                             end repeat
                         end repeat
                     end tell"#,
                    tty_path
                );
                let _ = std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .output();
            }
            "Terminal" => {
                let script = format!(
                    r#"tell application "Terminal"
                         activate
                         repeat with w in windows
                             repeat with t in tabs of w
                                 if tty of t is "{}" then
                                     set selected tab of w to t
                                     set index of w to 1
                                     return
                                 end if
                             end repeat
                         end repeat
                     end tell"#,
                    tty_path
                );
                let _ = std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .output();
            }
            "Ghostty" => {
                ghostty_raise_window(Some(&tty_path));
            }
            "IntelliJ IDEA" | "WebStorm" | "PyCharm" => {
                let _ = std::process::Command::new("osascript")
                    .args(["-e", &format!(r#"tell application "{}" to activate"#, terminal_app)])
                    .output();
            }
            _ => {
                let _ = std::process::Command::new("osascript")
                    .args([
                        "-e",
                        &format!(r#"tell application "{}" to activate"#, terminal_app),
                    ])
                    .output();
            }
        }
    } else {
        match terminal_app.as_str() {
            "Ghostty" => ghostty_raise_window(None),
            _ => {
                let _ = std::process::Command::new("osascript")
                    .args([
                        "-e",
                        &format!(r#"tell application "{}" to activate"#, terminal_app),
                    ])
                    .output();
            }
        }
    }

    Ok(())
}

/// Copy text to clipboard, jump to the terminal, and optionally paste+send
/// Returns "auto_sent" if the text was automatically sent, "clipboard_only" if user needs to paste.
pub fn copy_and_jump(pid: u32, text: String) -> Result<String, Box<dyn std::error::Error>> {
    // 1. Copy text to clipboard
    let mut clipboard = arboard::Clipboard::new()?;
    clipboard.set_text(&text)?;

    // 2. Find TTY and detect terminal
    let output = std::process::Command::new("lsof")
        .args(["-p", &pid.to_string(), "-a", "-d", "0"])
        .output()?;

    let lsof_out = String::from_utf8_lossy(&output.stdout);
    let tty = lsof_out
        .lines()
        .skip(1)
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            parts.last().map(|s| s.to_string())
        })
        .find(|s| s.starts_with("/dev/ttys"));

    let terminal_app = detect_terminal_for_pid(pid);

    // 3. Jump to the terminal window (reuse jump logic)
    if let Some(ref tty_path) = tty {
        match terminal_app.as_str() {
            "iTerm2" | "iTerm" => {
                // iTerm2: activate window, then paste+send via write text
                let script = format!(
                    r#"tell application "iTerm2"
                         activate
                         repeat with w in windows
                             repeat with t in tabs of w
                                 repeat with s in sessions of t
                                     if tty of s contains "{tty}" then
                                         select t
                                         set index of w to 1
                                         tell s to write text "{text}"
                                         return
                                     end if
                                 end repeat
                             end repeat
                         end repeat
                     end tell"#,
                    tty = tty_path,
                    text = text.replace('\\', "\\\\").replace('"', "\\\""),
                );
                let _ = std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .output();
                return Ok("auto_sent".to_string());
            }
            "Terminal" => {
                // Terminal.app: activate + keystroke paste + return
                let script = format!(
                    r#"tell application "Terminal"
                         activate
                         repeat with w in windows
                             repeat with t in tabs of w
                                 if tty of t is "{tty}" then
                                     set selected tab of w to t
                                     set index of w to 1
                                 end if
                             end repeat
                         end repeat
                     end tell
                     delay 0.2
                     tell application "System Events"
                         keystroke "v" using command down
                         delay 0.1
                         key code 36
                     end tell"#,
                    tty = tty_path,
                );
                let _ = std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .output();
                return Ok("auto_sent".to_string());
            }
            "Ghostty" => {
                ghostty_raise_window(Some(tty_path));
                return Ok("clipboard_only".to_string());
            }
            "IntelliJ IDEA" | "WebStorm" | "PyCharm" => {
                let _ = std::process::Command::new("osascript")
                    .args(["-e", &format!(r#"tell application "{}" to activate"#, terminal_app)])
                    .output();
                return Ok("clipboard_only".to_string());
            }
            _ => {
                let _ = std::process::Command::new("osascript")
                    .args([
                        "-e",
                        &format!(r#"tell application "{}" to activate"#, terminal_app),
                    ])
                    .output();
                return Ok("clipboard_only".to_string());
            }
        }
    } else {
        match terminal_app.as_str() {
            "Ghostty" => ghostty_raise_window(None),
            _ => {
                let _ = std::process::Command::new("osascript")
                    .args([
                        "-e",
                        &format!(r#"tell application "{}" to activate"#, terminal_app),
                    ])
                    .output();
            }
        }
    }

    Ok("clipboard_only".to_string())
}

/// Install the PermissionRequest hook into Claude Code's user settings
pub fn install_approval_hook() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let settings_path = format!("{}/.claude/settings.json", home);

    // Read existing settings or create new
    let mut settings: serde_json::Value = if std::path::Path::new(&settings_path).exists() {
        let content = std::fs::read_to_string(&settings_path)?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Check if our hook already exists
    let hook_command = "curl -s -X POST http://127.0.0.1:57000/hooks/permission-request -H 'Content-Type: application/json' -d \"$(cat)\" --max-time 300";

    if let Some(hooks) = settings.get("hooks") {
        if let Some(pr_hooks) = hooks.get("PermissionRequest") {
            if let Some(arr) = pr_hooks.as_array() {
                for entry in arr {
                    if let Some(hooks_arr) = entry.get("hooks").and_then(|h| h.as_array()) {
                        for h in hooks_arr {
                            if let Some(cmd) = h.get("command").and_then(|c| c.as_str()) {
                                if cmd.contains("127.0.0.1:57000") {
                                    eprintln!("[approval] Hook already installed");
                                    return Ok(());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Add our hook
    let our_hook = serde_json::json!({
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": hook_command,
            "timeout": 300
        }]
    });

    if settings.get("hooks").is_none() {
        settings["hooks"] = serde_json::json!({});
    }

    let existing = settings["hooks"]
        .get("PermissionRequest")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut new_hooks = existing;
    new_hooks.push(our_hook);
    settings["hooks"]["PermissionRequest"] = serde_json::Value::Array(new_hooks);

    // Write back
    let formatted = serde_json::to_string_pretty(&settings)?;
    std::fs::write(&settings_path, formatted)?;
    eprintln!("[approval] Hook installed to {}", settings_path);

    Ok(())
}

/// Detect which terminal app owns a specific PID by tracing the process tree.
/// Falls back to checking running terminal apps if the trace fails.
fn detect_terminal_for_pid(pid: u32) -> String {
    // Strategy: PID → find shell on same TTY → trace parent chain up to terminal app
    // The chain is typically: terminal → login → zsh → node(claude)
    let output = std::process::Command::new("lsof")
        .args(["-p", &pid.to_string(), "-a", "-d", "0"])
        .output();

    if let Ok(o) = output {
        let lsof_out = String::from_utf8_lossy(&o.stdout);
        if let Some(tty) = lsof_out
            .lines()
            .skip(1)
            .filter_map(|line| {
                let parts: Vec<&str> = line.split_whitespace().collect();
                parts.last().map(|s| s.to_string())
            })
            .find(|s| s.starts_with("/dev/ttys"))
        {
            // Find shell processes on the same TTY
            if let Ok(lsof_tty) = std::process::Command::new("lsof").arg(&tty).output() {
                let tty_out = String::from_utf8_lossy(&lsof_tty.stdout);
                for line in tty_out.lines().skip(1) {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        if let Ok(child_pid) = parts[1].parse::<u32>() {
                            // Trace up parent chain looking for a terminal app
                            if let Some(app) = trace_to_terminal(child_pid) {
                                return app;
                            }
                        }
                    }
                }
            }
        }
    }

    // Fallback: detect any running terminal
    detect_terminal_app()
}

/// Trace parent process chain up to find a terminal app.
fn trace_to_terminal(start_pid: u32) -> Option<String> {
    let mut current = start_pid;
    for _ in 0..10 {
        let output = std::process::Command::new("ps")
            .args(["-p", &current.to_string(), "-o", "ppid=,comm="])
            .output()
            .ok()?;
        let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let parts: Vec<&str> = line.splitn(2, char::is_whitespace).collect();
        if parts.len() < 2 {
            return None;
        }
        let comm = parts[1].trim().to_lowercase();

        if comm.contains("iterm") {
            return Some("iTerm2".to_string());
        }
        if comm.contains("ghostty") {
            return Some("Ghostty".to_string());
        }
        if comm.contains("warp") {
            return Some("Warp".to_string());
        }
        if comm.contains("alacritty") {
            return Some("Alacritty".to_string());
        }
        if comm.contains("kitty") {
            return Some("kitty".to_string());
        }
        if comm.contains("wezterm") {
            return Some("WezTerm".to_string());
        }
        if comm.contains("idea") || comm.contains("intellij") {
            return Some("IntelliJ IDEA".to_string());
        }
        if comm.contains("webstorm") {
            return Some("WebStorm".to_string());
        }
        if comm.contains("pycharm") {
            return Some("PyCharm".to_string());
        }
        if comm.contains("terminal") && !comm.contains("login") {
            return Some("Terminal".to_string());
        }

        let ppid: u32 = parts[0].trim().parse().ok()?;
        if ppid <= 1 {
            return None;
        }
        current = ppid;
    }
    None
}

fn detect_terminal_app() -> String {
    // pgrep is unreliable for some apps on macOS (e.g. Ghostty path-based names).
    // Use ps -eo args and match against known patterns instead.
    let ps_out = std::process::Command::new("ps")
        .args(["-eo", "args"])
        .output();
    let all_args = match ps_out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_lowercase(),
        Err(_) => return "Terminal".to_string(),
    };

    let terminals = [
        ("iterm2", "iTerm2"),
        ("ghostty", "Ghostty"),
        ("warp", "Warp"),
        ("alacritty", "Alacritty"),
        ("kitty", "kitty"),
        ("wezterm", "WezTerm"),
        ("intellij", "IntelliJ IDEA"),
        ("webstorm", "WebStorm"),
        ("pycharm", "PyCharm"),
        ("terminal.app", "Terminal"),
    ];
    for (pattern, name) in &terminals {
        if all_args.contains(pattern) {
            return name.to_string();
        }
    }
    "Terminal".to_string()
}

/// For Ghostty: map a target TTY to a window index by enumerating Ghostty's
/// direct child processes (login/shell) and their TTYs. The index (1-based)
/// corresponds to the creation order of windows/tabs, which usually matches
/// the System Events AXWindows order.
fn ghostty_tty_to_window_index(tty_path: &str) -> Option<usize> {
    // Find Ghostty's PID using ps (pgrep is unreliable on macOS for path-based names)
    let ps_out = std::process::Command::new("ps")
        .args(["-eo", "pid,args"])
        .output()
        .ok()?;
    let ps_str = String::from_utf8_lossy(&ps_out.stdout);
    let ghostty_pid: u32 = ps_str
        .lines()
        .find(|l| l.to_lowercase().contains("ghostty") && !l.contains("grep"))?
        .trim()
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;

    // List all processes, find direct children of Ghostty on a TTY
    let ps_out = std::process::Command::new("ps")
        .args(["-eo", "pid,ppid,tty"])
        .output()
        .ok()?;
    let output = String::from_utf8_lossy(&ps_out.stdout);

    let mut children: Vec<(u32, String)> = Vec::new();
    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            if let (Ok(pid), Ok(ppid)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                if ppid == ghostty_pid && parts[2].starts_with("ttys") {
                    children.push((pid, format!("/dev/{}", parts[2])));
                }
            }
        }
    }

    // Sort by PID (ascending ≈ creation order ≈ window order)
    children.sort_by_key(|(pid, _)| *pid);

    // Find target TTY → 1-based index
    children
        .iter()
        .position(|(_, tty)| tty == tty_path)
        .map(|i| i + 1)
}

/// Raise a specific Ghostty window by index using System Events AXRaise.
/// Falls back to just activating Ghostty if the index can't be determined.
fn ghostty_raise_window(tty_path: Option<&str>) {
    let window_idx = tty_path.and_then(ghostty_tty_to_window_index);

    if let Some(idx) = window_idx {
        let script = format!(
            r#"tell application "Ghostty" to activate
             delay 0.1
             tell application "System Events"
                 tell process "Ghostty"
                     if (count of windows) ≥ {idx} then
                         perform action "AXRaise" of window {idx}
                     end if
                 end tell
             end tell"#,
            idx = idx
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
    } else {
        let _ = std::process::Command::new("osascript")
            .args(["-e", r#"tell application "Ghostty" to activate"#])
            .output();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_user_msg(text: &str) -> String {
        serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "text", "text": text }] },
            "timestamp": "2026-04-10T00:00:00Z"
        })
        .to_string()
    }

    fn make_assistant_text(text: &str, stop_reason: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": text }] },
            "stop_reason": stop_reason,
            "timestamp": "2026-04-10T00:00:01Z"
        })
        .to_string()
    }

    fn make_assistant_tool(tool_name: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "text", "text": "Let me check." },
                { "type": "tool_use", "name": tool_name, "input": {} }
            ] },
            "timestamp": "2026-04-10T00:00:01Z"
        })
        .to_string()
    }

    #[test]
    fn empty_content_returns_idle() {
        let (activity, tool) = derive_activity_from_content("");
        assert_eq!(activity, "idle");
        assert!(tool.is_none());
    }

    #[test]
    fn user_message_last_returns_waiting_input() {
        let content = format!(
            "{}\n{}\n{}",
            make_assistant_text("Hello", "end_turn"),
            make_user_msg("Please fix the bug"),
            "" // trailing
        );
        let (activity, _) = derive_activity_from_content(&content);
        assert_eq!(activity, "waiting_input");
    }

    #[test]
    fn assistant_with_read_tool_returns_reading() {
        let content = format!(
            "{}\n{}",
            make_user_msg("check file"),
            make_assistant_tool("Read")
        );
        let (activity, tool) = derive_activity_from_content(&content);
        assert_eq!(activity, "reading");
        assert_eq!(tool, Some("Read".to_string()));
    }

    #[test]
    fn assistant_with_bash_tool_returns_building() {
        let content = make_assistant_tool("Bash");
        let (activity, tool) = derive_activity_from_content(&content);
        assert_eq!(activity, "building");
        assert_eq!(tool, Some("Bash".to_string()));
    }

    #[test]
    fn assistant_with_write_tool_returns_writing() {
        let content = make_assistant_tool("Write");
        let (activity, _) = derive_activity_from_content(&content);
        assert_eq!(activity, "writing");
    }

    #[test]
    fn assistant_with_edit_tool_returns_writing() {
        let content = make_assistant_tool("Edit");
        let (activity, _) = derive_activity_from_content(&content);
        assert_eq!(activity, "writing");
    }

    #[test]
    fn assistant_with_grep_tool_returns_searching() {
        let content = make_assistant_tool("Grep");
        let (activity, _) = derive_activity_from_content(&content);
        assert_eq!(activity, "searching");
    }

    #[test]
    fn assistant_with_glob_tool_returns_searching() {
        let content = make_assistant_tool("Glob");
        let (activity, _) = derive_activity_from_content(&content);
        assert_eq!(activity, "searching");
    }

    #[test]
    fn assistant_with_agent_tool_returns_thinking() {
        let content = make_assistant_tool("Agent");
        let (activity, _) = derive_activity_from_content(&content);
        assert_eq!(activity, "thinking");
    }

    #[test]
    fn assistant_with_unknown_tool_returns_working() {
        let content = make_assistant_tool("CustomTool");
        let (activity, _) = derive_activity_from_content(&content);
        assert_eq!(activity, "working");
    }

    #[test]
    fn assistant_text_end_turn_returns_done() {
        let content = make_assistant_text("All done!", "end_turn");
        let (activity, tool) = derive_activity_from_content(&content);
        assert_eq!(activity, "done");
        assert!(tool.is_none());
    }

    #[test]
    fn assistant_text_no_stop_returns_thinking() {
        let content = make_assistant_text("Hmm let me think...", "");
        let (activity, _) = derive_activity_from_content(&content);
        assert_eq!(activity, "thinking");
    }

    #[test]
    fn invalid_json_lines_are_skipped() {
        let content = format!("not json\n{{\n{}", make_assistant_tool("Read"));
        let (activity, _) = derive_activity_from_content(&content);
        assert_eq!(activity, "reading");
    }

    #[test]
    fn multiple_messages_uses_last() {
        let content = format!(
            "{}\n{}\n{}",
            make_assistant_tool("Read"),
            make_assistant_tool("Bash"),
            make_assistant_tool("Write"),
        );
        let (activity, tool) = derive_activity_from_content(&content);
        assert_eq!(activity, "writing");
        assert_eq!(tool, Some("Write".to_string()));
    }

    #[test]
    fn tool_summary_bash() {
        let input = serde_json::json!({"command": "npm run build"});
        let summary = extract_tool_summary("Bash", Some(&input));
        assert_eq!(summary, "npm run build");
    }

    #[test]
    fn tool_summary_read() {
        let input = serde_json::json!({"file_path": "/src/main.rs"});
        let summary = extract_tool_summary("Read", Some(&input));
        assert_eq!(summary, "/src/main.rs");
    }

    #[test]
    fn tool_summary_grep() {
        let input = serde_json::json!({"pattern": "TODO"});
        let summary = extract_tool_summary("Grep", Some(&input));
        assert_eq!(summary, "/TODO/");
    }

    #[test]
    fn tool_summary_none_input() {
        let summary = extract_tool_summary("Bash", None);
        assert_eq!(summary, "");
    }
}
