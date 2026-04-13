export interface Prerequisites {
  claudeInstalled: boolean;
  claudeDir: string;
  hasSettings: boolean;
  hasSessions: boolean;
}

export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  entrypoint: string;
  isAlive: boolean;
}

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface TokenStats {
  version: number;
  lastComputedDate: string;
  dailyActivity: DailyActivity[];
}

export interface SkillInfo {
  name: string;
  path: string;
  description: string;
}

export interface SkillDetail {
  name: string;
  path: string;
  frontmatter: Array<[string, string]>;
  body: string;
  sourceFile: string;
}

export interface PermissionConfig {
  skipDangerousMode: boolean;
  autoApproveAll: boolean;
  currentHooks: string[];
}

export interface RateBucket {
  used_percentage: number;
  resets_at: number;
}

export interface RateLimits {
  five_hour: RateBucket;
  seven_day: RateBucket;
}

export interface ContextInfo {
  model: string;
  context_used: number;
  context_total: number;
}

export interface LiveStats {
  rateLimits: RateLimits;
  context: ContextInfo;
}

export interface HookEvent {
  event: string;
  ts: number;
  data: unknown;
}

export interface TranscriptMessage {
  role: string;       // "user" | "assistant" | "tool"
  text: string;
  toolName: string | null;
  toolInput: string | null;
  timestamp: string | null;
}

export type CatState =
  | "working"   // actively processing
  | "idle"      // waiting, no activity
  | "sleeping"  // session not alive / no sessions
  | "done"      // task completed
  | "scared"    // compile/build failure detected
  | "yawning"   // idle for a long time
  | "anxious"   // approval pending too long
  | "sweating"; // rate limit approaching

export type SessionActivity =
  | "reading"
  | "writing"
  | "building"
  | "searching"
  | "thinking"
  | "waiting_input"
  | "waiting_approval"
  | "idle"
  | "done";

export interface SessionActivityInfo {
  sessionId: string;
  activity: SessionActivity;
  toolName: string | null;
}

export interface SessionPendingState {
  session_id: string;
  /** "none" | "needs_approval" | "waiting_input" */
  pending: string;
  tool_name: string;
  message: string;
  ts: number;
}

// ── AskUserQuestion Types ──

export interface QuestionOption {
  label: string;
  description: string;
}

export interface PendingQuestion {
  sessionId: string;
  pid: number;
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  toolUseId: string;
}

// ── Approval System Types ──

/** Raw hook input from Claude Code PermissionRequest */
export interface HookPermissionRequest {
  session_id: string;
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: PermissionSuggestion[];
  permission_mode?: string;
  cwd?: string;
  transcript_path?: string;
}

export interface PermissionSuggestion {
  type: string;
  mode?: string;
  behavior?: string;
  destination?: string;
  rules?: Array<{ toolName: string; ruleContent: string }>;
}

/** An approval request waiting in the queue */
export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions: PermissionSuggestion[];
  cwd?: string;
  receivedAt: number;
}

/** User's decision on an approval */
export interface ApprovalDecision {
  behavior: "allow" | "deny";
  message?: string;
}

/** Response format for Claude Code hook */
export interface HookResponse {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision: {
      behavior: "allow" | "deny";
      message?: string;
    };
  };
}
