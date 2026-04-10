import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ClaudeSession, CatState, SessionPendingState, TranscriptMessage, PendingApproval } from "../types";
import PixelCat from "./PixelCat";
import CatLogo from "./CatLogo";
import SessionDetail from "./SessionDetail";
import QuickReply from "./QuickReply";

interface Props {
  sessions: ClaudeSession[];
  pendingStates: SessionPendingState[];
  pendingApprovals: PendingApproval[];
  onResolveApproval: (id: string, behavior: "allow" | "deny") => void;
  onDetailChange?: (inDetail: boolean) => void;
}

function getState(
  session: ClaudeSession,
  pending?: SessionPendingState,
  lastMsg?: TranscriptMessage,
): CatState {
  if (!session.isAlive) return "done";

  // Approval pending > 60s → anxious
  if (pending?.pending === "needs_approval") {
    const waitSec = (Date.now() - (pending.ts || 0)) / 1000;
    return waitSec > 60 ? "anxious" : "idle";
  }

  // Check last message for error keywords → scared
  if (lastMsg?.role === "assistant" && lastMsg.text) {
    const lower = lastMsg.text.toLowerCase();
    if (lower.includes("error") || lower.includes("failed") || lower.includes("fail") || lower.includes("panic")) {
      return "scared";
    }
  }

  // Long idle → yawning (5 min since session start with no recent message)
  if (session.kind === "interactive") return "working";
  return "idle";
}

function getProjectName(cwd: string): string {
  return cwd.split("/").pop() || cwd;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(startedAt: number): string {
  const diff = Date.now() - startedAt;
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

function truncateText(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen) + "…";
}

async function handleJump(pid: number) {
  try {
    await invoke("jump_to_session", { pid });
  } catch (err) {
    console.error("Jump failed:", err);
  }
}

function summarizeApproval(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return `$ ${toolInput.command ?? ""}`;
    case "Write":
      return `Write ${toolInput.file_path ?? ""}`;
    case "Edit":
      return `Edit ${toolInput.file_path ?? ""}`;
    default:
      return toolName;
  }
}

export default function SessionPanel({ sessions, pendingStates, pendingApprovals, onResolveApproval, onDetailChange }: Props) {
  const [selected, setSelected] = useState<{ session: ClaudeSession; index: number } | null>(null);
  const [lastMessages, setLastMessages] = useState<Record<string, TranscriptMessage>>({});

  const fetchLastMessages = useCallback(async () => {
    const results: Record<string, TranscriptMessage> = {};
    await Promise.all(
      sessions.map(async (s) => {
        try {
          const msg = await invoke<TranscriptMessage | null>("get_session_last_message", {
            sessionId: s.sessionId,
            cwd: s.cwd,
          });
          if (msg) results[s.sessionId] = msg;
        } catch { /* ignore */ }
      })
    );
    setLastMessages(results);
  }, [sessions]);

  useEffect(() => {
    fetchLastMessages();
    const interval = setInterval(fetchLastMessages, 4000);
    return () => clearInterval(interval);
  }, [fetchLastMessages]);

  if (selected) {
    return (
      <SessionDetail
        session={selected.session}
        themeIndex={selected.index}
        onBack={() => { setSelected(null); onDetailChange?.(false); }}
      />
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="panel session-panel">
        <h2 className="panel-title">SESSIONS</h2>
        <div className="empty-state">
          <PixelCat state="sleeping" size={3} themeIndex={0} />
          <p>No active sessions</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel session-panel">
      <h2 className="panel-title">
        SESSIONS <span className="badge">{sessions.length}</span>
      </h2>
      <div className="session-grid">
        {sessions.map((session, i) => {
          const pending = pendingStates.find((ps) => ps.session_id === session.sessionId);
          const lastMsg = lastMessages[session.sessionId];
          const state = getState(session, pending, lastMsg);
          const isApproval = pending?.pending === "needs_approval" && session.isAlive;
          const isWaiting = pending?.pending === "waiting_input" && session.isAlive;
          return (
            <div
              key={session.sessionId}
              className={`session-card state-${state} ${isApproval ? "state-attention" : ""} ${isWaiting ? "state-waiting" : ""} clickable`}
              role="button"
              tabIndex={0}
              onClick={() => { setSelected({ session, index: i }); onDetailChange?.(true); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected({ session, index: i }); onDetailChange?.(true);
                }
              }}
            >
              <CatLogo state={state} size={20} themeIndex={i} />
              <div className="session-info">
                <div className="session-project">
                  {getProjectName(session.cwd)}
                  {isApproval && <span className="pending-badge approve">APPROVE</span>}
                  {isWaiting && <span className="pending-badge ask">ASK</span>}
                </div>
                <div className="session-meta">
                  <span className={`status-dot ${state}`} />
                  <span>{isApproval ? "NEEDS APPROVAL" : isWaiting ? "WAITING INPUT" : state.toUpperCase()}</span>
                  {pending?.tool_name && (
                    <>
                      <span className="sep">|</span>
                      <span className="pending-tool">{pending.tool_name}</span>
                    </>
                  )}
                  <span className="sep">|</span>
                  <span>{formatTime(session.startedAt)}</span>
                  <span className="sep">|</span>
                  <span>{formatDuration(session.startedAt)}</span>
                </div>
                {lastMsg && (
                  <div className={`session-last-msg role-${lastMsg.role}`}>
                    <span className="last-msg-role">{lastMsg.role === "user" ? "YOU" : "CLAUDE"}</span>
                    <span className="last-msg-text">{truncateText(lastMsg.text, 120)}</span>
                  </div>
                )}
              </div>
              {(isApproval || isWaiting) && (
                <button
                  className={`jump-btn ${isApproval ? "approve" : "ask"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleJump(session.pid);
                  }}
                  title="Jump to terminal"
                >
                  JUMP
                </button>
              )}
              <div className="session-arrow">▸</div>
              {isApproval && pendingApprovals.filter(a => a.sessionId === session.sessionId).length > 0 && (
                <div className="inline-approval" onClick={(e) => e.stopPropagation()}>
                  {pendingApprovals.filter(a => a.sessionId === session.sessionId).map((a) => (
                    <div key={a.id} className="inline-approval-item">
                      <div className="inline-approval-summary">
                        {summarizeApproval(a.toolName, a.toolInput)}
                      </div>
                      {a.toolName === "Bash" && typeof a.toolInput.command === "string" && (
                        <div className="inline-approval-detail">
                          <code>{String(a.toolInput.command).slice(0, 120)}</code>
                        </div>
                      )}
                      <div className="inline-approval-actions">
                        <button
                          className="inline-approval-btn deny"
                          onClick={() => onResolveApproval(a.id, "deny")}
                        >DENY</button>
                        <button
                          className="inline-approval-btn allow"
                          onClick={() => onResolveApproval(a.id, "allow")}
                        >ALLOW</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {isWaiting && (
                <QuickReply pid={session.pid} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
