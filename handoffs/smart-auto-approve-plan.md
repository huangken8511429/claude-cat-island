# Plan: Smart Auto-Approve 規則引擎

## 架構概覽

在現有「全域 auto-approve flag file」機制之上，新增以 `~/.claude-cat-monitor/rules.json` 為核心的規則引擎。改動橫跨三層：(1) Rust backend 新增 `rules.rs` 模組負責規則 CRUD、持久化與匹配邏輯，並在 `lib.rs` 註冊 7 個 Tauri IPC commands；(2) Python hook (`cat-bridge.py`) 在 flag file 檢查之後加入規則載入與 first-match-wins 匹配引擎；(3) React frontend 改造 `PermissionPanel.tsx`，新增規則列表（含拖拽排序）、新增/編輯表單、preset 匯入與規則測試功能。三層共用 `rules.json` 作為唯一事實來源，flag file 優先於規則引擎以維持向下相容。

## 依賴關係圖

```
Phase 1: Rust 規則資料模型與 CRUD
  │
  ├──────────────────────┐
  ▼                      ▼
Phase 2: Rust 匹配引擎   Phase 3: Python Hook 規則匹配
  │                      │
  └──────┬───────────────┘
         ▼
Phase 4: Frontend 型別與規則列表 UI
         │
         ▼
Phase 5: Frontend 新增/編輯表單 + Preset
         │
         ▼
Phase 6: 整合、啟動邏輯改造與端對端驗證
```

## Phase 清單

### Phase 1: Rust — 規則資料模型與 CRUD

- **目標**: 建立 `rules.rs` 模組，實作 `ApprovalRule` / `RulesConfig` struct、`rules.json` 的讀寫（含 atomic write）、以及 6 個 Tauri IPC commands（`get_approval_rules`, `add_approval_rule`, `update_approval_rule`, `delete_approval_rule`, `reorder_approval_rules`, `import_preset_rules`）。
- **改動檔案**:
  - `src-tauri/src/rules.rs` — **新增**。定義 `ApprovalRule`, `RuleConditions`, `RulesConfig`, `RuleMatchResult` structs。實作 `load_rules()`, `save_rules()` (write-to-temp-then-rename)。實作 3 組預設規則集（`safe_defaults`, `permissive`, `strict`）。
  - `src-tauri/src/lib.rs` — 新增 `mod rules;`，註冊 6 個 Tauri commands 到 `invoke_handler`。
  - `src-tauri/Cargo.toml` — 新增 `uuid = { version = "1", features = ["v4"] }` dependency。
- **驗收標準**:
  1. `get_approval_rules` 能讀取 `~/.claude-cat-monitor/rules.json`，檔案不存在時回傳空 Vec
  2. `add_approval_rule` 能新增規則並寫入 rules.json，自動產生 UUID 和 timestamp
  3. `update_approval_rule` 能局部更新欄位，空字串清除 optional 欄位
  4. `delete_approval_rule` 刪除指定 ID，不存在時回傳 `Ok(false)`
  5. `reorder_approval_rules` 按傳入 ID 順序重新分配 priority (10, 20, 30...)
  6. `import_preset_rules` 追加預設規則，同名規則跳過
  7. 寫入使用 atomic rename 策略
- **預估大小**: M

### Phase 2: Rust — 規則匹配引擎 + check_rule_match

- **目標**: 在 `rules.rs` 中實作 `match_rules()` 函式和 `check_rule_match` Tauri command，用於 UI 的「測試規則」功能。
- **改動檔案**:
  - `src-tauri/src/rules.rs` — 新增 `match_rules(tool_name, tool_input, cwd)` 函式，實作 first-match-wins 邏輯：tool_name 精確匹配或 `*` wildcard、`path_pattern` glob 匹配（使用 `glob` crate 或手寫 fnmatch）、`command_pattern` substring 匹配。新增路徑正規化（相對轉絕對、移除尾端 `/`）。新增 `check_rule_match` Tauri command。
  - `src-tauri/src/lib.rs` — 在 `invoke_handler` 中補上 `check_rule_match`。
  - `src-tauri/Cargo.toml` — 新增 `glob = "0.3"` dependency（若需要；或用 fnmatch 手寫避免新依賴）。
- **驗收標準**:
  1. tool_name 精確匹配和 `*` wildcard 正確
  2. `path_pattern` glob 匹配：`src/**` 匹配 `/Users/foo/project/src/App.tsx`，相對 pattern 做 suffix match
  3. `command_pattern` substring 匹配：只對 Bash tool 生效
  4. first-match-wins：按 priority 升序，同 priority 按 created_at 升序
  5. 無規則匹配時回傳 `matched: false`
  6. `check_rule_match` 能被前端呼叫並回傳 `RuleMatchResult`
- **預估大小**: M

### Phase 3: Python Hook — 規則匹配引擎

- **目標**: 修改 `cat-bridge.py` 的 `handle_permission_request()`，在 flag file 檢查之後加入 `rules.json` 載入與匹配邏輯。這是**最關鍵且最高風險**的 Phase——cat-bridge.py 是 Claude Code 的第一道攔截點。
- **改動檔案**:
  - `src-tauri/resources/cat-bridge.py` — 修改 `handle_permission_request()`，新增 `_load_rules()`, `_match_rules()`, `_glob_match()`, `_respond_allow()`, `_respond_deny()` 函式。
- **驗收標準**:
  1. flag file 存在時，行為完全不變（全部 auto-approve）
  2. flag file 不存在 + rules.json 存在 → 按規則匹配，allow/deny 正確回應
  3. flag file 不存在 + rules.json 不存在 → 不攔截，request 進入 approval server（現有行為）
  4. rules.json 格式損壞 → 不攔截（fail-open to manual review）
  5. `_glob_match` 的 `*` 不匹配 `/`，`**` 匹配 `/`
  6. 相對路徑以 cwd 為 base 組合為絕對路徑
  7. `command_pattern` 只對 Bash tool 生效
  8. 任何 Python exception 都不會阻止 request 到達 approval server
- **預估大小**: M

### Phase 4: Frontend — 型別定義 + 規則列表 UI

- **目標**: 在前端新增 Approval Rule 相關型別，並在 `PermissionPanel.tsx` 中加入規則列表 UI（只讀展示 + 啟停 toggle + 刪除），以及 Auto Approve All 開啟時的警告提示。
- **改動檔案**:
  - `src/types.ts` — 新增 `RuleConditions`, `ApprovalRule`, `RuleMatchResult` 型別
  - `src/components/PermissionPanel.tsx` — 改造：載入並顯示規則列表（按 priority 排序的卡片），每張卡片含 enabled toggle + 條件摘要 + action badge (allow=綠/deny=紅) + 刪除按鈕。disabled 規則半透明。Auto Approve All 開啟時顯示 `"Auto Approve All 已啟用，規則引擎被繞過"` 警告。
  - `src/App.tsx` — 新增 `getApprovalRules`、`updateApprovalRule`、`deleteApprovalRule` 的 invoke 呼叫，透過 props 或 context 傳給 `PermissionPanel`。
  - `src/App.css` — 新增規則卡片、action badge、warning banner 等 CSS 樣式（像素風）。
- **驗收標準**:
  1. PERMISSIONS tab 顯示現有規則列表，按 priority 排序
  2. 每條規則顯示名稱、tool name、條件摘要、action（綠/紅 badge）
  3. enabled toggle 呼叫 `update_approval_rule` 切換啟停
  4. 刪除按鈕彈出確認對話框，確認後呼叫 `delete_approval_rule`
  5. Auto Approve All 開啟時，規則列表上方顯示黃色警告
  6. 無規則時顯示空狀態提示
- **預估大小**: M

### Phase 5: Frontend — 新增/編輯表單 + Preset + 拖拽排序 + 規則測試

- **目標**: 完成規則管理的完整 CRUD UI：新增規則表單、inline 編輯、Preset 匯入下拉選單、拖拽排序、以及「Test Rules」折疊區。
- **改動檔案**:
  - `src/components/PermissionPanel.tsx` — 新增 `[+ New Rule]` 按鈕展開表單（Name / Tool 下拉 / Path pattern / Command pattern / Action radio），表單驗證（Tool 必選、Name 自動產生），呼叫 `add_approval_rule`。新增 Preset 下拉選單（Safe Defaults / Permissive / Strict / Clear All Rules），呼叫 `import_preset_rules`。新增 inline 編輯（點 pencil icon 展開）。新增 Test Rules 折疊區（Tool / Input / CWD 欄位 → 呼叫 `check_rule_match` → 顯示匹配結果）。
  - `src/components/PermissionPanel.tsx` 或新 `src/components/RuleList.tsx` — 拖拽排序。使用 `@dnd-kit/core` + `@dnd-kit/sortable`（需安裝），或手寫簡易上下移動按鈕作為 MVP。拖放完成後呼叫 `reorder_approval_rules`。
  - `src/App.tsx` — 新增 `addApprovalRule`, `reorderApprovalRules`, `checkRuleMatch`, `importPresetRules` 的 invoke 呼叫。
  - `src/App.css` — 新增表單、下拉選單、拖拽手柄、測試區 CSS 樣式。
  - `package.json` — 新增 `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` dependency（若採用 dnd-kit 方案）。
- **驗收標準**:
  1. 新增規則表單能正確建立規則並重新整理列表
  2. Tool 欄位切換時，Path/Command 欄位正確啟停（Bash 才顯示 Command，Read/Write/Edit 才顯示 Path）
  3. Preset 匯入後列表正確更新，同名規則不重複
  4. Clear All Rules 刪除所有規則（確認對話框）
  5. 拖拽排序後 priority 正確重新分配
  6. Test Rules 能顯示匹配結果（匹配的規則名稱 + action，或「無匹配 → 手動審核」）
- **預估大小**: L

### Phase 6: 整合 — 啟動邏輯改造與端對端驗證

- **目標**: 修改 App 啟動邏輯（移除自動 auto-approve、首次啟動匯入 safe_defaults），進行完整端對端測試。
- **改動檔案**:
  - `src/App.tsx` — 移除 `invoke("set_auto_approve", { enabled: true })` 自動啟用行為。改為：啟動時呼叫 `get_approval_rules`，若回傳空陣列且 `auto-approve` flag file 不存在（透過 `get_permissions` 判斷 `autoApproveAll=false`），則呼叫 `import_preset_rules("safe_defaults")` 自動匯入初始規則。
  - `src-tauri/src/claude.rs` — 可能需微調 `read_permissions()` 以區分「flag file 存在」和「rules.json 有規則」兩種狀態，讓前端知道是否為首次啟動。
- **驗收標準**:
  1. 首次啟動（無 flag file + 無 rules.json）→ 自動匯入 safe_defaults
  2. 非首次啟動 → 不做任何改動
  3. 端對端：建立 allow Read 規則 → Claude Code 觸發 Read tool → cat-bridge.py 自動 allow
  4. 端對端：建立 deny rm -rf 規則 → Claude Code 觸發 `rm -rf` → cat-bridge.py 自動 deny
  5. 端對端：無匹配規則 → request 進入 approval server → UI 手動審核
  6. 端對端：Auto Approve All 開啟 → 規則被繞過，全部 auto-approve
  7. CAREFUL 按鈕 → 關閉 flag file → 規則引擎接管
  8. FULL TRUST 按鈕 → 寫 flag file → 規則被繞過
- **預估大小**: M

## 風險與緩解

| # | 風險 | 嚴重度 | 機率 | 緩解策略 |
|---|------|--------|------|----------|
| R1 | **Phantom Safety** — 規則顯示生效但 Python 端沒攔截 | 高 | 中 | Phase 3 完成後立即做 Phase 6 的端對端測試。Python 和 Rust 兩端的匹配邏輯必須行為一致，但只需驗證 Python 端（Rust 端的 `check_rule_match` 僅用於 UI 預覽，不在關鍵路徑上）。 |
| R2 | **cat-bridge.py 改壞** — 導致所有 permission request 卡住或全部 deny | 高 | 中 | Python 端的所有新增邏輯都包在 try-except 中，任何 exception fail-open 到 approval server。改動前先備份現有 cat-bridge.py 邏輯，確保回退路徑清晰。 |
| R3 | **glob 匹配不一致** — Python `fnmatch` 和 Rust `glob` crate 的行為差異 | 中 | 高 | Spec 已規定：Python 端使用自寫 `_glob_match()`（非直接 fnmatch），Rust 端也手寫或用 glob crate。兩端都遵循相同規則（`*` 不匹配 `/`，`**` 匹配 `/`）。Phase 2 和 Phase 3 各自驗證相同測試案例。 |
| R4 | **rules.json 競爭寫入** — UI 更新同時 Python 在讀 | 低 | 低 | 已在 Spec 中規定 atomic write（temp + rename），OS 保證 rename 原子性。Python 讀到的是完整舊版或完整新版。 |
| R5 | **拖拽排序 UX 複雜度** — dnd-kit 整合耗時超預期 | 低 | 中 | Phase 5 可先用簡易上下移動按鈕（UP/DOWN）作為 MVP，後續再升級到 dnd-kit。不阻塞其他 Phase。 |
| R6 | **App 啟動自動 auto-approve 移除** — 影響現有使用者體驗 | 中 | 低 | Phase 6 的首次啟動邏輯會匯入 safe_defaults，確保使用者不會從「全部放行」突然變成「全部手動」。Release notes 中說明行為變更。 |

## 實作順序建議

```
推薦順序（考慮依賴關係與風險前置）：

1. Phase 1 (Rust CRUD)         ← 基礎層，所有後續 Phase 依賴
2. Phase 2 (Rust 匹配引擎)     ← 與 Phase 3 可平行，但建議先完成以驗證匹配邏輯
3. Phase 3 (Python Hook)       ← 最高風險，依賴 Phase 1 的 rules.json 格式
   └─ 完成後立即做冒煙測試：手動建立 rules.json → 觸發 Claude Code hook → 驗證匹配
4. Phase 4 (前端規則列表)      ← 展示層，依賴 Phase 1 的 CRUD commands
5. Phase 5 (前端完整 CRUD UI)  ← 展示層，依賴 Phase 4 的基礎
6. Phase 6 (整合與啟動邏輯)    ← 收尾，依賴所有前序 Phase

Phase 2 和 Phase 3 理論上可平行開發（因為 Python 和 Rust 各自獨立實作匹配邏輯），
但建議先做 Phase 2 讓 Rust 端的匹配邏輯作為「參考實作」，
再做 Phase 3 時以相同測試案例驗證 Python 端行為一致。

Phase 4 可在 Phase 3 完成之前開始（只依賴 Phase 1 的 CRUD），
但完整端對端驗證需要 Phase 3 完成。
```
