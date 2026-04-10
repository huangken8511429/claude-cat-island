import { describe, it, expect, beforeEach } from "vitest";
import { ApprovalQueue, parseHookInput, formatHookResponse, summarizeToolInput } from "./ApprovalQueue";
import type { HookPermissionRequest, ApprovalDecision } from "../types";

// ── Test fixtures ──

const BASH_REQUEST: HookPermissionRequest = {
  session_id: "session-abc-123",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "npm install express", description: "Install express" },
  permission_suggestions: [
    { type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash", ruleContent: "npm *" }] },
  ],
  permission_mode: "default",
  cwd: "/Users/test/my-project",
};

const WRITE_REQUEST: HookPermissionRequest = {
  session_id: "session-def-456",
  hook_event_name: "PermissionRequest",
  tool_name: "Write",
  tool_input: { file_path: "/src/index.ts", content: "console.log('hello')" },
  permission_suggestions: [
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ],
  cwd: "/Users/test/another-project",
};

const EDIT_REQUEST: HookPermissionRequest = {
  session_id: "session-abc-123",
  hook_event_name: "PermissionRequest",
  tool_name: "Edit",
  tool_input: { file_path: "/src/app.ts", old_string: "foo", new_string: "bar" },
  cwd: "/Users/test/my-project",
};

const RAW_HOOK_JSON = JSON.stringify({
  session_id: "session-xyz",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "ls -la" },
  permission_mode: "default",
  cwd: "/tmp",
});

// ── parseHookInput ──

describe("parseHookInput", () => {
  it("should parse valid hook JSON into HookPermissionRequest", () => {
    const result = parseHookInput(RAW_HOOK_JSON);

    expect(result.session_id).toBe("session-xyz");
    expect(result.hook_event_name).toBe("PermissionRequest");
    expect(result.tool_name).toBe("Bash");
    expect(result.tool_input).toEqual({ command: "ls -la" });
    expect(result.cwd).toBe("/tmp");
  });

  it("should throw on invalid JSON", () => {
    expect(() => parseHookInput("not json")).toThrow();
  });

  it("should throw if hook_event_name is not PermissionRequest", () => {
    const bad = JSON.stringify({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {},
    });
    expect(() => parseHookInput(bad)).toThrow();
  });

  it("should throw if required fields are missing", () => {
    const noTool = JSON.stringify({
      session_id: "s1",
      hook_event_name: "PermissionRequest",
      tool_input: {},
    });
    expect(() => parseHookInput(noTool)).toThrow();
  });

  it("should default permission_suggestions to empty array if absent", () => {
    const minimal = JSON.stringify({
      session_id: "s1",
      hook_event_name: "PermissionRequest",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
    });
    const result = parseHookInput(minimal);
    expect(result.permission_suggestions).toEqual([]);
  });
});

// ── formatHookResponse ──

describe("formatHookResponse", () => {
  it("should format an allow decision", () => {
    const decision: ApprovalDecision = { behavior: "allow" };
    const response = formatHookResponse(decision);

    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("should format a deny decision with message", () => {
    const decision: ApprovalDecision = { behavior: "deny", message: "Too risky" };
    const response = formatHookResponse(decision);

    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Too risky" },
      },
    });
  });

  it("should produce valid JSON when stringified", () => {
    const decision: ApprovalDecision = { behavior: "allow" };
    const json = JSON.stringify(formatHookResponse(decision));
    const parsed = JSON.parse(json);

    expect(parsed.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(parsed.hookSpecificOutput.decision.behavior).toBe("allow");
  });
});

// ── summarizeToolInput ──

describe("summarizeToolInput", () => {
  it("should summarize Bash command", () => {
    const summary = summarizeToolInput("Bash", { command: "npm install express" });
    expect(summary).toContain("npm install express");
  });

  it("should summarize Write with file path", () => {
    const summary = summarizeToolInput("Write", { file_path: "/src/index.ts", content: "..." });
    expect(summary).toContain("/src/index.ts");
  });

  it("should summarize Edit with file path and change", () => {
    const summary = summarizeToolInput("Edit", {
      file_path: "/src/app.ts",
      old_string: "foo",
      new_string: "bar",
    });
    expect(summary).toContain("/src/app.ts");
  });

  it("should summarize Read with file path", () => {
    const summary = summarizeToolInput("Read", { file_path: "/etc/passwd" });
    expect(summary).toContain("/etc/passwd");
  });

  it("should handle unknown tool gracefully", () => {
    const summary = summarizeToolInput("CustomTool", { some: "data" });
    expect(summary).toBeTruthy();
    expect(typeof summary).toBe("string");
  });
});

// ── ApprovalQueue ──

describe("ApprovalQueue", () => {
  let queue: ApprovalQueue;

  beforeEach(() => {
    queue = new ApprovalQueue();
  });

  describe("enqueue", () => {
    it("should add a request and return a PendingApproval with unique id", () => {
      const pending = queue.enqueue(BASH_REQUEST);

      expect(pending.id).toBeTruthy();
      expect(pending.sessionId).toBe("session-abc-123");
      expect(pending.toolName).toBe("Bash");
      expect(pending.toolInput).toEqual({ command: "npm install express", description: "Install express" });
      expect(pending.suggestions).toHaveLength(1);
      expect(pending.cwd).toBe("/Users/test/my-project");
      expect(pending.receivedAt).toBeGreaterThan(0);
    });

    it("should assign unique ids to different requests", () => {
      const p1 = queue.enqueue(BASH_REQUEST);
      const p2 = queue.enqueue(WRITE_REQUEST);

      expect(p1.id).not.toBe(p2.id);
    });

    it("should allow multiple requests from the same session", () => {
      queue.enqueue(BASH_REQUEST);
      queue.enqueue(EDIT_REQUEST); // same session_id

      const pending = queue.getPending();
      expect(pending).toHaveLength(2);
      expect(pending[0].sessionId).toBe("session-abc-123");
      expect(pending[1].sessionId).toBe("session-abc-123");
    });
  });

  describe("getPending", () => {
    it("should return empty array when no requests", () => {
      expect(queue.getPending()).toEqual([]);
    });

    it("should return all pending requests in order", () => {
      queue.enqueue(BASH_REQUEST);
      queue.enqueue(WRITE_REQUEST);

      const pending = queue.getPending();
      expect(pending).toHaveLength(2);
      expect(pending[0].toolName).toBe("Bash");
      expect(pending[1].toolName).toBe("Write");
    });
  });

  describe("getById", () => {
    it("should return the correct pending approval by id", () => {
      const p1 = queue.enqueue(BASH_REQUEST);
      queue.enqueue(WRITE_REQUEST);

      const found = queue.getById(p1.id);
      expect(found).toBeDefined();
      expect(found!.toolName).toBe("Bash");
    });

    it("should return undefined for non-existent id", () => {
      expect(queue.getById("non-existent")).toBeUndefined();
    });
  });

  describe("resolve", () => {
    it("should remove the request and return a valid HookResponse for allow", () => {
      const pending = queue.enqueue(BASH_REQUEST);
      const response = queue.resolve(pending.id, { behavior: "allow" });

      expect(response.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
      expect(response.hookSpecificOutput.decision.behavior).toBe("allow");
      expect(queue.getPending()).toHaveLength(0);
    });

    it("should return deny response with message", () => {
      const pending = queue.enqueue(BASH_REQUEST);
      const response = queue.resolve(pending.id, { behavior: "deny", message: "Not safe" });

      expect(response.hookSpecificOutput.decision.behavior).toBe("deny");
      expect(response.hookSpecificOutput.decision.message).toBe("Not safe");
    });

    it("should throw if resolving non-existent id", () => {
      expect(() => queue.resolve("fake-id", { behavior: "allow" })).toThrow();
    });

    it("should not allow resolving the same request twice", () => {
      const pending = queue.enqueue(BASH_REQUEST);
      queue.resolve(pending.id, { behavior: "allow" });

      expect(() => queue.resolve(pending.id, { behavior: "allow" })).toThrow();
    });
  });

  describe("remove", () => {
    it("should remove a pending request and return true", () => {
      const pending = queue.enqueue(BASH_REQUEST);
      expect(queue.remove(pending.id)).toBe(true);
      expect(queue.getPending()).toHaveLength(0);
    });

    it("should return false for non-existent id", () => {
      expect(queue.remove("fake")).toBe(false);
    });
  });

  describe("clear", () => {
    it("should remove all pending requests", () => {
      queue.enqueue(BASH_REQUEST);
      queue.enqueue(WRITE_REQUEST);
      queue.clear();

      expect(queue.getPending()).toHaveLength(0);
    });
  });
});
