# Plan: Multi-Provider Architecture + Codex Support

## Stage
Plan

## Inputs Used
- handoffs/codex-support-spec.md
- claude.rs (1917L), lib.rs (808L), types.ts (213L), App.tsx (894L)

## Dependency Graph

```
Phase 1: Provider 抽象層（純重構，不加 Codex）
  1.1 provider.rs (新檔) ─┐
  1.2 claude.rs 重構 ─────┤ (依賴 1.1)
  1.3 lib.rs 適配 ────────┤ (依賴 1.2)
  1.4 types.ts 更新 ──────┤ (依賴 1.1)
  1.5 驗證 ───────────────┘ (全部完成後)

Phase 2: Codex Provider（依賴 Phase 1）
  2.1 調研 codex 目錄 ────┐
  2.2 codex.rs (新檔) ────┤ (依賴 2.1 + 1.1)
  2.3 lib.rs 註冊 ────────┤ (依賴 2.2)
  2.4 前端 UI 更新 ───────┤ (依賴 1.4 + 2.3)
  2.5 端到端測試 ─────────┘ (全部完成後)
```

## Phase 1: Provider 抽象層

### Step 1.1: 新增 provider.rs
- ProviderKind enum (Claude, Codex)
- UnifiedSession struct (ClaudeSession 超集 + provider 欄位)
- UnifiedTranscriptMessage, UnifiedActivityInfo
- SessionProvider trait: discover_sessions, read_transcript, read_last_message, read_activity, supports_*
- ProviderRegistry: register, discover_all_sessions, find_provider

### Step 1.2: 重構 claude.rs → ClaudeProvider (分三子步驟)
- 1.2a: 新增 ClaudeProvider struct + impl trait（包裝現有函式，不刪舊的）
- 1.2b: 新增轉換輔助函式 (claude_session_to_unified 等)
- 1.2c: 部分 helper 改為 pub(crate) (find_transcript_path, read_file_tail, is_process_alive)
- 保留 Claude-only 函式不動：install_hooks, read_token_stats, read_skills, read_permissions, read_pending_questions, jump_to_session

### Step 1.3: 修改 lib.rs
- 1.3a: 建立 Registry + Tauri State 管理 (Arc<ProviderRegistry>)
- 1.3b: 遷移 get_sessions/get_session_transcript/activity/last_message 到 registry routing
- Claude-only command (30+ 個) 保持直接呼叫 claude::*

### Step 1.4: 更新 types.ts
- 加 ProviderKind = "claude" | "codex"
- ClaudeSession 加 provider 欄位
- 不更名，最小變更

### Step 1.5: 驗證
- cargo check + npm test + npx tauri dev
- 手動測試：pill / session list / transcript / approval / question / jump / token stats

## Phase 2: Codex Provider

### Step 2.1: 調研 Codex 目錄結構
- npm install -g @openai/codex
- 驗證 ~/.codex/ 結構和 conversations/ 格式
- 確認進程名稱 (pgrep)
- 產出 handoffs/codex-research-notes.md

### Step 2.2: 新增 codex.rs
- CodexProvider impl SessionProvider
- discover: pgrep -f codex + lsof 取 cwd
- transcript: 讀取 ~/.codex/conversations/ 轉換 OpenAI messages 格式
- activity: 從最後 message 推斷
- 不加 sysinfo crate，用 pgrep 方式

### Step 2.3: 註冊到 Registry
- lib.rs 加 mod codex + registry.register(CodexProvider)

### Step 2.4: 前端 UI 更新
- SessionPanel: provider 徽章，Codex 隱藏 approval/question UI
- App.tsx pillLabel: 多 provider 時加 [C]/[X] 前綴
- CatLogo: provider prop，Codex 用綠色系 palette
- CSS: .provider-badge 像素風樣式

### Step 2.5: 端到端測試
- 只有 Claude / 只有 Codex / 兩者並存 / Codex 未安裝
- 邊界：檔案損壞、目錄不存在、進程存在但無 conversation

## Estimated Effort
- Phase 1: 1.5 天
- Phase 2: 2 天
- 總計: 3.5 天

## Artifacts Produced
- handoffs/codex-support-plan.md (this file)

## Gate Verdict
PASS

## Next Recommended Stage
Build
