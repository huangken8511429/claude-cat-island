# Spec: Multi-Provider Architecture + Codex Support

## Stage
Spec

## Inputs Used
- handoffs/codex-support-point.md
- Source code analysis: claude.rs (1917L), lib.rs (808L), approval.rs, socket.rs, types.ts, App.tsx (894L), SessionPanel.tsx (282L)

---

## 1. 現有架構分析

claude.rs 是巨型模組（1917 行），所有功能硬編碼為 Claude Code 專屬：
- Session 檔案：`~/.claude/sessions/*.json`
- Transcript：`~/.claude/projects/{cwd-key}/{sessionId}.jsonl`（JSONL 格式）
- Token 統計：`~/.claude/stats-cache.json`
- Monitor 自有資料：`~/.claude-cat-monitor/` 下的 events/cache/rules

lib.rs 的 30+ 個 IPC 命令全部直接呼叫 `claude::*`，無抽象層。

## 2. Codex CLI 調研結果

- Config 目錄：`~/.codex/`
- Session 發現：**無 session 檔案**，需用進程掃描（pgrep codex）
- Transcript：`~/.codex/conversations/`，OpenAI messages 格式
- Hook 支援：**不支援**。Codex 用 `--approval-mode` flag 控制自動化
- 影響：Codex provider 無法用即時事件推送和 HTTP approval，完全依賴 polling

## 3. Multi-Provider 架構設計

### 3.1 Rust 後端

**新增 `provider.rs`**：
- `ProviderKind` enum: Claude, Codex
- `UnifiedSession` struct: provider, pid, session_id, cwd, started_at, kind, entrypoint, is_alive
- `SessionProvider` trait: discover_sessions, read_transcript, read_last_message, read_activity, supports_hooks, supports_approval, supports_jump
- `ProviderRegistry`: 管理所有 provider，合併 sessions

**重構 `claude.rs`**：
- 抽取 session/transcript 邏輯為 `ClaudeProvider` impl
- 保留 Claude-only：install_hooks, read_token_stats, read_skills, read_permissions, read_pending_questions, jump_to_session

**新增 `codex.rs`**：
- `CodexProvider` impl
- discover: 進程掃描找 codex 進程
- transcript: 讀取 ~/.codex/conversations/，轉換 OpenAI 格式
- supports_hooks: false, supports_approval: false, supports_jump: true

### 3.2 前端型別（types.ts）
- 新增 `ProviderKind = "claude" | "codex"`
- `UnifiedSession` 加入 `provider` 欄位
- `ClaudeSession` 改為 alias 向後相容

### 3.3 UI 變更
- SessionPanel: provider 徽章 ("CLAUDE" / "CODEX")，Codex 隱藏 approval/question UI
- Pill label: 多 provider 時顯示前綴 `[C]` / `[X]`
- Cat state: 各 provider 獨立計算，全域取最高優先級
- CatLogo: 加入 provider prop，不同 provider 不同 sprite

## 4. Approval Server 影響
- approval.rs 保持不變，Claude-only
- Codex 的 pending state 只能透過 transcript polling 推斷
- rules.rs (Smart Auto-Approve) 保持 Claude-only

## 5. 檔案變更清單

### 新增
| 檔案 | 說明 |
|------|------|
| `src-tauri/src/provider.rs` | Provider trait + UnifiedSession + ProviderRegistry |
| `src-tauri/src/codex.rs` | CodexProvider 實作 |

### 重大修改
| 檔案 | 變更 |
|------|------|
| `src-tauri/src/claude.rs` | 抽取為 ClaudeProvider impl |
| `src-tauri/src/lib.rs` | get_sessions 改用 Registry；加 provider routing |
| `src/types.ts` | 加 ProviderKind, UnifiedSession |
| `src/App.tsx` | provider-aware pill/cat state |
| `src/components/SessionPanel.tsx` | provider 徽章 |
| `src/components/CatLogo.tsx` | provider sprite |

### 不變
- approval.rs, socket.rs, settings.rs, rules.rs, cat-bridge.py（Claude-only，保持不變）

## 6. 風險與待決事項

### 高風險
- Codex CLI 版本不穩定 → 加入寬鬆解析
- 進程掃描效能（每 3 秒）→ sysinfo crate 快取或加長間隔
- claude.rs 1917 行重構規模 → 分兩階段：先加抽象層不改邏輯，再加 Codex

### 待決
1. Codex 像素圖示設計
2. 進程掃描 vs 手動配置
3. Codex 確切的 ~/.codex/ 目錄結構需實際驗證
4. sysinfo crate 對 binary size 影響

## 7. 建議實作順序

**Phase 1**: Provider 抽象層（不加 Codex）
1. 新增 provider.rs
2. 重構 claude.rs → ClaudeProvider
3. 修改 lib.rs 透過 registry
4. 更新 types.ts
5. 驗證所有現有功能

**Phase 2**: Codex Provider
1. 新增 codex.rs
2. 註冊到 Registry
3. 前端 UI 更新
4. 測試多 provider 並存

---

## Artifacts Produced
- handoffs/codex-support-spec.md (this file)

## Gate Verdict
PASS — spec 完整可進 Plan

## Next Recommended Stage
Plan
