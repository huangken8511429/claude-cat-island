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


def handle_permission_request(data: dict):
    """Auto-approve if flag file exists."""
    flag = os.path.join(MONITOR_DIR, "auto-approve")
    if os.path.isfile(flag):
        resp = {
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior": "allow"},
            }
        }
        print(json.dumps(resp))
        sys.exit(0)


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
