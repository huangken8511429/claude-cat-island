import { TokenStats, LiveStats } from "../types";

interface Props {
  stats: TokenStats | null;
  live: LiveStats | null;
}

function formatResetTime(ts: number): string {
  if (!ts) return "--";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
}

function UsageBar({ label, pct, resetAt }: { label: string; pct: number; resetAt?: number }) {
  const color = pct > 80 ? "#ff5555" : pct > 50 ? "#ffcc40" : "#5ae05a";
  return (
    <div className="usage-bar-row">
      <div className="usage-bar-label">{label}</div>
      <div className="usage-bar-track">
        <div className="usage-bar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
      </div>
      <div className="usage-bar-pct" style={{ color }}>{pct.toFixed(0)}%</div>
      {resetAt ? <div className="usage-bar-reset">reset {formatResetTime(resetAt)}</div> : null}
    </div>
  );
}

export default function TokenPanel({ stats, live }: Props) {
  const hasLive = live && (live.rateLimits.five_hour.resets_at > 0 || live.rateLimits.seven_day.resets_at > 0);

  return (
    <div className="panel token-panel">
      <h2 className="panel-title">TOKEN USAGE</h2>

      {/* Live rate limits from statusline hook */}
      {hasLive && (
        <div className="rate-limits-section">
          <h3 className="sub-title">RATE LIMITS (LIVE)</h3>
          <UsageBar
            label="5-HOUR"
            pct={live!.rateLimits.five_hour.used_percentage}
            resetAt={live!.rateLimits.five_hour.resets_at}
          />
          <UsageBar
            label="7-DAY"
            pct={live!.rateLimits.seven_day.used_percentage}
            resetAt={live!.rateLimits.seven_day.resets_at}
          />
          {live!.context.model && (
            <div className="context-info">
              <span className="context-model">{live!.context.model}</span>
              <span className="sep">|</span>
              <span>Context {live!.context.context_used.toFixed(0)}%</span>
            </div>
          )}
        </div>
      )}

      {/* Historical daily activity */}
      {stats && stats.dailyActivity.length > 0 && (
        <>
          <h3 className="sub-title">DAILY ACTIVITY (14D)</h3>
          <div className="stats-row">
            <div className="stat-box">
              <div className="stat-value">
                {stats.dailyActivity.slice(-14).reduce((s, d) => s + d.messageCount, 0).toLocaleString()}
              </div>
              <div className="stat-label">MSGS</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">
                {stats.dailyActivity.slice(-14).reduce((s, d) => s + d.toolCallCount, 0).toLocaleString()}
              </div>
              <div className="stat-label">TOOLS</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">
                {stats.dailyActivity.slice(-14).reduce((s, d) => s + d.sessionCount, 0).toLocaleString()}
              </div>
              <div className="stat-label">SESSIONS</div>
            </div>
          </div>

          <div className="chart">
            {(() => {
              const recent = stats.dailyActivity.slice(-14);
              const max = Math.max(...recent.map((d) => d.messageCount), 1);
              return recent.map((day) => {
                const height = Math.max((day.messageCount / max) * 100, 2);
                return (
                  <div key={day.date} className="chart-bar-wrapper" title={`${day.date}: ${day.messageCount} msgs`}>
                    <div className="chart-bar" style={{ height: `${height}%` }}>
                      <div className="chart-bar-fill" />
                    </div>
                    <div className="chart-label">{day.date.slice(5)}</div>
                  </div>
                );
              });
            })()}
          </div>
        </>
      )}

      {!stats && !hasLive && (
        <div className="empty-state">
          <div className="skeleton skeleton-row" style={{ width: "100%" }} />
          <div className="skeleton skeleton-row" style={{ width: "100%" }} />
          <p style={{ marginTop: 8 }}>No data yet — hooks will populate this</p>
        </div>
      )}
    </div>
  );
}
