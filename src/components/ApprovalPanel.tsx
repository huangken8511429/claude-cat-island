import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import Lottie from "lottie-react";
import blackCatAnimation from "../assets/animated-black-cat.json";
import CatLogo from "./CatLogo";

interface PendingApproval {
  id: string;
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  suggestions: unknown[];
  cwd?: string;
  received_at: number;
}

function summarize(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return `$ ${toolInput.command ?? "unknown"}`;
    case "Write":
      return `Write ${toolInput.file_path ?? "unknown"}`;
    case "Edit":
      return `Edit ${toolInput.file_path ?? "unknown"}`;
    case "Read":
      return `Read ${toolInput.file_path ?? "unknown"}`;
    case "Grep":
      return `Grep "${toolInput.pattern ?? ""}"`;
    case "Glob":
      return `Glob ${toolInput.pattern ?? "*"}`;
    default:
      return `${toolName}`;
  }
}

function getToolDetail(toolName: string, toolInput: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Bash":
      return toolInput.command as string | null;
    case "Write":
    case "Edit":
    case "Read":
      return toolInput.file_path as string | null;
    default:
      return null;
  }
}

function timeSince(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s`;
  return `${Math.floor(diff / 60)}m`;
}

export default function ApprovalPanel() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [resolving, setResolving] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<PendingApproval[]>("get_pending_approvals");
      setApprovals(result);
    } catch {
      // Server not ready yet
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleResolve = async (id: string, behavior: "allow" | "deny") => {
    setResolving((prev) => new Set(prev).add(id));
    try {
      await invoke("resolve_approval", {
        id,
        behavior,
        message: behavior === "deny" ? "Denied from Cat Monitor" : null,
      });
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      console.error("Failed to resolve:", err);
    } finally {
      setResolving((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (approvals.length === 0) {
    return (
      <div className="panel approval-panel">
        <h2 className="panel-title">APPROVALS</h2>
        <div className="empty-state">
          <Lottie
            animationData={blackCatAnimation}
            loop={true}
            style={{ width: 120, height: 120 }}
          />
          <p>No pending approvals</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel approval-panel">
      <h2 className="panel-title">
        APPROVALS <span className="badge approval-badge">{approvals.length}</span>
      </h2>
      <div className="approval-list">
        {approvals.map((approval) => {
          const isResolving = resolving.has(approval.id);
          const detail = getToolDetail(approval.tool_name, approval.tool_input);
          const project = approval.cwd?.split("/").pop() || "";

          return (
            <div key={approval.id} className="approval-card">
              <div className="approval-header">
                <CatLogo state="idle" size={16} />
                <span className="approval-tool">{approval.tool_name}</span>
                {project && <span className="approval-project">{project}</span>}
                <span className="approval-time">{timeSince(approval.received_at)}</span>
              </div>
              <div className="approval-summary">{summarize(approval.tool_name, approval.tool_input)}</div>
              {detail && approval.tool_name === "Bash" && (
                <div className="approval-detail">
                  <code>{detail}</code>
                </div>
              )}
              <div className="approval-actions">
                <button
                  className="approval-btn deny"
                  disabled={isResolving}
                  onClick={() => handleResolve(approval.id, "deny")}
                >
                  Deny
                </button>
                <button
                  className="approval-btn allow"
                  disabled={isResolving}
                  onClick={() => handleResolve(approval.id, "allow")}
                >
                  Allow
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
