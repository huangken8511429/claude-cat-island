import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// Window API no longer needed — window is fixed-size, Rust handles click-through
import { CatState, ClaudeSession, TokenStats, SkillInfo, PermissionConfig, LiveStats, SessionPendingState, PendingApproval, PendingQuestion, SessionActivityInfo, Prerequisites, ApprovalRule, RuleMatchResult } from "./types";
import SessionPanel from "./components/SessionPanel";
import TokenPanel from "./components/TokenPanel";
import SkillPanel from "./components/SkillPanel";
import PermissionPanel from "./components/PermissionPanel";
// ApprovalPanel removed — approvals are now inline in SessionPanel
import CatLogo from "./components/CatLogo";
import { initAudio, playDoneChime, playAlertBlip, playSessionStart, playSessionEnd, playApprovalUrgent, playContextWarning } from "./utils/sound";
import "./App.css";

type Tab = "sessions" | "tokens" | "skills" | "permissions";
type IslandMode = "pill" | "notification" | "full";

interface LatestNotification {
  event: string;
  ts: number;
  project: string;
  message: string;
}

interface ToolStatus {
  toolName: string;
  label: string;  // e.g. "Read auth.ts" or "Bash npm test"
  ts: number;
}

function summarizeToolInput(toolName: string, data: Record<string, unknown>): string {
  const input = (data.tool_input ?? {}) as Record<string, unknown>;
  const basename = (p: unknown) => String(p ?? "").split("/").pop() || String(p ?? "");
  switch (toolName) {
    case "Read": return basename(input.file_path);
    case "Write": return basename(input.file_path);
    case "Edit": return basename(input.file_path);
    case "Bash": return String(input.command ?? "").slice(0, 30);
    case "Grep": return `/${input.pattern ?? ""}/ `;
    case "Glob": return String(input.pattern ?? "");
    case "Agent": return String(input.description ?? input.prompt ?? "").slice(0, 25);
    default: return "";
  }
}

// ── Pill status indicator components ──
const PillSpinner = () => <div className="pill-spinner" aria-label="processing" />;
const PillAmberDot = () => <div className="pill-amber-dot" aria-label="approval pending" />;
const PillGreenCheck = () => (
  <svg className="pill-green-check" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 8 L7 12 L13 4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const PillQuestionMark = () => <div className="pill-question-mark" aria-label="question pending">?</div>;

function App() {
  const [mode, setMode] = useState<IslandMode>("pill");
  const [tab, setTab] = useState<Tab>("sessions");
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [stats, setStats] = useState<TokenStats | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [permissions, setPermissions] = useState<PermissionConfig | null>(null);
  const [live, setLive] = useState<LiveStats | null>(null);
  const [pendingStates, setPendingStates] = useState<SessionPendingState[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  const [activities, setActivities] = useState<Record<string, SessionActivityInfo>>({});
  const [approvalRules, setApprovalRules] = useState<ApprovalRule[]>([]);
  const [inDetail, setInDetail] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [, setAudioReady] = useState(false);
  const [lastNotifText, setLastNotifText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [prereqs, setPrereqs] = useState<Prerequisites | null>(null);
  const [toolStatuses, setToolStatuses] = useState<Record<string, ToolStatus>>({});
  const [notchInfo, setNotchInfo] = useState<{ has_notch: boolean; notch_width: number; notch_height: number; pill_width: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const ctxMenuRef = useRef<{ x: number; y: number } | null>(null);

  // Inline approval count for use in effects (avoids TDZ with later-declared derived values)
  const approvalNeededCount = pendingStates.filter(ps => ps.pending === "needs_approval").length + pendingApprovals.length;

  const lastNotifTs = useRef(0);
  const prevAlive = useRef<Map<string, boolean>>(new Map());
  const prevPendingIds = useRef<Set<string>>(new Set());
  const isFirstLoad = useRef(true);
  const firstRunChecked = useRef(false);
  const failCount = useRef(0);
  const launchTime = useRef(Date.now());
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHovering = useRef(false);
  const autoCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const islandRef = useRef<HTMLDivElement>(null);
  const lastAutoExpandApprovalId = useRef("");

  // Fetch notch info once on mount
  useEffect(() => {
    invoke<{ has_notch: boolean; notch_width: number; notch_height: number; pill_width: number }>("get_notch_info")
      .then(setNotchInfo)
      .catch(() => setNotchInfo({ has_notch: false, notch_width: 0, notch_height: 0, pill_width: 240 }));
  }, []);

  // Check prerequisites on mount
  useEffect(() => {
    invoke<Prerequisites>("check_prerequisites")
      .then(setPrereqs)
      .catch(() => setPrereqs({ claudeInstalled: false, claudeDir: "", hasSettings: false, hasSessions: false }));
  }, []);
  const lastAutoNotifyBySession = useRef<Map<string, number>>(new Map());
  const approvalFirstSeen = useRef<Map<string, number>>(new Map());
  const lastApprovalBlipTs = useRef(0);
  const lastContextWarnTs = useRef(0);
  const wasAboveThreshold = useRef(false);
  // Pin full mode after answering a question, so auto-collapse doesn't fire
  // while the user is still reading the hint / switching to terminal to paste.
  const pinFullUntil = useRef(0);

  useEffect(() => {
    const unlock = () => { initAudio(); setAudioReady(true); document.removeEventListener("click", unlock); };
    document.addEventListener("click", unlock);
    return () => document.removeEventListener("click", unlock);
  }, []);

  // ── Startup settings ──
  useEffect(() => {
    invoke("set_skip_dangerous", { enabled: true }).catch(() => {});
    // NOTE: set_auto_approve removed — ruled by the Smart Auto-Approve rule engine.
    // The flag file is managed explicitly via PermissionPanel toggles (FULL TRUST / CAREFUL).
    // Re-apply transparency + position on every page load (including reload)
    invoke("ensure_transparency").catch(() => {});
    invoke("center_window").catch(() => {});
  }, []);

  // ── Track mode in a ref for setInterval callbacks ──
  const latestMode = useRef(mode);
  useEffect(() => { latestMode.current = mode; }, [mode]);

  // ── Island dimensions (inline style — CSS transition animates changes) ──
  const computeIslandSize = () => {
    let w: number, h: number;
    if (mode === "pill") {
      const aliveCount = sessions.filter((s) => s.isAlive).length;
      w = notchInfo?.has_notch ? notchInfo.notch_width + 60 : Math.max(240, Math.min(360, 190 + aliveCount * 34));
      h = notchInfo?.has_notch ? notchInfo.notch_height + 25 : 36;
    } else if (mode === "notification") {
      w = Math.max(380, notchInfo?.has_notch ? notchInfo.notch_width + 80 : 380);
      h = 68;
    } else {
      w = 420;
      const aliveCount = sessions.filter((s) => s.isAlive).length;
      h = inDetail ? 560 : Math.min(540, Math.max(200, 120 + aliveCount * 52));
    }
    return { w, h };
  };
  const { w: islandWidth, h: islandHeight } = computeIslandSize();

  // ── Sync island bounds to Rust for click-through toggling ──
  useEffect(() => {
    const windowW = notchInfo?.has_notch ? notchInfo.pill_width : 440;
    const x = (windowW - islandWidth) / 2;
    invoke("update_island_bounds", { x, y: 0, w: islandWidth, h: islandHeight }).catch(() => {});
  }, [islandWidth, islandHeight, notchInfo]);

  // ── Mode transitions (CSS only, no window resize) ──
  const clearTimers = () => {
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; }
    if (autoCollapseTimer.current) { clearTimeout(autoCollapseTimer.current); autoCollapseTimer.current = null; }
  };

  const handleMouseEnter = useCallback(() => {
    isHovering.current = true;
    clearTimers();
    setMode("full");
  }, []);

  const handleMouseLeave = useCallback(() => {
    isHovering.current = false;
    // Don't collapse while context menu is visible
    if (ctxMenuRef.current) return;
    collapseTimer.current = setTimeout(() => {
      if (Date.now() < pinFullUntil.current) return;
      setMode("pill");
    }, 300);
  }, []);

  // ── Safety: collapse when mouse leaves the Tauri window entirely ──
  // On macOS, clicking another window may not fire mouseLeave on the island
  // element (especially for always-on-top Accessory windows). This catches
  // the case where the user moves their cursor away without triggering the
  // island's onMouseLeave.
  useEffect(() => {
    const onWindowMouseLeave = () => {
      if (isHovering.current) {
        isHovering.current = false;
        if (ctxMenuRef.current) return;
        collapseTimer.current = setTimeout(() => {
          if (Date.now() < pinFullUntil.current) return;
          setMode("pill");
        }, 300);
      }
    };
    document.documentElement.addEventListener("mouseleave", onWindowMouseLeave);
    return () => document.documentElement.removeEventListener("mouseleave", onWindowMouseLeave);
  }, []);

  // ── Safety: collapse on window blur ──
  // After JUMP (or any action that activates another app), the Tauri window
  // loses focus.  macOS stops delivering mouse-tracking events to unfocused
  // transparent windows, so onMouseLeave never fires.  Collapse after a short
  // grace period when focus is still gone.
  useEffect(() => {
    const onBlur = () => {
      setTimeout(() => {
        if (!document.hasFocus() && Date.now() >= pinFullUntil.current && !ctxMenuRef.current) {
          isHovering.current = false;
          setMode("pill");
        }
      }, 600);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // ── Context menu (right-click → Quit) ──
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    };
    const onDismiss = () => setCtxMenu(null);
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setCtxMenu(null); };
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("click", onDismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("click", onDismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Sync ctxMenu ref & manage click-through bounds while context menu is open
  useEffect(() => {
    ctxMenuRef.current = ctxMenu;
    if (ctxMenu) {
      // Pin full mode so island doesn't collapse while menu is visible
      clearTimers();
      pinFullUntil.current = Date.now() + 60_000;
      // Expand click-through bounds to full window so the menu stays clickable
      const windowW = notchInfo?.has_notch ? notchInfo.pill_width : 440;
      invoke("update_island_bounds", { x: 0, y: 0, w: windowW, h: 600 }).catch(() => {});
    } else {
      // Release pin — allow normal collapse
      pinFullUntil.current = 0;
    }
  }, [ctxMenu, notchInfo]);

  // ── Safety: periodic stuck-full detection ──
  // If the window has been in full mode for 15s without hover, force collapse.
  // This guards against any edge case where both mouseLeave handlers fail.
  const fullModeEnteredAt = useRef(0);
  useEffect(() => {
    if (mode === "full") {
      fullModeEnteredAt.current = Date.now();
    }
  }, [mode]);

  useEffect(() => {
    const check = setInterval(() => {
      if (
        latestMode.current === "full" &&
        !isHovering.current &&
        fullModeEnteredAt.current > 0 &&
        Date.now() - fullModeEnteredAt.current > 15_000 &&
        Date.now() >= pinFullUntil.current
      ) {
        setMode("pill");
      }
    }, 5000);
    return () => clearInterval(check);
  }, []);

  // ── Prevent notification auto-collapse while approval pending ──
  useEffect(() => {
    if (mode === "notification" && approvalNeededCount > 0) {
      if (autoCollapseTimer.current) {
        clearTimeout(autoCollapseTimer.current);
        autoCollapseTimer.current = null;
      }
    }
  }, [mode, approvalNeededCount]);

  // ── Auto-expand to full mode when new approval arrives ──
  useEffect(() => {
    if (pendingApprovals.length > 0 && pendingApprovals[0].id !== lastAutoExpandApprovalId.current) {
      lastAutoExpandApprovalId.current = pendingApprovals[0].id;
      clearTimers();
      pinFullUntil.current = Date.now() + 30000;
      setMode("full");
      setTab("sessions");
    }
  }, [pendingApprovals]);

  const autoNotify = useCallback((sessionKey?: string) => {
    if (Date.now() - launchTime.current < 8000) return;
    // Per-session debounce: skip if same sessionKey fired within 30s
    if (sessionKey) {
      const now = Date.now();
      const last = lastAutoNotifyBySession.current.get(sessionKey) ?? 0;
      if (now - last < 30_000) return;
      lastAutoNotifyBySession.current.set(sessionKey, now);
    }
    clearTimers();
    // If the window was stuck in full mode (user already left), reset hover
    // so the autoCollapse timer below can actually fire.
    if (!document.hasFocus() || !isHovering.current) {
      isHovering.current = false;
    }
    setMode("notification");
    autoCollapseTimer.current = setTimeout(() => {
      if (!isHovering.current) setMode("pill");
    }, 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, t, sk, p, ls, notif, ps, pa, pq] = await Promise.all([
        invoke<ClaudeSession[]>("get_sessions"),
        invoke<TokenStats>("get_token_stats"),
        invoke<SkillInfo[]>("get_skills"),
        invoke<PermissionConfig>("get_permissions"),
        invoke<LiveStats>("get_live_stats"),
        invoke<LatestNotification>("get_latest_notification"),
        invoke<SessionPendingState[]>("get_session_pending_states"),
        invoke<PendingApproval[]>("get_pending_approvals").catch(() => [] as PendingApproval[]),
        invoke<PendingQuestion[]>("get_pending_questions").catch(() => [] as PendingQuestion[]),
      ]);
      setSessions(s); setStats(t); setSkills(sk); setPermissions(p); setLive(ls); setPendingStates(ps); setPendingApprovals(pa); setPendingQuestions(pq);
      failCount.current = 0;
      if (error) setError(null);

      // Fetch activities for alive sessions (non-blocking)
      const alive = s.filter((ss) => ss.isAlive);
      Promise.all(
        alive.map((ss) =>
          invoke<SessionActivityInfo>("get_session_activity", { sessionId: ss.sessionId, cwd: ss.cwd }).catch(() => null)
        )
      ).then((results) => {
        const map: Record<string, SessionActivityInfo> = {};
        results.forEach((r) => { if (r) map[r.sessionId] = r; });
        setActivities(map);
      });

      if (isFirstLoad.current) {
        lastNotifTs.current = notif.ts || 0;
        s.forEach((ss) => prevAlive.current.set(ss.sessionId, ss.isAlive));
        ps.forEach((pp) => prevPendingIds.current.add(pp.session_id));
        if (notif.message) setLastNotifText(notif.message.slice(0, 40));
        isFirstLoad.current = false;
      } else {
        // ── New notification ──
        if (notif.ts > 0 && notif.ts > lastNotifTs.current) {
          lastNotifTs.current = notif.ts;
          playDoneChime();
          const proj = notif.project || "Claude";
          const preview = notif.message ? notif.message.slice(0, 60) + (notif.message.length > 60 ? "..." : "") : "done";
          setLastNotifText(`${proj}: ${preview}`);
          setToast(`${proj}: ${preview}`);
          setTimeout(() => setToast(null), 5000);
          autoNotify("notif:" + (notif.project || "_global"));
        }

        // ── New approval pending ──
        const newPending = ps.filter(
          (pp) => !prevPendingIds.current.has(pp.session_id) && s.some((ss) => ss.sessionId === pp.session_id && ss.isAlive)
        );
        if (newPending.length > 0) {
          playAlertBlip();
          newPending.forEach((pp) => autoNotify("approval:" + pp.session_id));
        }

        // ── Approval urgency escalation ──
        const now = Date.now();
        pa.forEach((a) => {
          if (!approvalFirstSeen.current.has(a.id)) {
            approvalFirstSeen.current.set(a.id, now);
          }
        });
        // Clean stale entries
        const paIds = new Set(pa.map((a) => a.id));
        approvalFirstSeen.current.forEach((_, k) => { if (!paIds.has(k)) approvalFirstSeen.current.delete(k); });
        // Play urgent blip if any approval has been waiting and enough time since last blip
        if (pa.length > 0 && now - lastApprovalBlipTs.current > 8000) {
          const oldest = Math.min(...pa.map((a) => approvalFirstSeen.current.get(a.id) ?? now));
          const waitSec = Math.floor((now - oldest) / 1000);
          if (waitSec > 10) {
            playApprovalUrgent(waitSec);
            lastApprovalBlipTs.current = now;
          }
        }

        // ── Session lifecycle ──
        s.forEach((ss) => {
          const was = prevAlive.current.get(ss.sessionId);
          if (was === undefined && ss.isAlive) {
            // New session appeared
            playSessionStart();
          } else if (was === true && !ss.isAlive) {
            // Session ended
            const name = ss.cwd.split("/").pop() || "Session";
            playSessionEnd();
            setLastNotifText(`${name} ended`);
            setToast(`${name} ended`);
            setTimeout(() => setToast(null), 5000);
            autoNotify("end:" + ss.sessionId);
          }
          prevAlive.current.set(ss.sessionId, ss.isAlive);
        });

        // ── Context warning (debounced: play once on threshold crossing, then max once per 60s) ──
        const rlFive = ls?.rateLimits?.five_hour;
        const aboveThreshold = rlFive != null && rlFive.used_percentage > 80 &&
          (rlFive.resets_at === 0 || rlFive.resets_at > Date.now() / 1000);
        const now2 = Date.now();
        if (aboveThreshold) {
          const justCrossed = !wasAboveThreshold.current;
          const cooldownPassed = now2 - lastContextWarnTs.current > 60_000;
          if (justCrossed || cooldownPassed) {
            playContextWarning();
            lastContextWarnTs.current = now2;
          }
        }
        wasAboveThreshold.current = aboveThreshold;

        prevPendingIds.current = new Set(ps.map((pp) => pp.session_id));
      }
    } catch (e) {
      console.error("[refresh] error:", e);
      failCount.current++;
      if (failCount.current >= 3) setError("Backend unreachable");
    }
  }, [error, autoNotify]);

  const fetchApprovalRules = useCallback(async () => {
    try {
      const rules = await invoke<ApprovalRule[]>("get_approval_rules");
      setApprovalRules(rules);
    } catch {
      // Backend may not have rules command yet — silently ignore
    }
  }, []);

  useEffect(() => {
    refresh();
    fetchApprovalRules();
    const interval = setInterval(refresh, 3000);
    // Fetch rules less frequently (every 10s) since they rarely change
    const rulesInterval = setInterval(fetchApprovalRules, 10000);
    return () => { clearInterval(interval); clearInterval(rulesInterval); };
  }, [refresh, fetchApprovalRules]);

  // ── First-run: import safe_defaults if no rules and no auto-approve flag ──
  useEffect(() => {
    if (firstRunChecked.current) return;
    // Wait until both permissions and approvalRules have been fetched
    if (permissions === null) return;
    firstRunChecked.current = true;

    // Only import safe_defaults on first run:
    // - No auto-approve flag file (user hasn't opted into FULL TRUST)
    // - No existing rules (fresh install)
    if (!permissions.autoApproveAll && approvalRules.length === 0) {
      invoke("import_preset_rules", { preset: "safe_defaults" })
        .then(() => fetchApprovalRules())
        .catch((err) => console.error("Failed to import safe_defaults:", err));
    }
  }, [permissions, approvalRules, fetchApprovalRules]);

  // Real-time updates via Unix socket → Tauri event bridge.
  // Parses hook events to update per-session tool status instantly,
  // and triggers a full refresh for state changes.
  useEffect(() => {
    const unlisten = listen<{ event: string; ts: number; session_id: string; data: Record<string, unknown> }>(
      "hook-event",
      ({ payload }) => {
        const { event, session_id, data, ts } = payload;
        if (event === "PreToolUse" && session_id) {
          const toolName = String(data?.tool_name ?? "");
          const summary = summarizeToolInput(toolName, data);
          const label = summary ? `${toolName} ${summary}` : toolName;
          setToolStatuses((prev) => ({ ...prev, [session_id]: { toolName, label, ts } }));
        } else if (event === "PostToolUse" && session_id) {
          setToolStatuses((prev) => {
            const next = { ...prev };
            if (next[session_id]) next[session_id] = { toolName: "", label: "Thinking...", ts };
            return next;
          });
        } else if ((event === "Stop" || event === "SessionEnd") && session_id) {
          setToolStatuses((prev) => {
            const next = { ...prev };
            delete next[session_id];
            return next;
          });
        }
        refresh();
      }
    );
    return () => { unlisten.then((f) => f()); };
  }, [refresh]);

  const handleResolveApproval = async (id: string, behavior: "allow" | "deny") => {
    try {
      await invoke("resolve_approval", {
        id,
        behavior,
        message: behavior === "deny" ? "Denied from Cat Monitor" : null,
      });
      refresh();
      // Auto-collapse after approval resolved
      pinFullUntil.current = 0;
      setTimeout(() => {
        if (!isHovering.current) setMode("pill");
      }, 1500);
    } catch (err) {
      console.error("Failed to resolve approval:", err);
    }
  };

  const handleToggleSkipDangerous = async (enabled: boolean) => {
    try { await invoke("set_skip_dangerous", { enabled }); await refresh(); } catch {}
  };
  const handleToggleAutoApprove = async (enabled: boolean) => {
    try { await invoke("set_auto_approve", { enabled }); await refresh(); } catch {}
  };

  const handleToggleRule = async (id: string, enabled: boolean) => {
    try {
      await invoke("update_approval_rule", { id, enabled });
      await fetchApprovalRules();
    } catch (err) {
      console.error("Failed to toggle rule:", err);
    }
  };

  const handleDeleteRule = async (id: string) => {
    try {
      await invoke("delete_approval_rule", { id });
      await fetchApprovalRules();
    } catch (err) {
      console.error("Failed to delete rule:", err);
    }
  };

  const handleUpdateRule = async (id: string, name: string, toolName: string, pathPattern: string | null, commandPattern: string | null, action: string) => {
    try {
      await invoke("update_approval_rule", {
        id,
        name,
        toolName,
        pathPattern: pathPattern || "",
        commandPattern: commandPattern || "",
        action,
      });
      await fetchApprovalRules();
    } catch (err) {
      console.error("Failed to update rule:", err);
    }
  };

  const handleAddRule = async (name: string, toolName: string, pathPattern: string | null, commandPattern: string | null, action: string) => {
    try {
      await invoke("add_approval_rule", {
        name,
        toolName,
        pathPattern,
        commandPattern,
        action,
      });
      await fetchApprovalRules();
    } catch (err) {
      console.error("Failed to add rule:", err);
    }
  };

  const handleReorderRules = async (ids: string[]) => {
    try {
      await invoke("reorder_approval_rules", { ids });
      await fetchApprovalRules();
    } catch (err) {
      console.error("Failed to reorder rules:", err);
    }
  };

  const handleCheckRuleMatch = async (toolName: string, toolInput: string, cwd: string | null): Promise<RuleMatchResult> => {
    try {
      const parsedInput = JSON.parse(toolInput);
      return await invoke<RuleMatchResult>("check_rule_match", {
        toolName,
        toolInput: parsedInput,
        cwd,
      });
    } catch (err) {
      console.error("Failed to check rule match:", err);
      return { matched: false, rule_id: null, rule_name: null, action: null };
    }
  };

  const handleImportPreset = async (preset: string) => {
    try {
      await invoke("import_preset_rules", { preset });
      await fetchApprovalRules();
    } catch (err) {
      console.error("Failed to import preset:", err);
    }
  };

  const aliveSessions = sessions.filter((s) => s.isAlive);
  const activeSessions = aliveSessions.length;
  const questionSessionIds = new Set(pendingQuestions.map((q) => q.sessionId));
  const needsAttention = pendingStates.filter(
    (ps) => ps.pending === "needs_approval" && !questionSessionIds.has(ps.session_id) && sessions.some((s) => s.sessionId === ps.session_id && s.isAlive)
  );
  const waitingInput = pendingStates.filter(
    (ps) => ps.pending === "waiting_input" && sessions.some((s) => s.sessionId === ps.session_id && s.isAlive)
  );

  // ── Aggregate booleans for pill status indicator ──
  const hasPendingApproval = needsAttention.length > 0;
  const hasPendingQuestion = pendingQuestions.length > 0;
  const hasWaitingForInput = waitingInput.length > 0;
  const isAnyProcessing = aliveSessions.some((s) => {
    const a = activities[s.sessionId]?.activity;
    return a === "reading" || a === "writing" || a === "building" || a === "searching" || a === "thinking";
  });

  // Derive pill CatLogo emotion state per session
  const getSessionCatState = (session: ClaudeSession): CatState => {
    try {
      // Global: rate limit applies to all (skip if resets_at has passed — stale cache)
      const rl = live?.rateLimits?.five_hour;
      if (rl?.used_percentage != null && rl.used_percentage > 80 &&
          (rl.resets_at === 0 || rl.resets_at > Date.now() / 1000)) return "sweating";
      // Per-session: needs approval?
      const ps = pendingStates.find((p) => p.session_id === session.sessionId);
      if (ps?.pending === "needs_approval") return "anxious";
      if (ps?.pending === "waiting_input") return "idle";
      // Per-session: activity?
      const act = activities[session.sessionId]?.activity;
      if (act === "reading" || act === "writing" || act === "building" || act === "searching" || act === "thinking") return "working";
    } catch { /* fallback */ }
    return "idle";
  };

  // Derive pill label from socket-pushed tool status, with polling fallback
  const pillLabel = (() => {
    if (hasPendingApproval) return "Approval needed";
    if (hasPendingQuestion) return pendingQuestions[0].header || "Question";
    if (hasWaitingForInput) return "Waiting for input";
    if (aliveSessions.length === 0) return "";
    // Pick the most recent tool status across all alive sessions
    const aliveIds = new Set(aliveSessions.map((s) => s.sessionId));
    const relevantStatuses = Object.entries(toolStatuses)
      .filter(([sid]) => aliveIds.has(sid))
      .sort(([, a], [, b]) => b.ts - a.ts);
    if (relevantStatuses.length > 0) return relevantStatuses[0][1].label;
    // Fallback: derive from polling-based activity
    const firstActivity = aliveSessions
      .map((s) => activities[s.sessionId])
      .find((a) => a && a.activity !== "idle");
    if (firstActivity) {
      const name = firstActivity.toolName ? ` ${firstActivity.toolName}` : "";
      return firstActivity.activity.replace("_", " ") + name;
    }
    return "Working...";
  })();

  // Determine island glow state
  const glowClass = needsAttention.length > 0
    ? "island-glow-approval"
    : hasPendingQuestion
    ? "island-glow-question"
    : activeSessions > 0
    ? "island-glow-working"
    : "";

  const [ctxDisplays, setCtxDisplays] = useState<{ name: string; width: number; height: number; is_current_selection: boolean }[]>([]);

  const handleQuit = () => {
    setCtxMenu(null);
    invoke("quit_app");
  };

  const handleReload = () => {
    setCtxMenu(null);
    location.reload();
  };

  const handleSwitchDisplay = (name: string) => {
    setCtxMenu(null);
    invoke("set_preferred_display", { name });
  };

  // Fetch display list when context menu opens
  useEffect(() => {
    if (ctxMenu) {
      invoke<{ name: string; width: number; height: number; is_current_selection: boolean }[]>("list_displays")
        .then(setCtxDisplays)
        .catch(() => setCtxDisplays([]));
    }
  }, [ctxMenu]);

  return (
    <div className="island-container">
      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          {ctxDisplays.length > 1 && (
            <>
              <div className="ctx-menu-label">Display</div>
              {ctxDisplays.map((d) => (
                <button
                  key={d.name}
                  className={`ctx-menu-item ctx-menu-display ${d.is_current_selection ? "active" : ""}`}
                  onClick={() => handleSwitchDisplay(d.name)}
                >
                  {d.is_current_selection ? "✓ " : "   "}{d.name} ({d.width}×{d.height})
                </button>
              ))}
              <div className="ctx-menu-sep" />
            </>
          )}
          <button className="ctx-menu-item" onClick={handleReload}>Reload</button>
          <div className="ctx-menu-sep" />
          <button className="ctx-menu-item ctx-menu-quit" onClick={handleQuit}>Quit</button>
        </div>
      )}
      <div ref={islandRef} className={`island island-${mode} ${glowClass} ${notchInfo?.has_notch ? "island-notch" : ""}`} style={{ width: islandWidth, height: islandHeight, ...(notchInfo?.has_notch ? { "--notch-h": `${notchInfo.notch_height}px` } : {}) } as React.CSSProperties} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>

        {/* ── Pill content (always rendered, visible in pill mode) ── */}
        <div className={`pill-content ${notchInfo?.has_notch ? "pill-notch" : ""}`}>
          <div className="pill-left">
            {aliveSessions.length > 0 ? (
              aliveSessions.slice(0, 5).map((s, i) => (
                <CatLogo key={s.sessionId} state={getSessionCatState(s)} size={20} themeIndex={i} />
              ))
            ) : (
              <CatLogo state="idle" size={20} />
            )}
            {aliveSessions.length > 5 && (
              <span className="pill-badge">+{aliveSessions.length - 5}</span>
            )}
          </div>
          {notchInfo?.has_notch && (
            <div className="pill-notch-spacer" style={{ width: notchInfo.notch_width }} />
          )}
          <div className="pill-right">
            {hasPendingApproval ? (
              <PillAmberDot />
            ) : hasPendingQuestion ? (
              <PillQuestionMark />
            ) : isAnyProcessing ? (
              <PillSpinner />
            ) : hasWaitingForInput ? (
              <PillGreenCheck />
            ) : null}
            {pillLabel && <span className="pill-label">{pillLabel}</span>}
          </div>
        </div>

        {/* ── Pill progress bar ── */}
        {mode === "pill" && activeSessions > 0 && (
          <div className="pill-progress">
            <div className={`pill-progress-bar${activeSessions > 1 ? " multi" : ""}${needsAttention.length > 0 ? " approval" : ""}`} />
          </div>
        )}

        {/* ── Notification content ── */}
        {mode === "notification" && (
          <div className="notif-body">
            <div className="notif-msg">
              {pendingApprovals.length > 0
                ? `${pendingApprovals[0].toolName}: ${pendingApprovals[0].toolName === "Bash"
                    ? String(pendingApprovals[0].toolInput?.command ?? "").slice(0, 50)
                    : String(pendingApprovals[0].toolInput?.file_path ?? pendingApprovals[0].toolName).slice(0, 50)}`
                : hasPendingApproval
                ? `${needsAttention[0].tool_name}: ${needsAttention[0].message.slice(0, 50)}`
                : hasPendingQuestion
                ? pendingQuestions[0].header || pendingQuestions[0].question.slice(0, 50)
                : toast || lastNotifText || "Notification"}
            </div>
            {pendingApprovals.length > 0 ? (
              <div className="notif-actions">
                <button className="notif-btn deny" onClick={async () => {
                  const a = pendingApprovals[0];
                  await invoke("resolve_approval", { id: a.id, behavior: "deny", message: "Denied from notification" }).catch(() => {});
                  refresh();
                  setTimeout(() => { if (!isHovering.current) setMode("pill"); }, 1000);
                }}>DENY</button>
                <button className="notif-btn allow" onClick={async () => {
                  const a = pendingApprovals[0];
                  await invoke("resolve_approval", { id: a.id, behavior: "allow", message: null }).catch(() => {});
                  refresh();
                  setTimeout(() => { if (!isHovering.current) setMode("pill"); }, 1000);
                }}>ALLOW</button>
              </div>
            ) : hasPendingApproval ? (
              <div className="notif-actions">
                <PillSpinner />
              </div>
            ) : hasPendingQuestion ? (
              <button className="notif-jump question" onClick={() => {
                setMode("full");
                setTab("sessions");
              }}>SELECT</button>
            ) : needsAttention.length > 0 ? (
              <button className="notif-jump" onClick={() => {
                const sid = needsAttention[0].session_id;
                const session = sessions.find((s) => s.sessionId === sid);
                if (session) invoke("jump_to_session", { pid: session.pid });
              }}>JUMP</button>
            ) : null}
          </div>
        )}

        {/* ── Full panel content ── */}
        {mode === "full" && (
          <div className="panel-body">
            {toast && (
              <div className="toast-inline">
                <CatLogo state="done" size={14} />
                <span>{toast}</span>
              </div>
            )}
            {!inDetail && (
              <nav className="tab-bar" role="tablist">
                {(["sessions", "tokens", "skills", "permissions"] as Tab[]).map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t}
                    className={`tab-btn ${tab === t ? "active" : ""}`}
                    onClick={() => setTab(t)}>
                    <span className={`tab-icon tab-icon-${t}`} />
                    {t.toUpperCase()}
                  </button>
                ))}
              </nav>
            )}
            {prereqs && !prereqs.claudeInstalled && (
              <div className="setup-guide" role="alert">
                <div className="setup-icon">?</div>
                <div className="setup-title">Claude Code not found</div>
                <div className="setup-text">
                  Install Claude Code first, then relaunch this app.
                </div>
                <a className="setup-link" href="https://docs.anthropic.com/en/docs/claude-code/overview" target="_blank" rel="noreferrer">
                  Install Guide &gt;
                </a>
                <button className="retry-btn" onClick={() => {
                  invoke<Prerequisites>("check_prerequisites").then(setPrereqs);
                  refresh();
                }}>RETRY</button>
              </div>
            )}
            {error && prereqs?.claudeInstalled && (
              <div className="error-banner" role="alert">
                <span>! {error}</span>
                <button onClick={refresh}>RETRY</button>
              </div>
            )}
            <main className="content">
              {tab === "sessions" && <SessionPanel sessions={sessions} pendingStates={pendingStates} pendingApprovals={pendingApprovals} pendingQuestions={pendingQuestions} onResolveApproval={handleResolveApproval} onRefresh={() => { pinFullUntil.current = Date.now() + 8000; clearTimers(); isHovering.current = true; setMode("full"); refresh(); }} onDetailChange={setInDetail} />}
              {tab === "tokens" && <TokenPanel stats={stats} live={live} />}
              {tab === "skills" && <SkillPanel skills={skills} onDetailChange={setInDetail} />}
              {tab === "permissions" && (
                <PermissionPanel permissions={permissions}
                  approvalRules={approvalRules}
                  onToggleSkipDangerous={handleToggleSkipDangerous}
                  onToggleAutoApprove={handleToggleAutoApprove}
                  onToggleRule={handleToggleRule}
                  onDeleteRule={handleDeleteRule}
                  onRefreshRules={fetchApprovalRules}
                  onAddRule={handleAddRule}
                  onUpdateRule={handleUpdateRule}
                  onReorderRules={handleReorderRules}
                  onCheckRuleMatch={handleCheckRuleMatch}
                  onImportPreset={handleImportPreset} />
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
