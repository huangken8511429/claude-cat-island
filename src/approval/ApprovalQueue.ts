import type {
  HookPermissionRequest,
  PendingApproval,
  ApprovalDecision,
  HookResponse,
} from "../types";

let nextId = 1;

/**
 * Manages pending approval requests from Claude Code hooks.
 */
export class ApprovalQueue {
  private queue: Map<string, PendingApproval> = new Map();
  private insertOrder: string[] = [];

  enqueue(request: HookPermissionRequest): PendingApproval {
    const id = `approval-${nextId++}`;
    const pending: PendingApproval = {
      id,
      sessionId: request.session_id,
      toolName: request.tool_name,
      toolInput: request.tool_input,
      suggestions: request.permission_suggestions ?? [],
      cwd: request.cwd,
      receivedAt: Date.now(),
    };
    this.queue.set(id, pending);
    this.insertOrder.push(id);
    return pending;
  }

  getPending(): PendingApproval[] {
    return this.insertOrder
      .filter((id) => this.queue.has(id))
      .map((id) => this.queue.get(id)!);
  }

  getById(id: string): PendingApproval | undefined {
    return this.queue.get(id);
  }

  resolve(id: string, decision: ApprovalDecision): HookResponse {
    if (!this.queue.has(id)) {
      throw new Error(`Approval ${id} not found`);
    }
    this.queue.delete(id);
    this.insertOrder = this.insertOrder.filter((i) => i !== id);
    return formatHookResponse(decision);
  }

  remove(id: string): boolean {
    if (!this.queue.has(id)) return false;
    this.queue.delete(id);
    this.insertOrder = this.insertOrder.filter((i) => i !== id);
    return true;
  }

  clear(): void {
    this.queue.clear();
    this.insertOrder = [];
  }
}

/** Parse raw hook stdin JSON into a typed request */
export function parseHookInput(raw: string): HookPermissionRequest {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON input");
  }

  if (parsed.hook_event_name !== "PermissionRequest") {
    throw new Error(`Unexpected event: ${parsed.hook_event_name}`);
  }
  if (!parsed.tool_name) {
    throw new Error("Missing required field: tool_name");
  }
  if (!parsed.session_id) {
    throw new Error("Missing required field: session_id");
  }

  return {
    session_id: parsed.session_id as string,
    hook_event_name: "PermissionRequest",
    tool_name: parsed.tool_name as string,
    tool_input: (parsed.tool_input as Record<string, unknown>) ?? {},
    permission_suggestions: (parsed.permission_suggestions as HookPermissionRequest["permission_suggestions"]) ?? [],
    permission_mode: parsed.permission_mode as string | undefined,
    cwd: parsed.cwd as string | undefined,
    transcript_path: parsed.transcript_path as string | undefined,
  };
}

/** Format a decision into the hook response JSON */
export function formatHookResponse(decision: ApprovalDecision): HookResponse {
  const response: HookResponse = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: decision.behavior },
    },
  };
  if (decision.message) {
    response.hookSpecificOutput.decision.message = decision.message;
  }
  return response;
}

/** Extract a human-readable summary of what the tool wants to do */
export function summarizeToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return `$ ${toolInput.command ?? "unknown command"}`;
    case "Write":
      return `Write ${toolInput.file_path ?? "unknown file"}`;
    case "Edit":
      return `Edit ${toolInput.file_path ?? "unknown file"}`;
    case "Read":
      return `Read ${toolInput.file_path ?? "unknown file"}`;
    case "Grep":
      return `Grep "${toolInput.pattern ?? ""}" in ${toolInput.path ?? "."}`;
    case "Glob":
      return `Glob ${toolInput.pattern ?? "*"}`;
    default:
      return `${toolName}: ${JSON.stringify(toolInput).slice(0, 80)}`;
  }
}
