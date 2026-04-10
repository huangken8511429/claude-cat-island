import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ClaudeSession, TranscriptMessage, CatState } from "../types";
import CatLogo from "./CatLogo";
import QuickReply from "./QuickReply";

interface Props {
  session: ClaudeSession;
  themeIndex?: number;
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

export default function SessionDetail({ session, themeIndex, onBack }: Props) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const msgs = await invoke<TranscriptMessage[]>("get_session_transcript", {
          sessionId: session.sessionId,
          cwd: session.cwd,
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
      </div>

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
