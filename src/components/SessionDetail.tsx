import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ClaudeSession, TranscriptMessage, CatState } from "../types";
import CatLogo from "./CatLogo";
import QuickReply from "./QuickReply";

interface Props {
  session: ClaudeSession;
  sessions: ClaudeSession[];
  themeIndex?: number;
  onSelectSession: (session: ClaudeSession) => void;
  onBack: () => void;
}

function getState(session: ClaudeSession): CatState {
  if (!session.isAlive) return "done";
  if (session.kind === "interactive") return "working";
  return "idle";
}

function getProjectName(cwd: string): string {
  return cwd.split("/").pop() || cwd;
}

const TOOL_ICONS: Record<string, string> = {
  Read: "R",
  Write: "W",
  Edit: "E",
  Bash: "$",
  Grep: "?",
  Glob: "*",
  Agent: "A",
  Skill: "S",
};

async function handleJump(pid: number) {
  try {
    await invoke("jump_to_session", { pid });
  } catch (err) {
    console.error("Jump failed:", err);
  }
}

export default function SessionDetail({ session, sessions, themeIndex, onSelectSession, onBack }: Props) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const otherSessions = sessions.filter((item) => item.sessionId !== session.sessionId);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setMessages([]);

    const load = async () => {
      try {
        const msgs = await invoke<TranscriptMessage[]>("get_session_transcript", {
          sessionId: session.sessionId,
          cwd: session.cwd,
          provider: session.provider ?? "claude",
        });
        if (!cancelled) {
          setMessages(msgs);
          setLoading(false);
        }
      } catch (err) {
        console.error("Failed to load transcript:", err);
        if (!cancelled) setLoading(false);
      }
    };

    load();
    // Auto-refresh for live sessions
    const interval = session.isAlive ? setInterval(load, 5000) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [session.sessionId, session.cwd, session.isAlive]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const state = getState(session);

  return (
    <div className="panel session-detail">
      {/* Compact Header — single row */}
      <div className="detail-header-compact">
        <button className="back-btn-compact" onClick={onBack} aria-label="Go back">←</button>
        <CatLogo state={state} size={18} themeIndex={themeIndex} />
        <span className="detail-project-compact">{getProjectName(session.cwd)}</span>
        <span className={`status-dot ${state}`} />
        <span className="detail-state-compact">{state.toUpperCase()}</span>
        {otherSessions.length > 0 && (
          <button
            className={`detail-switch-btn ${showSwitcher ? "active" : ""}`}
            onClick={() => setShowSwitcher((prev) => !prev)}
            aria-expanded={showSwitcher}
            aria-label="Open session switcher"
          >
            JUMP TO
          </button>
        )}
      </div>

      {showSwitcher && otherSessions.length > 0 && (
        <div className="session-switcher">
          <div className="session-switcher-header">
            <span className="session-switcher-title">Switch Session</span>
            <span className="session-switcher-hint">Jump or open another live thread without backing out.</span>
          </div>
          <div className="session-switcher-list">
            {otherSessions.map((candidate) => (
              <div key={candidate.sessionId} className="session-switcher-item">
                <div className="session-switcher-info">
                  <span className="session-switcher-project">{getProjectName(candidate.cwd)}</span>
                  <span className="session-switcher-meta">
                    {candidate.isAlive ? candidate.kind.toUpperCase() : "DONE"}
                    <span className="sep">|</span>
                    {candidate.sessionId.slice(0, 8)}
                  </span>
                </div>
                <div className="session-switcher-actions">
                  <button
                    className="session-switcher-btn"
                    onClick={() => {
                      onSelectSession(candidate);
                      setShowSwitcher(false);
                    }}
                  >
                    OPEN
                  </button>
                  {candidate.isAlive ? (
                    <button
                      className="session-switcher-btn accent"
                      onClick={() => handleJump(candidate.pid)}
                    >
                      JUMP
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conversation */}
      <div className="transcript">
        {loading && <div className="empty-state">Loading transcript...</div>}
        {!loading && messages.length === 0 && (
          <div className="empty-state">No messages</div>
        )}
        {messages.map((msg, i) => {
          if (msg.role === "tool") {
            return (
              <div key={i} className="msg msg-tool">
                <span className="tool-icon" aria-hidden="true">
                  {TOOL_ICONS[msg.toolName || ""] || "T"}
                </span>
                <span className="tool-name">{msg.toolName}</span>
                {msg.toolInput && (
                  <span className="tool-input">{msg.toolInput}</span>
                )}
              </div>
            );
          }
          return (
            <div key={i} className={`msg msg-${msg.role}`}>
              <div className="msg-role">
                {msg.role === "user" ? "YOU" : "CLAUDE"}
              </div>
              <div className="msg-text">{msg.text}</div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input box at bottom — send to terminal */}
      {session.isAlive && (
        <QuickReply pid={session.pid} />
      )}
    </div>
  );
}
