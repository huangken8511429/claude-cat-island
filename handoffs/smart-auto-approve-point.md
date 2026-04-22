# Point Report: Smart Auto-Approve 規則引擎

## Scores
| Dimension | Score (1-5) | Rationale |
|-----------|-------------|-----------|
| 複雜度 | 4 | 涉及 3 層架構改動：(1) Python hook script (`cat-bridge.py`) — 目前 auto-approve 的實際判斷點，需加入規則匹配邏輯；(2) Rust backend (`claude.rs`, `approval.rs`, `lib.rs`) — 規則的 CRUD 持久化 + Tauri IPC commands；(3) React frontend (`PermissionPanel.tsx`) — 規則編輯 UI（新增/刪除/啟停/條件設定）。三層之間的規則資料結構必須保持一致。規則引擎本身需支援多種匹配模式（tool name 精確匹配、路徑 glob/prefix 匹配、正則匹配），且規則之間有優先順序邏輯。 |
| 風險 | 4 | Auto-approve 直接控制 Claude Code 能否執行工具操作。規則匹配邏輯如果有 bug（例如 glob 匹配錯誤讓 Bash 被自動放行），會導致安全性問題——使用者以為有保護但實際上沒有。此外 `cat-bridge.py` 是 Claude Code hook 的進入點，改壞會導致所有 permission request 無法正常處理（卡住或全部 deny）。Python hook 沒有測試框架，出錯只能靠手動測試。 |
| 知識依賴 | 3 | 需要理解：(1) Claude Code hook 機制（PermissionRequest 的 tool_name/tool_input 結構）；(2) Tauri IPC 模式（Rust manage state + invoke handler）；(3) 現有 auto-approve 流程（flag file -> cat-bridge.py 攔截 -> 若沒攔截才到 approval server）；(4) glob/path 匹配演算法設計。不需要 macOS private API 知識，但需要對現有 approval 流水線有清晰理解。 |
| 影響範圍 | 4 | 預估需要改動或新增的檔案：`cat-bridge.py`（核心規則匹配邏輯）、`claude.rs`（規則 CRUD + 持久化）、`lib.rs`（新增 Tauri commands）、`approval.rs`（可能需讓 approval server 也能做規則匹配作為 fallback）、`PermissionPanel.tsx`（規則管理 UI）、`types.ts`（新增 Rule 相關型別）、`App.tsx`（接線新 commands）、新增規則設定檔格式（JSON/TOML）。至少 7-8 個檔案，橫跨 Python/Rust/TypeScript 三語言。 |

## Total: 15/20

## Verdict
`PASS-SPEC-FIRST` -- 需要先走 spec/plan

## Rationale

這個需求的核心難度在於「規則引擎設計」和「三層架構一致性」：

1. **規則資料模型需要仔細設計**：規則的條件組合（tool name + path pattern + action）、優先順序（先匹配先生效 vs 最具體者優先）、啟停狀態、預設行為（全部放行/全部攔截）——這些設計決策會深刻影響使用者體驗和安全性，不適合邊做邊想。

2. **跨語言一致性**：規則匹配邏輯存在於 Python hook script 中（第一道防線），但規則管理在 Rust backend，UI 在 React。三者對規則格式的理解必須完全一致，否則會出現「UI 顯示規則生效但實際沒攔截」的 phantom safety 問題。

3. **安全關鍵路徑**：這是一個 security-adjacent 功能。規則引擎的 bug 不是「畫面顯示錯誤」等級，而是「Bash rm -rf 被自動放行」等級。需要在設計階段就想清楚邊界案例。

4. **既有架構的 constraint**：目前 auto-approve 是用 flag file 實現的，cat-bridge.py 在 hook 被呼叫時讀取。規則引擎需要一個更結構化的設定檔，且 Python script 每次呼叫都要讀取解析——需要考慮效能和原子性。

## Key Risks

1. **Phantom Safety**：規則看起來生效但實際沒攔截，使用者產生錯誤的安全感
2. **Hook Script 故障**：cat-bridge.py 改壞導致所有 Claude Code session 卡在 permission request
3. **規則優先順序歧義**：多條規則同時匹配時的行為不明確，導致不可預期的 approve/deny
4. **Path Pattern 邊界案例**：相對路徑 vs 絕對路徑、symlink、`../` 穿越等 edge case
5. **設定檔競爭**：UI 更新規則的同時 hook script 正在讀取，可能讀到不完整的 JSON
6. **遷移路徑**：現有的全域 auto-approve flag file 用戶已在使用，需要向下相容

## Recommended Next Stage

進入 **Spec 階段**（`/spectra:propose` 或 `/athena-discovery`），具體產出：

1. **規則資料模型 spec**：定義 Rule 的 schema（conditions、action、priority、enabled）
2. **匹配演算法 spec**：定義規則的評估順序和衝突解決策略
3. **設定檔格式與存儲位置**：決定用 JSON 還是其他格式，放在 `~/.claude-cat-monitor/rules.json` 還是其他位置
4. **API contract**：列出所有新增的 Tauri IPC commands
5. **UI wireframe**：規則列表 + 新增規則表單的互動流程
6. **向下相容方案**：如何處理既有的 auto-approve flag file
