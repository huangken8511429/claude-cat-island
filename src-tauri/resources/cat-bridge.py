#!/usr/bin/env python3
"""
Claude Cat Monitor — Unix socket bridge.

Called by Claude Code hooks. Reads hook event JSON from stdin,
forwards it to the Tauri backend via a Unix domain socket at
/tmp/claude-cat-monitor.sock.

Also maintains backward-compatible file-based outputs:
  - ~/.claude-cat-monitor/events.jsonl   (event log)
  - ~/.claude-cat-monitor/latest-notification.json
"""

import json
import os
import socket
import subprocess
import sys
import time

SOCKET_PATH = "/tmp/claude-cat-monitor.sock"
MONITOR_DIR = os.path.expanduser("~/.claude-cat-monitor")
EVENTS_FILE = os.path.join(MONITOR_DIR, "events.jsonl")
NOTIF_FILE = os.path.join(MONITOR_DIR, "latest-notification.json")
RULES_FILE = os.path.join(MONITOR_DIR, "rules.json")

# Events that get logged to events.jsonl
LOGGED_EVENTS = {"Stop", "Notification", "SessionStart", "SessionEnd", "PermissionRequest"}

# Max lines to keep in events.jsonl
MAX_EVENTS_LINES = 200
TRIM_TO = 100


def ensure_dir():
    os.makedirs(MONITOR_DIR, exist_ok=True)


def read_stdin() -> str:
    """Read all of stdin (hook input JSON)."""
    try:
        return sys.stdin.read()
    except Exception:
        return "{}"


def send_to_socket(payload: dict) -> bool:
    """Send JSON payload to the Unix socket. Returns True on success."""
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2)
        sock.connect(SOCKET_PATH)
        sock.sendall(json.dumps(payload).encode("utf-8"))
        sock.close()
        return True
    except Exception:
        return False


def write_event_log(event: str, ts: int, data: dict):
    """Append event to events.jsonl and trim if too large."""
    if event not in LOGGED_EVENTS:
        return
    ensure_dir()
    line = json.dumps({"event": event, "ts": ts, "data": data}, separators=(",", ":"))
    with open(EVENTS_FILE, "a") as f:
        f.write(line + "\n")

    # Trim file if too large
    try:
        with open(EVENTS_FILE, "r") as f:
            lines = f.readlines()
        if len(lines) > MAX_EVENTS_LINES:
            with open(EVENTS_FILE, "w") as f:
                f.writelines(lines[-TRIM_TO:])
    except Exception:
        pass


def write_notification(event: str, ts: int, data: dict):
    """Write latest-notification.json and fire macOS notification."""
    if event not in ("Stop", "Notification"):
        return

    cwd = data.get("cwd", "")
    project = os.path.basename(cwd) if cwd else "Claude"

    if event == "Stop":
        msg = data.get("last_assistant_message", "Task complete")
    else:
        msg = data.get("message", "Waiting for input")

    # Sanitize: collapse newlines, limit length
    msg_safe = " ".join(str(msg).split())[:200]

    ensure_dir()
    notif = {"event": event, "ts": ts, "project": project, "message": msg_safe}
    with open(NOTIF_FILE, "w") as f:
        json.dump(notif, f)

    # macOS system notification (fire and forget)
    preview = msg_safe[:120]
    script = f'display notification "{preview}" with title "\U0001f431 {project}" sound name "Ping"'
    try:
        subprocess.Popen(
            ["/usr/bin/osascript", "-e", script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


def _respond_allow(message=""):
    """Print allow response and exit. Used by flag file and rule engine."""
    resp = {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "allow"},
        }
    }
    if message:
        resp["hookSpecificOutput"]["decision"]["message"] = message
    print(json.dumps(resp))
    sys.exit(0)


def _respond_deny(message=""):
    """Print deny response and exit. Used by rule engine."""
    resp = {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "deny", "message": message},
        }
    }
    print(json.dumps(resp))
    sys.exit(0)


def _load_rules():
    """Load enabled rules from rules.json, sorted by priority.

    Returns a list of enabled rule dicts sorted by (priority, created_at),
    or None if the file doesn't exist, is malformed, or has wrong version.
    Any error is swallowed (fail-open).
    """
    try:
        with open(RULES_FILE, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("version") != 1:
            return None
        rules = data.get("rules", [])
        active = [r for r in rules if isinstance(r, dict) and r.get("enabled", False)]
        if not active:
            return None
        active.sort(key=lambda r: (r.get("priority", 99999), r.get("created_at", "")))
        return active
    except Exception:
        return None


def _match_rules(rules, data):
    """Evaluate rules against a PermissionRequest. First match wins.

    Returns {"action": "allow"|"deny", "name": rule_name} or None.
    """
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    if not isinstance(tool_input, dict):
        tool_input = {}
    cwd = data.get("cwd", "")

    for rule in rules:
        conditions = rule.get("conditions", {})

        # 1. Tool name match
        rule_tool = conditions.get("tool_name", "")
        if rule_tool != "*" and rule_tool != tool_name:
            continue

        # 2. Path pattern match (optional condition)
        path_pattern = conditions.get("path_pattern")
        if path_pattern:
            target_path = tool_input.get("file_path") or tool_input.get("path")
            if not target_path:
                continue  # Rule requires path but tool doesn't have one
            # Resolve relative paths using cwd
            if not target_path.startswith("/") and cwd:
                target_path = os.path.join(cwd, target_path)
            # Remove trailing slash
            target_path = target_path.rstrip("/")
            if not _glob_match(path_pattern, target_path):
                continue

        # 3. Command pattern match (optional, Bash only)
        command_pattern = conditions.get("command_pattern")
        if command_pattern:
            if tool_name != "Bash":
                continue  # Command pattern only applies to Bash
            command = tool_input.get("command", "")
            if command_pattern not in command:
                continue

        # All conditions matched — first match wins
        return {"action": rule.get("action", ""), "name": rule.get("name", "")}

    return None  # No rule matched


def _glob_match(pattern, path):
    """Glob match where '*' does NOT match '/' and '**' matches anything.

    - Relative pattern (no leading '/') → suffix match against path segments.
    - Absolute pattern (leading '/') → full match.
    - Supports '*', '**', '?', '[abc]', '[a-z]'.
    """
    if not pattern.startswith("/"):
        # Suffix match: try from every segment start
        parts = path.split("/")
        for i in range(len(parts)):
            candidate = "/".join(parts[i:])
            if _glob_match_full(pattern, candidate):
                return True
        return False
    else:
        return _glob_match_full(pattern, path)


def _glob_match_full(pattern, text):
    """Core glob matching — full string match with **, *, ?, [...]."""
    return _glob_match_recursive(pattern, 0, text, 0)


def _glob_match_recursive(pat, pi, txt, ti):
    """Recursive glob matcher. Mirrors the Rust glob_match_recursive."""
    while pi < len(pat):
        # Check for '**'
        if pi + 1 < len(pat) and pat[pi] == "*" and pat[pi + 1] == "*":
            # Consume consecutive '*'
            pj = pi
            while pj < len(pat) and pat[pj] == "*":
                pj += 1
            # Skip trailing '/' after '**'
            if pj < len(pat) and pat[pj] == "/":
                pj += 1
            # '**' at end matches everything
            if pj >= len(pat):
                return True
            # Try matching rest from every position in text
            for k in range(ti, len(txt) + 1):
                if _glob_match_recursive(pat, pj, txt, k):
                    return True
            return False

        elif pat[pi] == "*":
            # '*' matches any characters except '/'
            rest_pi = pi + 1
            k = ti
            while True:
                if _glob_match_recursive(pat, rest_pi, txt, k):
                    return True
                if k >= len(txt) or txt[k] == "/":
                    break
                k += 1
            return False

        elif pat[pi] == "?":
            # '?' matches any single character except '/'
            if ti >= len(txt) or txt[ti] == "/":
                return False
            pi += 1
            ti += 1

        elif pat[pi] == "[":
            # Character class [abc] or [a-z]
            if ti >= len(txt):
                return False
            ch = txt[ti]
            pj = pi + 1
            matched = False
            negated = pj < len(pat) and pat[pj] in ("!", "^")
            if negated:
                pj += 1
            while pj < len(pat) and pat[pj] != "]":
                if pj + 2 < len(pat) and pat[pj + 1] == "-":
                    # Range: [a-z]
                    lo = pat[pj]
                    hi = pat[pj + 2]
                    if lo <= ch <= hi:
                        matched = True
                    pj += 3
                else:
                    if ch == pat[pj]:
                        matched = True
                    pj += 1
            if pj >= len(pat):
                # Malformed: no closing ']'
                return False
            if negated:
                matched = not matched
            if not matched:
                return False
            pi = pj + 1  # skip past ']'
            ti += 1

        else:
            # Literal character
            if ti >= len(txt) or pat[pi] != txt[ti]:
                return False
            pi += 1
            ti += 1

    # Pattern consumed — text must also be consumed
    return pi >= len(pat) and ti >= len(txt)


def handle_permission_request(data: dict):
    """Auto-approve via flag file, then evaluate rules.json, else pass through."""
    # 1. Existing flag file check (backward compat, highest priority)
    flag = os.path.join(MONITOR_DIR, "auto-approve")
    if os.path.isfile(flag):
        _respond_allow()
        # _respond_allow calls sys.exit(0), never returns

    # 2. Rule engine matching (fail-open: any error → pass through to approval server)
    try:
        rules = _load_rules()
        if rules:
            result = _match_rules(rules, data)
            if result is not None:
                action = result["action"]
                rule_name = result["name"]
                if action == "allow":
                    _respond_allow("Auto-approved by rule: {}".format(rule_name))
                elif action == "deny":
                    _respond_deny("Auto-denied by rule: {}".format(rule_name))
    except Exception:
        pass  # Fail-open: any error → don't intercept, let approval server handle


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else "Unknown"
    raw = read_stdin()
    ts = int(time.time())

    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        data = {}

    # 1. Auto-approve check (must happen before socket send)
    if event == "PermissionRequest":
        handle_permission_request(data)

    # 2. Send to Unix socket (real-time push to Tauri backend)
    payload = {
        "event": event,
        "ts": ts,
        "session_id": data.get("session_id", ""),
        "data": data,
    }
    send_to_socket(payload)

    # 3. Write to file-based logs (backward compat / fallback)
    write_event_log(event, ts, data)
    write_notification(event, ts, data)


if __name__ == "__main__":
    main()
