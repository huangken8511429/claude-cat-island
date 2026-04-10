import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, currentMonitor, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { CatState, ClaudeSession, TokenStats, SkillInfo, PermissionConfig, LiveStats, SessionPendingState, PendingApproval, SessionActivityInfo } from "./types";
import SessionPanel from "./components/SessionPanel";
import TokenPanel from "./components/TokenPanel";
import SkillPanel from "./components/SkillPanel";
import PermissionPanel from "./components/PermissionPanel";
// ApprovalPanel removed — approvals are now inline in SessionPanel
import CatLogo from "./components/CatLogo";
import { initAudio, playDoneChime, playAlertBlip, playSessionStart, playSessionEnd, playApprovalUrgent, playContextWarning } from "./utils/sound";
import { getPillLabel as computePillLabel } from "./utils/pillLabel";
import "./App.css";

type Tab = "sessions" | "tokens" | "skills" | "permissions";
type IslandMode = "pill" | "notification" | "full";

interface LatestNotification {
  event: string;
  ts: number;
  project: string;
  message: string;
}

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
  const [activities, setActivities] = useState<Record<string, SessionActivityInfo>>({});
  const [inDetail, setInDetail] = useState(false);
  const [pillRotateIdx, setPillRotateIdx] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [, setAudioReady] = useState(false);
  const [lastNotifText, setLastNotifText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const lastNotifTs = useRef(0);
  const prevAlive = useRef<Map<string, boolean>>(new Map());
  const prevPendingIds = useRef<Set<string>>(new Set());
  const isFirstLoad = useRef(true);
  const failCount = useRef(0);
  const launchTime = useRef(Date.now());
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHovering = useRef(false);
  const autoCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const islandRef = useRef<HTMLDivElement>(null);
  const windowResizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvalFirstSeen = useRef<Map<string, number>>(new Map());
  const lastApprovalBlipTs = useRef(0);

  useEffect(() => {
    const unlock = () => { initAudio(); setAudioReady(true); document.removeEventListener("click", unlock); };
    document.addEventListener("click", unlock);
    return () => document.removeEventListener("click", unlock);
  }, []);

  // ── Max permissions on startup ──
  useEffect(() => {
    invoke("set_skip_dangerous", { enabled: true }).catch(() => {});
    invoke("set_auto_approve", { enabled: true }).catch(() => {});
  }, []);

  // ── Dynamic window dimensions ──
  const getFullSize = () => {
    if (inDetail) {
      // Detail mode: maximize height for transcript reading
      return { w: 340, h: 620 };
    }
    // tab bar(40) + content padding(24) + session cards(~52 each) + min base
    const sessionCount = sessions.length;
    const baseH = 120; // tab bar + padding + title
    const perSession = 52;
    const h = Math.min(500, Math.max(200, baseH + sessionCount * perSession));
    return { w: 340, h };
  };

  const getWindowSize = () => {
    if (mode === "pill") return { w: 240, h: 36 };
    if (mode === "notification") return { w: 350, h: 68 };
    return getFullSize();
  };

  // ── Resize window to match island mode ──
  // Window bounds = island bounds, so only the island captures mouse events.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const { w, h } = getWindowSize();

    const resize = async () => {
      try {
        const monitor = await currentMonitor();
        if (!monitor) return;
        const screenW = monitor.size.width / monitor.scaleFactor;
        // Shift slightly left from center so the cat clears the notch
        const x = Math.round((screenW - w) / 2 - 20);
        await appWindow.setSize(new LogicalSize(w, h));
        await appWindow.setPosition(new LogicalPosition(x, 0));
      } catch {}
    };

    if (windowResizeTimer.current) {
      clearTimeout(windowResizeTimer.current);
      windowResizeTimer.current = null;
    }

    if (mode === "pill" || mode === "notification") {
      // Collapsing: delay resize to let CSS transition finish (0.4s)
      windowResizeTimer.current = setTimeout(resize, 420);
    } else {
      // Expanding to full: resize immediately so content has room
      resize();
    }

    return () => {
      if (windowResizeTimer.current) {
        clearTimeout(windowResizeTimer.current);
        windowResizeTimer.current = null;
      }
    };
  }, [mode, sessions.length, inDetail]);

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
    collapseTimer.current = setTimeout(() => setMode("pill"), 300);
  }, []);

  const autoNotify = useCallback(() => {
    if (Date.now() - launchTime.current < 8000) return;
    clearTimers();
    setMode("notification");
    autoCollapseTimer.current = setTimeout(() => {
      if (!isHovering.current) setMode("pill");
    }, 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, t, sk, p, ls, notif, ps, pa] = await Promise.all([
        invoke<ClaudeSession[]>("get_sessions"),
        invoke<TokenStats>("get_token_stats"),
        invoke<SkillInfo[]>("get_skills"),
        invoke<PermissionConfig>("get_permissions"),
        invoke<LiveStats>("get_live_stats"),
        invoke<LatestNotification>("get_latest_notification"),
        invoke<SessionPendingState[]>("get_session_pending_states"),
        invoke<PendingApproval[]>("get_pending_approvals").catch(() => [] as PendingApproval[]),
      ]);
      setSessions(s); setStats(t); setSkills(sk); setPermissions(p); setLive(ls); setPendingStates(ps); setPendingApprovals(pa);
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
          autoNotify();
        }

        // ── New approval pending ──
        const newPending = ps.filter(
          (pp) => !prevPendingIds.current.has(pp.session_id) && s.some((ss) => ss.sessionId === pp.session_id && ss.isAlive)
        );
        if (newPending.length > 0) { playAlertBlip(); autoNotify(); }

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
            autoNotify();
          }
          prevAlive.current.set(ss.sessionId, ss.isAlive);
        });

        // ── Context warning ──
        if (ls && ls.rateLimits.five_hour.used_percentage > 80) {
          playContextWarning();
        }

        prevPendingIds.current = new Set(ps.map((pp) => pp.session_id));
      }
    } catch {
      failCount.current++;
      if (failCount.current >= 3) setError("Backend unreachable");
    }
  }, [error, autoNotify]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Pill label rotation — separate effect, no dependency on refresh
  useEffect(() => {
    const rotateInterval = setInterval(() => {
      setPillRotateIdx((prev) => prev + 1);
    }, 3000);
    return () => clearInterval(rotateInterval);
  }, []);

  const handleResolveApproval = async (id: string, behavior: "allow" | "deny") => {
    try {
      await invoke("resolve_approval", {
        id,
        behavior,
        message: behavior === "deny" ? "Denied from Cat Monitor" : null,
      });
      refresh();
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

  const aliveSessions = sessions.filter((s) => s.isAlive);
  const activeSessions = aliveSessions.length;
  const needsAttention = pendingStates.filter(
    (ps) => ps.pending === "needs_approval" && sessions.some((s) => s.sessionId === ps.session_id && s.isAlive)
  );
  const waitingInput = pendingStates.filter(
    (ps) => ps.pending === "waiting_input" && sessions.some((s) => s.sessionId === ps.session_id && s.isAlive)
  );

  const pillLabel = computePillLabel(aliveSessions, needsAttention, waitingInput, activities, pillRotateIdx);

  // Derive pill CatLogo emotion state (safe — always returns a valid state)
  const getPillCatState = (_sessionId?: string): CatState => {
    try {
      if (live?.rateLimits?.five_hour?.used_percentage != null && live.rateLimits.five_hour.used_percentage > 80) return "sweating";
      if (needsAttention.length > 0) return "anxious";
      if (activeSessions > 0) return "working";
    } catch { /* fallback */ }
    return activeSessions > 0 ? "working" : "idle";
  };

  // Determine island glow state
  const glowClass = needsAttention.length > 0
    ? "island-glow-approval"
    : activeSessions > 0
    ? "island-glow-working"
    : "";

  return (
    <div className="island-container">
      <div ref={islandRef} className={`island island-${mode} ${glowClass}`} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>

        {/* ── Pill content (always rendered, visible in pill mode) ── */}
        <div className="pill-content">
          {/* Mini cat stack for multiple sessions */}
          {aliveSessions.length > 1 ? (
            <div className="pill-cat-stack">
              {aliveSessions.slice(0, 3).map((s, i) => (
                <CatLogo
                  key={s.sessionId}
                  state={getPillCatState(s.sessionId)}
                  size={16}
                  themeIndex={i}
                />
              ))}
              {aliveSessions.length > 3 && (
                <span className="pill-cat-extra">+{aliveSessions.length - 3}</span>
              )}
            </div>
          ) : (
            <CatLogo
              state={getPillCatState()}
              size={24}
            />
          )}
          <span className="pill-label">{pillLabel}</span>
          {lastNotifText && mode === "pill" && (
            <>
              <span className="pill-sep" />
              <span className="pill-notif">{lastNotifText}</span>
            </>
          )}
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
                    ? String(pendingApprovals[0].toolInput.command ?? "").slice(0, 50)
                    : String(pendingApprovals[0].toolInput.file_path ?? pendingApprovals[0].toolName).slice(0, 50)}`
                : toast || lastNotifText || "Notification"}
            </div>
            {pendingApprovals.length > 0 ? (
              <div className="notif-actions">
                <button className="notif-btn deny" onClick={async () => {
                  const a = pendingApprovals[0];
                  await invoke("resolve_approval", { id: a.id, behavior: "deny", message: "Denied from notification" }).catch(() => {});
                  refresh();
                }}>DENY</button>
                <button className="notif-btn allow" onClick={async () => {
                  const a = pendingApprovals[0];
                  await invoke("resolve_approval", { id: a.id, behavior: "allow", message: null }).catch(() => {});
                  refresh();
                }}>ALLOW</button>
              </div>
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
            {error && (
              <div className="error-banner" role="alert">
                <span>! {error}</span>
                <button onClick={refresh}>RETRY</button>
              </div>
            )}
            <main className="content">
              {tab === "sessions" && <SessionPanel sessions={sessions} pendingStates={pendingStates} pendingApprovals={pendingApprovals} onResolveApproval={handleResolveApproval} onDetailChange={setInDetail} />}
              {tab === "tokens" && <TokenPanel stats={stats} live={live} />}
              {tab === "skills" && <SkillPanel skills={skills} />}
              {tab === "permissions" && (
                <PermissionPanel permissions={permissions}
                  onToggleSkipDangerous={handleToggleSkipDangerous}
                  onToggleAutoApprove={handleToggleAutoApprove} />
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
