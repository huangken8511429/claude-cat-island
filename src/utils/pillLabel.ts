import type { SessionActivity, SessionActivityInfo, SessionPendingState, ClaudeSession } from "../types";

const ACTIVITY_LABELS: Record<SessionActivity, string> = {
  reading: "Reading...",
  writing: "Writing...",
  building: "Building...",
  searching: "Searching...",
  thinking: "Thinking...",
  waiting_input: "Waiting input",
  waiting_approval: "Needs approval",
  idle: "Working...",
  done: "Done",
};

export function activityLabel(
  sessionId: string,
  activities: Record<string, SessionActivityInfo>,
): string {
  const a = activities[sessionId];
  if (!a) return "Working...";
  return ACTIVITY_LABELS[a.activity as SessionActivity] ?? "Working...";
}

export function getPillLabel(
  aliveSessions: ClaudeSession[],
  needsAttention: SessionPendingState[],
  waitingInput: SessionPendingState[],
  activities: Record<string, SessionActivityInfo>,
  rotateIdx: number,
): string {
  if (needsAttention.length > 0) return `${needsAttention.length} APPROVE`;
  if (waitingInput.length > 0) return `${waitingInput.length} ASK`;
  if (aliveSessions.length === 0) return "idle";
  if (aliveSessions.length === 1) return activityLabel(aliveSessions[0].sessionId, activities);
  // Multi-session: rotate
  const idx = rotateIdx % aliveSessions.length;
  const s = aliveSessions[idx];
  const proj = s.cwd.split("/").pop() || "session";
  return `${proj}: ${activityLabel(s.sessionId, activities)}`;
}
