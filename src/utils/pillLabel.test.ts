import { describe, it, expect } from "vitest";
import { activityLabel, getPillLabel } from "./pillLabel";
import type { ClaudeSession, SessionActivityInfo, SessionPendingState } from "../types";

function makeSession(id: string, cwd: string, alive = true): ClaudeSession {
  return {
    pid: 1000,
    sessionId: id,
    cwd,
    startedAt: Date.now(),
    kind: "interactive",
    entrypoint: "cli",
    isAlive: alive,
  };
}

function makePending(sessionId: string, pending: string): SessionPendingState {
  return { session_id: sessionId, pending, tool_name: "", message: "", ts: Date.now() };
}

describe("activityLabel", () => {
  it("returns activity text when info exists", () => {
    const activities: Record<string, SessionActivityInfo> = {
      "s1": { sessionId: "s1", activity: "reading", toolName: "Read" },
    };
    expect(activityLabel("s1", activities)).toBe("Reading...");
  });

  it("returns 'Working...' when no info for session", () => {
    expect(activityLabel("unknown", {})).toBe("Working...");
  });

  it("maps all known activities", () => {
    const cases: [string, string][] = [
      ["reading", "Reading..."],
      ["writing", "Writing..."],
      ["building", "Building..."],
      ["searching", "Searching..."],
      ["thinking", "Thinking..."],
      ["waiting_input", "Waiting input"],
      ["waiting_approval", "Needs approval"],
      ["done", "Done"],
    ];
    for (const [activity, expected] of cases) {
      const a: Record<string, SessionActivityInfo> = {
        "s": { sessionId: "s", activity: activity as any, toolName: null },
      };
      expect(activityLabel("s", a)).toBe(expected);
    }
  });
});

describe("getPillLabel", () => {
  it("returns 'idle' when no sessions", () => {
    expect(getPillLabel([], [], [], {}, 0)).toBe("idle");
  });

  it("returns APPROVE when needs attention", () => {
    const sessions = [makeSession("s1", "/a/proj")];
    const attention = [makePending("s1", "needs_approval")];
    expect(getPillLabel(sessions, attention, [], {}, 0)).toBe("1 APPROVE");
  });

  it("returns ASK when waiting input", () => {
    const sessions = [makeSession("s1", "/a/proj")];
    const waiting = [makePending("s1", "waiting_input")];
    expect(getPillLabel(sessions, [], waiting, {}, 0)).toBe("1 ASK");
  });

  it("APPROVE takes priority over ASK", () => {
    const sessions = [makeSession("s1", "/a/proj")];
    const attention = [makePending("s1", "needs_approval")];
    const waiting = [makePending("s1", "waiting_input")];
    expect(getPillLabel(sessions, attention, waiting, {}, 0)).toBe("1 APPROVE");
  });

  it("returns activity for single session", () => {
    const sessions = [makeSession("s1", "/a/proj")];
    const activities: Record<string, SessionActivityInfo> = {
      "s1": { sessionId: "s1", activity: "building", toolName: "Bash" },
    };
    expect(getPillLabel(sessions, [], [], activities, 0)).toBe("Building...");
  });

  it("rotates through sessions for multi-session", () => {
    const sessions = [
      makeSession("s1", "/a/proj-a"),
      makeSession("s2", "/b/proj-b"),
    ];
    const activities: Record<string, SessionActivityInfo> = {
      "s1": { sessionId: "s1", activity: "reading", toolName: "Read" },
      "s2": { sessionId: "s2", activity: "building", toolName: "Bash" },
    };

    expect(getPillLabel(sessions, [], [], activities, 0)).toBe("proj-a: Reading...");
    expect(getPillLabel(sessions, [], [], activities, 1)).toBe("proj-b: Building...");
    // Wraps around
    expect(getPillLabel(sessions, [], [], activities, 2)).toBe("proj-a: Reading...");
  });

  it("handles missing activity gracefully", () => {
    const sessions = [makeSession("s1", "/a/my-project")];
    expect(getPillLabel(sessions, [], [], {}, 0)).toBe("Working...");
  });
});
