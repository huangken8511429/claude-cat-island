use serde::{Deserialize, Serialize};
use std::fs;
use std::time::SystemTime;
use uuid::Uuid;

use crate::claude::monitor_dir;

// ── Data Model ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub conditions: RuleConditions,
    pub action: String, // "allow" | "deny"
    pub priority: i32,
    #[serde(rename = "created_at")]
    pub created_at: String, // ISO 8601
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleConditions {
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_pattern: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RulesConfig {
    pub version: u32,
    pub rules: Vec<ApprovalRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleMatchResult {
    pub matched: bool,
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub action: Option<String>, // "allow" | "deny" | null
}

// ── Helpers ──

fn now_iso8601() -> String {
    let dur = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    // Convert to UTC components
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Calculate year/month/day from days since epoch (1970-01-01)
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let leap = is_leap(y);
    let month_days: [i64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut m = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining < md {
            m = i;
            break;
        }
        remaining -= md;
    }
    let d = remaining + 1;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m + 1,
        d,
        hours,
        minutes,
        seconds
    )
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// ── Persistence ──

fn rules_path() -> std::path::PathBuf {
    monitor_dir().join("rules.json")
}

fn load_rules() -> Result<RulesConfig, String> {
    let path = rules_path();
    if !path.exists() {
        return Ok(RulesConfig {
            version: 1,
            rules: vec![],
        });
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read rules.json: {}", e))?;
    let config: RulesConfig =
        serde_json::from_str(&data).map_err(|e| format!("Failed to parse rules.json: {}", e))?;
    if config.version != 1 {
        return Ok(RulesConfig {
            version: 1,
            rules: vec![],
        });
    }
    Ok(config)
}

fn save_rules(config: &RulesConfig) -> Result<(), String> {
    let dir = monitor_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create monitor dir: {}", e))?;

    let path = rules_path();
    let temp_path = dir.join("rules.json.tmp");
    let json =
        serde_json::to_string_pretty(config).map_err(|e| format!("Failed to serialize rules: {}", e))?;
    fs::write(&temp_path, &json).map_err(|e| format!("Failed to write temp rules file: {}", e))?;
    fs::rename(&temp_path, &path).map_err(|e| format!("Failed to rename rules file: {}", e))?;
    Ok(())
}

// ── Preset Rule Sets ──

fn make_rule(name: &str, tool_name: &str, path_pattern: Option<&str>, command_pattern: Option<&str>, action: &str, priority: i32) -> ApprovalRule {
    ApprovalRule {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        enabled: true,
        conditions: RuleConditions {
            tool_name: tool_name.to_string(),
            path_pattern: path_pattern.map(|s| s.to_string()),
            command_pattern: command_pattern.map(|s| s.to_string()),
        },
        action: action.to_string(),
        priority,
        created_at: now_iso8601(),
    }
}

pub fn preset_safe_defaults() -> Vec<ApprovalRule> {
    vec![
        make_rule("Deny rm -rf", "Bash", None, Some("rm -rf"), "deny", 5),
        make_rule("Deny sudo", "Bash", None, Some("sudo "), "deny", 6),
        make_rule("Allow Read", "Read", None, None, "allow", 10),
        make_rule("Allow Grep", "Grep", None, None, "allow", 20),
        make_rule("Allow Glob", "Glob", None, None, "allow", 30),
        make_rule("Allow List (ls)", "Bash", None, Some("ls "), "allow", 40),
    ]
}

pub fn preset_permissive() -> Vec<ApprovalRule> {
    let mut rules = preset_safe_defaults();
    rules.extend(vec![
        make_rule("Allow Edit", "Edit", None, None, "allow", 50),
        make_rule("Allow Write", "Write", None, None, "allow", 60),
        make_rule("Allow npm", "Bash", None, Some("npm "), "allow", 70),
        make_rule("Allow git", "Bash", None, Some("git "), "allow", 80),
        make_rule("Allow npx", "Bash", None, Some("npx "), "allow", 90),
    ]);
    rules
}

pub fn preset_strict() -> Vec<ApprovalRule> {
    vec![
        make_rule("Deny rm -rf", "Bash", None, Some("rm -rf"), "deny", 5),
        make_rule("Deny sudo", "Bash", None, Some("sudo "), "deny", 6),
        make_rule("Allow Read", "Read", None, None, "allow", 10),
        make_rule("Allow Grep", "Grep", None, None, "allow", 20),
        make_rule("Allow Glob", "Glob", None, None, "allow", 30),
    ]
}

// ── Tauri Commands ──

#[tauri::command]
pub fn get_approval_rules() -> Result<Vec<ApprovalRule>, String> {
    let config = load_rules()?;
    let mut rules = config.rules;
    rules.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    Ok(rules)
}

#[tauri::command]
pub fn add_approval_rule(
    name: String,
    tool_name: String,
    path_pattern: Option<String>,
    command_pattern: Option<String>,
    action: String,
) -> Result<ApprovalRule, String> {
    // Validate
    if action != "allow" && action != "deny" {
        return Err(format!("Invalid action '{}': must be 'allow' or 'deny'", action));
    }
    if tool_name.is_empty() {
        return Err("tool_name must not be empty".to_string());
    }

    let mut config = load_rules()?;

    // Compute priority: max existing + 10, or 10 if none
    let max_priority = config.rules.iter().map(|r| r.priority).max().unwrap_or(0);
    let priority = max_priority + 10;

    let rule = ApprovalRule {
        id: Uuid::new_v4().to_string(),
        name,
        enabled: true,
        conditions: RuleConditions {
            tool_name,
            path_pattern: path_pattern.filter(|s| !s.is_empty()),
            command_pattern: command_pattern.filter(|s| !s.is_empty()),
        },
        action,
        priority,
        created_at: now_iso8601(),
    };

    config.rules.push(rule.clone());
    save_rules(&config)?;
    Ok(rule)
}

#[tauri::command]
pub fn update_approval_rule(
    id: String,
    name: Option<String>,
    enabled: Option<bool>,
    tool_name: Option<String>,
    path_pattern: Option<String>,
    command_pattern: Option<String>,
    action: Option<String>,
) -> Result<ApprovalRule, String> {
    let mut config = load_rules()?;

    let rule = config
        .rules
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or_else(|| format!("Rule with id '{}' not found", id))?;

    if let Some(n) = name {
        rule.name = n;
    }
    if let Some(e) = enabled {
        rule.enabled = e;
    }
    if let Some(tn) = tool_name {
        if tn.is_empty() {
            return Err("tool_name must not be empty".to_string());
        }
        rule.conditions.tool_name = tn;
    }
    // path_pattern: Some("") clears it, Some("val") sets it, None leaves unchanged
    if let Some(pp) = path_pattern {
        rule.conditions.path_pattern = if pp.is_empty() { None } else { Some(pp) };
    }
    // command_pattern: same clearing logic
    if let Some(cp) = command_pattern {
        rule.conditions.command_pattern = if cp.is_empty() { None } else { Some(cp) };
    }
    if let Some(a) = action {
        if a != "allow" && a != "deny" {
            return Err(format!("Invalid action '{}': must be 'allow' or 'deny'", a));
        }
        rule.action = a;
    }

    let updated = rule.clone();
    save_rules(&config)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_approval_rule(id: String) -> Result<bool, String> {
    let mut config = load_rules()?;
    let before = config.rules.len();
    config.rules.retain(|r| r.id != id);
    let deleted = config.rules.len() < before;
    if deleted {
        save_rules(&config)?;
    }
    Ok(deleted)
}

#[tauri::command]
pub fn reorder_approval_rules(ids: Vec<String>) -> Result<Vec<ApprovalRule>, String> {
    let mut config = load_rules()?;

    let mut ordered: Vec<ApprovalRule> = Vec::new();
    let mut priority = 10i32;

    // First: rules in the order specified by ids
    for id in &ids {
        if let Some(pos) = config.rules.iter().position(|r| &r.id == id) {
            let mut rule = config.rules.remove(pos);
            rule.priority = priority;
            priority += 10;
            ordered.push(rule);
        }
        // IDs not found are silently ignored
    }

    // Remaining rules not in ids list: append at the end
    for mut rule in config.rules.drain(..) {
        rule.priority = priority;
        priority += 10;
        ordered.push(rule);
    }

    config.rules = ordered;
    save_rules(&config)?;

    // Return sorted
    let mut result = config.rules;
    result.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    Ok(result)
}

// ── Path Normalization ──

fn normalize_path(path: &str, cwd: Option<&str>) -> String {
    let resolved = if !path.starts_with('/') {
        if let Some(base) = cwd {
            format!("{}/{}", base.trim_end_matches('/'), path)
        } else {
            path.to_string()
        }
    } else {
        path.to_string()
    };
    // Remove trailing slash
    let trimmed = resolved.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

// ── Glob Matching ──

/// Match a glob pattern against a path string.
///
/// Supported wildcards:
/// - `*`  matches any characters except `/`
/// - `**` matches any characters including `/` (any depth)
/// - `?`  matches any single character except `/`
/// - `[abc]` matches any single character in the set
///
/// If pattern is relative (no leading `/`), performs suffix matching:
/// the path is split by `/` and each suffix is tested.
/// If pattern is absolute (leading `/`), performs full matching.
fn glob_match(pattern: &str, path: &str) -> bool {
    if !pattern.starts_with('/') {
        // Suffix match: try matching from every `/`-delimited segment start
        let parts: Vec<&str> = path.split('/').collect();
        for i in 0..parts.len() {
            let candidate = parts[i..].join("/");
            if glob_match_full(pattern, &candidate) {
                return true;
            }
        }
        false
    } else {
        glob_match_full(pattern, path)
    }
}

/// Core glob matching — compares pattern against the entire input string.
/// Handles `**`, `*`, `?`, and `[...]` character classes.
fn glob_match_full(pattern: &str, text: &str) -> bool {
    let pat: Vec<char> = pattern.chars().collect();
    let txt: Vec<char> = text.chars().collect();
    glob_match_recursive(&pat, 0, &txt, 0)
}

fn glob_match_recursive(pat: &[char], pi: usize, txt: &[char], ti: usize) -> bool {
    let mut pi = pi;
    let mut ti = ti;

    while pi < pat.len() {
        if pi + 1 < pat.len() && pat[pi] == '*' && pat[pi + 1] == '*' {
            // `**` — matches any characters including `/`
            // Consume consecutive `*` and optional surrounding `/`
            let mut pj = pi;
            while pj < pat.len() && pat[pj] == '*' {
                pj += 1;
            }
            // Skip trailing `/` after `**`
            if pj < pat.len() && pat[pj] == '/' {
                pj += 1;
            }

            // `**` at end of pattern matches everything
            if pj >= pat.len() {
                return true;
            }

            // Try matching rest of pattern from every position in text
            for k in ti..=txt.len() {
                if glob_match_recursive(pat, pj, txt, k) {
                    return true;
                }
            }
            return false;
        } else if pat[pi] == '*' {
            // `*` — matches any characters except `/`
            // Try matching rest of pattern after consuming 0..N non-`/` chars
            let rest_pi = pi + 1;
            // Start from current position (0 chars consumed)
            let mut k = ti;
            loop {
                if glob_match_recursive(pat, rest_pi, txt, k) {
                    return true;
                }
                if k >= txt.len() || txt[k] == '/' {
                    break;
                }
                k += 1;
            }
            return false;
        } else if pat[pi] == '?' {
            // `?` — matches any single character except `/`
            if ti >= txt.len() || txt[ti] == '/' {
                return false;
            }
            pi += 1;
            ti += 1;
        } else if pat[pi] == '[' {
            // Character class `[abc]` or `[a-z]`
            if ti >= txt.len() {
                return false;
            }
            let ch = txt[ti];
            let mut pj = pi + 1;
            let mut matched = false;
            let negated = pj < pat.len() && (pat[pj] == '!' || pat[pj] == '^');
            if negated {
                pj += 1;
            }
            while pj < pat.len() && pat[pj] != ']' {
                if pj + 2 < pat.len() && pat[pj + 1] == '-' {
                    // Range: [a-z]
                    let lo = pat[pj];
                    let hi = pat[pj + 2];
                    if ch >= lo && ch <= hi {
                        matched = true;
                    }
                    pj += 3;
                } else {
                    if ch == pat[pj] {
                        matched = true;
                    }
                    pj += 1;
                }
            }
            if pj >= pat.len() {
                // Malformed: no closing `]`
                return false;
            }
            if negated {
                matched = !matched;
            }
            if !matched {
                return false;
            }
            pi = pj + 1; // skip past `]`
            ti += 1;
        } else {
            // Literal character
            if ti >= txt.len() || pat[pi] != txt[ti] {
                return false;
            }
            pi += 1;
            ti += 1;
        }
    }

    // Pattern consumed — text must also be consumed
    pi >= pat.len() && ti >= txt.len()
}

// ── Rule Matching Engine ──

pub fn match_rules(
    rules: &[ApprovalRule],
    tool_name: &str,
    tool_input: &serde_json::Value,
    cwd: Option<&str>,
) -> RuleMatchResult {
    // 1. Filter enabled rules
    let mut active: Vec<&ApprovalRule> = rules.iter().filter(|r| r.enabled).collect();

    // 2. Sort by priority ascending, then created_at ascending as tiebreaker
    active.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });

    // 3. Evaluate each rule — first match wins
    for rule in &active {
        let conds = &rule.conditions;

        // 3a. Tool name match
        if conds.tool_name != "*" && conds.tool_name != tool_name {
            continue;
        }

        // 3b. Path pattern match (if present)
        if let Some(ref path_pattern) = conds.path_pattern {
            // Extract path from tool_input: try file_path first, then path
            let target_path = tool_input
                .get("file_path")
                .and_then(|v| v.as_str())
                .or_else(|| tool_input.get("path").and_then(|v| v.as_str()));

            match target_path {
                None => continue, // Rule requires path but tool doesn't have one
                Some(raw_path) => {
                    let resolved = normalize_path(raw_path, cwd);
                    if !glob_match(path_pattern, &resolved) {
                        continue;
                    }
                }
            }
        }

        // 3c. Command pattern match (if present, Bash only)
        if let Some(ref command_pattern) = conds.command_pattern {
            if tool_name != "Bash" {
                continue; // Command pattern only applies to Bash
            }
            let command = tool_input
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !command.contains(command_pattern.as_str()) {
                continue;
            }
        }

        // All conditions matched — first match wins
        return RuleMatchResult {
            matched: true,
            rule_id: Some(rule.id.clone()),
            rule_name: Some(rule.name.clone()),
            action: Some(rule.action.clone()),
        };
    }

    // No rule matched
    RuleMatchResult {
        matched: false,
        rule_id: None,
        rule_name: None,
        action: None,
    }
}

// ── check_rule_match Tauri Command ──

#[tauri::command]
pub fn check_rule_match(
    tool_name: String,
    tool_input: serde_json::Value,
    cwd: Option<String>,
) -> Result<RuleMatchResult, String> {
    let config = load_rules()?;
    let result = match_rules(
        &config.rules,
        &tool_name,
        &tool_input,
        cwd.as_deref(),
    );
    Ok(result)
}

#[tauri::command]
pub fn import_preset_rules(preset: String) -> Result<Vec<ApprovalRule>, String> {
    let preset_rules = match preset.as_str() {
        "safe_defaults" => preset_safe_defaults(),
        "permissive" => preset_permissive(),
        "strict" => preset_strict(),
        _ => return Err(format!("Unknown preset '{}': must be 'safe_defaults', 'permissive', or 'strict'", preset)),
    };

    let mut config = load_rules()?;

    // Collect existing rule names to skip duplicates
    let existing_names: std::collections::HashSet<String> =
        config.rules.iter().map(|r| r.name.clone()).collect();

    // Compute next priority
    let mut next_priority = config.rules.iter().map(|r| r.priority).max().unwrap_or(0) + 10;

    for mut rule in preset_rules {
        if existing_names.contains(&rule.name) {
            continue; // Skip rules with same name
        }
        rule.priority = next_priority;
        next_priority += 10;
        config.rules.push(rule);
    }

    save_rules(&config)?;

    // Return sorted
    let mut result = config.rules;
    result.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    Ok(result)
}
