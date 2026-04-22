# Spec: Smart Auto-Approve 規則引擎

> **Status**: Draft  
> **Point Score**: 15/20 (`PASS-SPEC-FIRST`)  
> **前置**: [`smart-auto-approve-point.md`](./smart-auto-approve-point.md)

---

## 0. 現有架構概覽

理解現有流程是正確實作規則引擎的前提。

### 現有 PermissionRequest 流程

```
Claude Code 觸發 tool call
  │
  ▼
Claude Code hook (PermissionRequest)
  │
  ├─ Hook 1: cat-bridge.py PermissionRequest  (Python, via stdin)
  │    └─ 讀 ~/.claude-cat-monitor/auto-approve flag file
  │         ├─ 存在 → stdout 輸出 {"hookSpecificOutput": {..."allow"}} → 結束（不進 approval server）
  │         └─ 不存在 → 不輸出，Python exit(0)，hook 不攔截
  │
  ├─ Hook 2: curl POST http://127.0.0.1:57000/hooks/permission-request  (Rust HTTP)
  │    └─ Rust ApprovalServer 收到 HookPermissionRequest
  │         ├─ 加入 pending queue
  │         ├─ 阻塞等待 UI 決定（最長 300s timeout）
  │         └─ 回傳 allow/deny JSON
  │
  ▼
Frontend 每秒 polling get_pending_approvals → 顯示 ApprovalPanel → 使用者點 Allow/Deny
  └─ invoke("resolve_approval", {id, behavior})
       └─ Rust cvar.notify_all() → 解除 HTTP 阻塞 → 回傳給 Claude Code
```

### 關鍵檔案

| 檔案 | 語言 | 角色 |
|------|------|------|
| `src-tauri/resources/cat-bridge.py` | Python | Hook bridge — 第一道攔截點，目前用 flag file 判斷 auto-approve |
| `src-tauri/src/approval.rs` | Rust | HTTP server (port 57000) — 接收 PermissionRequest、管理 pending queue |
| `src-tauri/src/claude.rs` | Rust | `set_auto_approve()` 寫 flag file、`read_permissions()` 讀 flag file |
| `src-tauri/src/lib.rs` | Rust | Tauri commands 註冊 |
| `src/components/ApprovalPanel.tsx` | TSX | 審核 UI — 顯示 pending approvals、Allow/Deny 按鈕 |
| `src/components/PermissionPanel.tsx` | TSX | 設定 UI — Skip Dangerous / Auto Approve All toggle |
| `src/types.ts` | TS | 前端型別定義 |

### 核心設計約束

1. **cat-bridge.py 是第一道防線**：它在 Claude Code hook 中最先執行，有權直接 stdout 回傳 allow/deny 並結束，不讓 request 到達 approval server。規則引擎的匹配邏輯**必須**在這裡執行。
2. **approval server 是第二道防線**：規則不匹配時，request 進入 approval server 等待 UI 手動審核。
3. **Python hook 是獨立 process**：每次 Claude Code 觸發 PermissionRequest 都會 fork 一個新的 `python3 cat-bridge.py PermissionRequest` process。規則檔必須從磁碟讀取，不可依賴記憶體狀態。

---

## 1. 規則資料模型 (Rule Schema)

### 1.1 單條規則結構

```typescript
interface ApprovalRule {
  id: string;            // UUID v4, 建立時自動產生
  name: string;          // 使用者命名，如 "Allow Read everywhere"
  enabled: boolean;      // false 時跳過此規則
  conditions: {
    tool_name: string;   // 精確匹配或 "*"（匹配所有 tool）
    path_pattern?: string;    // glob pattern，可選。匹配 tool_input 中的 file_path 或 path
    command_pattern?: string; // substring 匹配，可選。僅對 Bash tool 的 command 欄位生效
  };
  action: "allow" | "deny";
  priority: number;      // 整數，越小優先級越高。建議間距 10（10, 20, 30...）
  created_at: string;    // ISO 8601 timestamp
}
```

### 1.2 JSON Schema（完整定義）

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["id", "name", "enabled", "conditions", "action", "priority", "created_at"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "enabled": {
      "type": "boolean"
    },
    "conditions": {
      "type": "object",
      "required": ["tool_name"],
      "properties": {
        "tool_name": {
          "type": "string",
          "minLength": 1,
          "description": "Exact tool name (e.g. 'Read', 'Bash', 'Write') or '*' for all tools"
        },
        "path_pattern": {
          "type": "string",
          "description": "Glob pattern for file_path / path in tool_input. e.g. 'src/**', '/tmp/*'"
        },
        "command_pattern": {
          "type": "string",
          "description": "Substring match for Bash command. e.g. 'npm test', 'git '"
        }
      },
      "additionalProperties": false
    },
    "action": {
      "type": "string",
      "enum": ["allow", "deny"]
    },
    "priority": {
      "type": "integer",
      "minimum": 0,
      "maximum": 99999
    },
    "created_at": {
      "type": "string",
      "format": "date-time"
    }
  },
  "additionalProperties": false
}
```

### 1.3 條件欄位與 Tool 的對應關係

| Tool Name | `tool_input` 中有效欄位 | `path_pattern` 匹配目標 | `command_pattern` 匹配目標 |
|-----------|------------------------|------------------------|--------------------------|
| `Bash` | `command: string` | N/A（Bash 沒有 file_path） | `tool_input.command` |
| `Read` | `file_path: string` | `tool_input.file_path` | N/A |
| `Write` | `file_path: string, content: string` | `tool_input.file_path` | N/A |
| `Edit` | `file_path: string, old_string: string, new_string: string` | `tool_input.file_path` | N/A |
| `Grep` | `pattern: string, path?: string` | `tool_input.path`（若存在） | N/A |
| `Glob` | `pattern: string, path?: string` | `tool_input.path`（若存在） | N/A |
| `WebFetch` | `url: string` | N/A | N/A |
| `WebSearch` | `query: string` | N/A | N/A |
| `*` (wildcard) | 任意 tool | 視 tool_input 內容而定 | 視 tool_input 內容而定 |

> **注意**：`path_pattern` 會嘗試匹配 `tool_input.file_path`，若不存在則嘗試 `tool_input.path`。兩者都不存在時，此條件視為「不匹配」（not matched），整條規則不生效。

---

## 2. 匹配演算法

### 2.1 評估流程

```
收到 PermissionRequest(tool_name, tool_input)
  │
  ▼
載入 rules.json，過濾 enabled=true 的規則
  │
  ▼
依 priority 升序排列（數字小的先評估）
  │
  ▼
For each rule:
  ├─ match_tool_name(rule.conditions.tool_name, request.tool_name)
  │    ├─ rule.tool_name == "*" → 匹配
  │    ├─ rule.tool_name == request.tool_name → 匹配
  │    └─ 否則 → 不匹配，跳過此規則
  │
  ├─ 若 rule.conditions.path_pattern 存在：
  │    ├─ 從 request.tool_input 取出 file_path 或 path
  │    │    └─ 都不存在 → 此條件不匹配，跳過此規則
  │    ├─ 將相對路徑轉為絕對路徑（基於 request.cwd）
  │    └─ glob_match(rule.conditions.path_pattern, resolved_path)
  │         ├─ 匹配 → 繼續
  │         └─ 不匹配 → 跳過此規則
  │
  ├─ 若 rule.conditions.command_pattern 存在：
  │    ├─ request.tool_name != "Bash" → 此條件不匹配，跳過此規則
  │    └─ request.tool_input.command.contains(rule.conditions.command_pattern)
  │         ├─ 匹配 → 繼續
  │         └─ 不匹配 → 跳過此規則
  │
  └─ 所有條件都匹配 → **First Match Wins** → 回傳 rule.action
  
所有規則都不匹配
  └─ **Default: 送到 approval server 手動審核**
```

### 2.2 First Match Wins

- 規則按 `priority` 升序排列（0 最高優先）
- 第一條所有條件都匹配的規則決定結果
- **不做**「最具體者優先」——因為「最具體」的定義模糊，且難以在 Python 中高效計算。使用者透過手動排序 priority 來控制優先級，這是最明確的

### 2.3 Priority 相同時的 Tiebreaker

- 若兩條規則 priority 相同，按 `created_at` 升序（先建立的優先）
- 實務上，UI 的拖拽排序會確保 priority 值唯一

### 2.4 Glob Matching 規格

Python 端使用 `fnmatch.fnmatch()` 進行 glob 匹配。Rust 端使用 `glob` crate 或手寫 fnmatch。

支援的 pattern：
- `*` — 匹配單層路徑中的任意字元（不含 `/`）
- `**` — 匹配任意層級路徑（含 `/`）
- `?` — 匹配單個字元
- `[abc]` — 字元集合

範例：
| Pattern | 匹配 | 不匹配 |
|---------|------|--------|
| `src/**` | `src/App.tsx`, `src/utils/sound.ts` | `test/App.tsx` |
| `*.ts` | `index.ts`, `src/App.ts`（注意：fnmatch 的 `*` 會匹配 `/`） | `index.tsx` |
| `/tmp/*` | `/tmp/test.txt` | `/tmp/sub/file.txt` |
| `**/*.test.ts` | `src/utils/sound.test.ts` | `src/utils/sound.ts` |

> **重要**：Python `fnmatch.fnmatch()` 的 `*` 預設匹配 `/`，這與 shell glob 不同。為了一致性，Python 端改用 `pathlib.PurePosixPath.match()` 或手寫匹配，確保 `*` 不匹配 `/` 而 `**` 匹配 `/`。具體實作見 [Section 5](#5-python-hook-改動)。

### 2.5 路徑正規化

在匹配前，對 request 中的路徑進行正規化：

1. **相對路徑轉絕對路徑**：如果 `tool_input.file_path` 不以 `/` 開頭，以 `request.cwd` 為 base 組合。若 `cwd` 不存在，則保留原始相對路徑
2. **移除尾端 `/`**：`/tmp/dir/` → `/tmp/dir`
3. **不解析 symlink**：匹配的是路徑字串，不是實際檔案系統位置（安全考量見 Section 8）
4. **不正規化 `..`**：`src/../test/foo.ts` 保持原樣。這是刻意的——如果使用者寫了 `src/**` 的 allow rule，包含 `../` 的路徑不應匹配

---

## 3. 設定檔格式與存儲

### 3.1 檔案位置

```
~/.claude-cat-monitor/rules.json
```

選擇理由：
- 與現有 `auto-approve` flag file 同目錄，概念一致
- Python bridge script 已知此目錄路徑（`MONITOR_DIR`）
- 不放在 Tauri app data dir，因為 Python script 不知道 Tauri app data 路徑

### 3.2 完整 JSON 範例

```json
{
  "version": 1,
  "rules": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "name": "Always allow Read",
      "enabled": true,
      "conditions": {
        "tool_name": "Read"
      },
      "action": "allow",
      "priority": 10,
      "created_at": "2026-04-22T10:00:00Z"
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440002",
      "name": "Allow Grep everywhere",
      "enabled": true,
      "conditions": {
        "tool_name": "Grep"
      },
      "action": "allow",
      "priority": 20,
      "created_at": "2026-04-22T10:01:00Z"
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440003",
      "name": "Allow Glob everywhere",
      "enabled": true,
      "conditions": {
        "tool_name": "Glob"
      },
      "action": "allow",
      "priority": 30,
      "created_at": "2026-04-22T10:02:00Z"
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440004",
      "name": "Allow Edit in src/",
      "enabled": true,
      "conditions": {
        "tool_name": "Edit",
        "path_pattern": "src/**"
      },
      "action": "allow",
      "priority": 40,
      "created_at": "2026-04-22T10:03:00Z"
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440005",
      "name": "Allow npm/git commands",
      "enabled": true,
      "conditions": {
        "tool_name": "Bash",
        "command_pattern": "npm "
      },
      "action": "allow",
      "priority": 50,
      "created_at": "2026-04-22T10:04:00Z"
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440006",
      "name": "Deny rm -rf",
      "enabled": true,
      "conditions": {
        "tool_name": "Bash",
        "command_pattern": "rm -rf"
      },
      "action": "deny",
      "priority": 5,
      "created_at": "2026-04-22T10:05:00Z"
    }
  ]
}
```

### 3.3 `version` 欄位

- 目前固定為 `1`
- 未來若 rule schema 結構改變，透過 version 進行自動遷移
- 讀取時：若 `version` 不存在或非 `1`，視為空規則集（不 crash）

### 3.4 原子性寫入

Rust 端寫入 `rules.json` 時必須使用 write-to-temp-then-rename 策略：

```rust
fn save_rules(rules: &RulesConfig) -> Result<(), Error> {
    let rules_path = monitor_dir().join("rules.json");
    let temp_path = monitor_dir().join("rules.json.tmp");
    
    let json = serde_json::to_string_pretty(rules)?;
    fs::write(&temp_path, &json)?;
    fs::rename(&temp_path, &rules_path)?;  // atomic on same filesystem
    Ok(())
}
```

這確保 Python bridge 讀取時不會看到寫到一半的 JSON。

### 3.5 向下相容：auto-approve flag file 遷移

#### 遷移策略

**不自動遷移。兩套機制並存，flag file 優先。**

邏輯：
1. 若 `~/.claude-cat-monitor/auto-approve` flag file 存在 → 全部 auto-approve（現有行為不變）
2. 若 flag file 不存在 → 讀取 `rules.json` 進行規則匹配
3. 若 `rules.json` 也不存在或為空 → 全部送到 approval server 手動審核

這樣的好處：
- 現有使用者完全不受影響
- 使用者在 UI 上關閉 "Auto Approve All" toggle 後，規則引擎自動接管
- 不需要資料遷移邏輯

#### UI 提示

當 flag file 存在時，PERMISSIONS tab 的規則列表上方顯示提示：

```
⚠ "Auto Approve All" 已啟用，所有規則被繞過。
   關閉 Auto Approve All 以啟用規則引擎。
```

---

## 4. API Contract (Tauri IPC Commands)

### 4.1 新增 Rust 結構體

```rust
// 在 claude.rs 或新檔案 rules.rs 中

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub conditions: RuleConditions,
    pub action: String,      // "allow" | "deny"
    pub priority: i32,
    #[serde(rename = "created_at")]
    pub created_at: String,  // ISO 8601
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleConditions {
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_pattern: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RulesConfig {
    pub version: u32,
    pub rules: Vec<ApprovalRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleMatchResult {
    pub matched: bool,
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub action: Option<String>,  // "allow" | "deny" | null
}
```

### 4.2 Tauri Commands

#### `get_approval_rules` — 取得所有規則

```rust
#[tauri::command]
fn get_approval_rules() -> Result<Vec<ApprovalRule>, String>
```

- 讀取 `~/.claude-cat-monitor/rules.json`
- 若檔案不存在 → 回傳空 `Vec`
- 若 JSON 格式錯誤 → 回傳 `Err` 並附帶錯誤訊息
- 回傳時按 `priority` 升序排列

#### `add_approval_rule` — 新增規則

```rust
#[tauri::command]
fn add_approval_rule(
    name: String,
    tool_name: String,
    path_pattern: Option<String>,
    command_pattern: Option<String>,
    action: String,
) -> Result<ApprovalRule, String>
```

- 自動產生 `id`（UUID v4）、`created_at`（現在時間 ISO 8601）
- `priority` 設為現有最大 priority + 10（若無規則則為 10）
- 驗證 `action` 必須是 `"allow"` 或 `"deny"`
- 驗證 `tool_name` 非空
- 原子性寫入 `rules.json`
- 回傳新建立的完整 `ApprovalRule`

#### `update_approval_rule` — 更新規則

```rust
#[tauri::command]
fn update_approval_rule(
    id: String,
    name: Option<String>,
    enabled: Option<bool>,
    tool_name: Option<String>,
    path_pattern: Option<String>,
    command_pattern: Option<String>,
    action: Option<String>,
) -> Result<ApprovalRule, String>
```

- 只更新傳入的非 `None` 欄位
- **特殊處理**：`path_pattern` 和 `command_pattern` 傳入 `Some("")` 空字串時，視為「清除此欄位」（設為 `None`）
- `id` 不存在 → 回傳 `Err`
- 不可更改 `id`、`created_at`、`priority`（priority 透過 `reorder` 調整）
- 原子性寫入

#### `delete_approval_rule` — 刪除規則

```rust
#[tauri::command]
fn delete_approval_rule(id: String) -> Result<bool, String>
```

- 刪除指定 id 的規則
- 不存在 → 回傳 `Ok(false)`
- 成功刪除 → 回傳 `Ok(true)`
- 原子性寫入

#### `reorder_approval_rules` — 重新排序

```rust
#[tauri::command]
fn reorder_approval_rules(ids: Vec<String>) -> Result<Vec<ApprovalRule>, String>
```

- `ids` 是新順序的 rule ID 列表
- 按 `ids` 順序重新分配 priority：`10, 20, 30, ...`
- `ids` 中不存在的 ID → 忽略
- 現有但未在 `ids` 中出現的規則 → 附加在最後，priority 繼續遞增
- 原子性寫入
- 回傳重新排序後的完整規則列表

#### `check_rule_match` — 測試/預覽匹配結果

```rust
#[tauri::command]
fn check_rule_match(
    tool_name: String,
    tool_input: serde_json::Value,
    cwd: Option<String>,
) -> Result<RuleMatchResult, String>
```

- 使用當前 `rules.json` 的規則進行匹配，回傳匹配結果
- 用途：UI 的「測試規則」功能，讓使用者預覽某個 tool call 會被哪條規則攔截
- 不會實際 approve/deny 任何東西

#### `import_preset_rules` — 匯入預設規則集

```rust
#[tauri::command]
fn import_preset_rules(preset: String) -> Result<Vec<ApprovalRule>, String>
```

- `preset` 值：`"safe_defaults"` | `"permissive"` | `"strict"`
- 將預設規則**合併**到現有規則列表（不覆蓋，追加在最後）
- 若已存在同名規則 → 跳過
- 回傳合併後的完整規則列表

### 4.3 預設規則集

#### `safe_defaults`（推薦的初始設定）

| Priority | Name | Tool | Conditions | Action |
|----------|------|------|------------|--------|
| 5 | Deny rm -rf | Bash | command_pattern: `rm -rf` | deny |
| 6 | Deny sudo | Bash | command_pattern: `sudo ` | deny |
| 10 | Allow Read | Read | — | allow |
| 20 | Allow Grep | Grep | — | allow |
| 30 | Allow Glob | Glob | — | allow |
| 40 | Allow List (ls) | Bash | command_pattern: `ls ` | allow |

#### `permissive`（寬鬆模式）

在 `safe_defaults` 基礎上增加：

| Priority | Name | Tool | Conditions | Action |
|----------|------|------|------------|--------|
| 50 | Allow Edit | Edit | — | allow |
| 60 | Allow Write | Write | — | allow |
| 70 | Allow npm | Bash | command_pattern: `npm ` | allow |
| 80 | Allow git | Bash | command_pattern: `git ` | allow |
| 90 | Allow npx | Bash | command_pattern: `npx ` | allow |

#### `strict`（嚴格模式）

| Priority | Name | Tool | Conditions | Action |
|----------|------|------|------------|--------|
| 5 | Deny rm -rf | Bash | command_pattern: `rm -rf` | deny |
| 6 | Deny sudo | Bash | command_pattern: `sudo ` | deny |
| 10 | Allow Read | Read | — | allow |
| 20 | Allow Grep | Grep | — | allow |
| 30 | Allow Glob | Glob | — | allow |

（其餘全部送手動審核）

### 4.4 在 lib.rs 的註冊

在 `invoke_handler` 中新增：

```rust
get_approval_rules,
add_approval_rule,
update_approval_rule,
delete_approval_rule,
reorder_approval_rules,
check_rule_match,
import_preset_rules,
```

---

## 5. Python Hook 改動

### 5.1 cat-bridge.py 改動概述

`handle_permission_request()` 函式目前只檢查 flag file。改動後：

```python
def handle_permission_request(data: dict):
    """Rule engine: check flag file first, then rules.json."""
    # 1. 既有 flag file 檢查（向下相容，優先於規則）
    flag = os.path.join(MONITOR_DIR, "auto-approve")
    if os.path.isfile(flag):
        _respond_allow()
        return

    # 2. 讀取 rules.json
    rules = _load_rules()
    if not rules:
        return  # 沒有規則 → 不攔截，讓 request 繼續到 approval server

    # 3. 規則匹配
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    cwd = data.get("cwd", "")

    result = _match_rules(rules, tool_name, tool_input, cwd)
    if result is None:
        return  # 無匹配 → 不攔截
    
    if result == "allow":
        _respond_allow()
    elif result == "deny":
        _respond_deny("Denied by rule")
```

### 5.2 規則載入

```python
RULES_FILE = os.path.join(MONITOR_DIR, "rules.json")

def _load_rules() -> list:
    """Load rules from rules.json. Returns empty list on any error."""
    try:
        with open(RULES_FILE, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("version") != 1:
            return []
        rules = data.get("rules", [])
        # 只取 enabled 的規則，按 priority 排序
        active = [r for r in rules if r.get("enabled", False)]
        active.sort(key=lambda r: (r.get("priority", 99999), r.get("created_at", "")))
        return active
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return []
```

### 5.3 規則匹配引擎

```python
import fnmatch

def _match_rules(rules: list, tool_name: str, tool_input: dict, cwd: str) -> str | None:
    """Evaluate rules against a permission request. Returns 'allow', 'deny', or None."""
    for rule in rules:
        conditions = rule.get("conditions", {})
        
        # 1. Tool name match
        rule_tool = conditions.get("tool_name", "")
        if rule_tool != "*" and rule_tool != tool_name:
            continue
        
        # 2. Path pattern match (optional)
        path_pattern = conditions.get("path_pattern")
        if path_pattern:
            # Extract path from tool_input
            target_path = tool_input.get("file_path") or tool_input.get("path")
            if not target_path:
                continue  # Rule requires path but tool doesn't have one
            
            # Resolve relative paths
            if not target_path.startswith("/") and cwd:
                target_path = os.path.join(cwd, target_path)
            
            # Remove trailing slash
            target_path = target_path.rstrip("/")
            
            if not _glob_match(path_pattern, target_path):
                continue
        
        # 3. Command pattern match (optional, Bash only)
        command_pattern = conditions.get("command_pattern")
        if command_pattern:
            if tool_name != "Bash":
                continue  # Command pattern only applies to Bash
            command = tool_input.get("command", "")
            if command_pattern not in command:
                continue
        
        # All conditions matched — first match wins
        return rule.get("action")
    
    return None  # No rule matched

def _glob_match(pattern: str, path: str) -> bool:
    """Glob match with '**' support.
    
    - '*' matches anything except '/'
    - '**' matches anything including '/'
    - '?' matches any single character except '/'
    """
    # If pattern doesn't start with '/', treat as suffix match
    # e.g. 'src/**' matches '/Users/foo/project/src/App.tsx'
    if not pattern.startswith("/"):
        # Find if any suffix of path matches
        parts = path.split("/")
        for i in range(len(parts)):
            candidate = "/".join(parts[i:])
            if fnmatch.fnmatch(candidate, pattern):
                return True
        return False
    else:
        return fnmatch.fnmatch(path, pattern)
```

### 5.4 回應輔助函式

```python
def _respond_allow():
    resp = {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "allow"},
        }
    }
    print(json.dumps(resp))
    sys.exit(0)

def _respond_deny(message: str = ""):
    resp = {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "deny", "message": message},
        }
    }
    print(json.dumps(resp))
    sys.exit(0)
```

### 5.5 效能考量

每次 `PermissionRequest` hook 都會：
1. `os.path.isfile(flag)` — 一次 stat syscall
2. `open + json.load(rules.json)` — 一次 read + JSON parse

預期 `rules.json` 大小 < 10KB（通常 10-30 條規則），JSON parse 時間 < 1ms。這在 hook 的 300s timeout 內完全可忽略。

**不需要 caching**：每次 hook 都是獨立的 Python process，沒有跨次呼叫的狀態可以 cache。

### 5.6 錯誤處理

| 狀況 | 行為 |
|------|------|
| `rules.json` 不存在 | 回傳空規則，不攔截，request 進 approval server |
| `rules.json` 格式損壞 | 同上（log warning 到 stderr） |
| `rules.json` 的 `version` 不是 `1` | 同上 |
| `tool_input` 缺少預期欄位 | 該條件視為不匹配，跳過此規則 |
| Python exception | 不攔截，request 進 approval server（fail-open to manual review） |

**設計原則**：規則引擎的任何錯誤都**不應阻止** request 到達 approval server。最差情況是使用者需要手動審核——這比 request 被錯誤地 auto-approve 或 auto-deny 安全得多。

---

## 6. UI 設計

### 6.1 PERMISSIONS Tab 改版

現有 PERMISSIONS tab 包含：
- Skip Dangerous Mode toggle
- Auto Approve All toggle
- Active Hooks 列表
- FULL TRUST / CAREFUL preset 按鈕

改版後結構：

```
┌─────────────────────────────────────────┐
│ PERMISSIONS                              │
├─────────────────────────────────────────┤
│                                          │
│ ┌─ Global Settings ──────────────────┐  │
│ │ Skip Dangerous Mode        [toggle] │  │
│ │ Auto Approve All           [toggle] │  │
│ └────────────────────────────────────┘  │
│                                          │
│ ⚠ Auto Approve All 已啟用，             │
│   規則引擎被繞過                         │
│   （僅當 Auto Approve All 開啟時顯示）   │
│                                          │
│ ┌─ APPROVAL RULES ──────────────────┐  │
│ │ [+ New Rule]  [Presets ▼]          │  │
│ │                                     │  │
│ │ ⊟ 5  ✖ Deny rm -rf                │  │
│ │      Bash · command: "rm -rf"      │  │
│ │      ● deny                         │  │
│ │                                     │  │
│ │ ⊟ 10 ✓ Allow Read                  │  │
│ │      Read · any path               │  │
│ │      ● allow                        │  │
│ │                                     │  │
│ │ ⊟ 20 ✓ Allow Grep                  │  │
│ │      Grep · any path               │  │
│ │      ● allow                        │  │
│ │                                     │  │
│ │ ⊟ 40 ✓ Allow Edit in src/          │  │
│ │      Edit · path: src/**           │  │
│ │      ● allow                        │  │
│ │                                     │  │
│ │ ═══════════════════════════════     │  │
│ │ Rules not matched → Manual Review   │  │
│ └────────────────────────────────────┘  │
│                                          │
│ ┌─ Active Hooks ─────────────────────┐  │
│ │ PermissionRequest  Stop  ...        │  │
│ └────────────────────────────────────┘  │
│                                          │
│ [FULL TRUST]  [CAREFUL]                  │
└─────────────────────────────────────────┘
```

### 6.2 規則列表 UI

每條規則顯示為一個卡片，包含：

```
┌──────────────────────────────────────────┐
│ ≡  [toggle ■]  Allow Read                │  ← 拖拽手柄 | enabled toggle | 規則名稱
│    Read · any path                       │  ← tool name · 條件摘要
│    ● allow                   [✏] [🗑]    │  ← action badge | 編輯/刪除按鈕
└──────────────────────────────────────────┘
```

- **拖拽排序**：左側 `≡` 手柄，拖放後呼叫 `reorder_approval_rules`
- **啟停 Toggle**：呼叫 `update_approval_rule(id, {enabled: !current})`
- **刪除**：呼叫 `delete_approval_rule(id)`，刪除前顯示確認對話框
- **編輯**：點擊 `✏` 展開 inline 編輯表單
- **Disabled 視覺**：`enabled=false` 時卡片半透明 (opacity: 0.5)
- **Action 色彩**：`allow` = 綠色 badge、`deny` = 紅色 badge

### 6.3 新增規則表單

點擊 `[+ New Rule]` 展開表單：

```
┌─────────────────────────────────────────┐
│ New Approval Rule                        │
│                                          │
│ Name:     [________________________]     │
│                                          │
│ Tool:     [▼ Select tool          ]      │
│           Options: Read, Write, Edit,    │
│           Bash, Grep, Glob, * (Any)      │
│                                          │
│ Path:     [________________________]     │
│           Glob pattern (e.g. src/**)     │
│           (disabled if tool = Bash/*)    │
│                                          │
│ Command:  [________________________]     │
│           Substring match                │
│           (only enabled if tool = Bash)  │
│                                          │
│ Action:   (●) Allow  ( ) Deny            │
│                                          │
│ [Cancel]                    [Add Rule]   │
└─────────────────────────────────────────┘
```

- **Tool 下拉選單**：列出已知的 Claude Code tool names + `*` (Any Tool)
- **Path 欄位**：只在 tool 為 Read/Write/Edit/Grep/Glob 或 * 時可編輯
- **Command 欄位**：只在 tool 為 Bash 時可編輯
- **Name 自動產生**：若使用者不填，根據 tool + conditions + action 自動組合。例如 `"Allow Read"` 或 `"Deny Bash rm -rf"`
- **表單驗證**：
  - Name 不可空（若使用者不填則自動產生）
  - Tool 必選
  - Action 必選
  - Path pattern 若填寫，驗證是否為合法 glob（不含空格開頭等明顯錯誤）

### 6.4 Preset 下拉選單

```
[Presets ▼]
├─ Safe Defaults (recommended)
├─ Permissive
├─ Strict
└─ Clear All Rules
```

- 選擇 preset → 確認對話框 → 呼叫 `import_preset_rules(preset)`
- "Clear All Rules" → 確認對話框（"This will delete all rules"）→ 逐一 `delete_approval_rule`

### 6.5 規則測試功能

在規則列表下方加入折疊式測試區：

```
┌─ Test Rules ─────────────────────────────┐
│ Tool:     [▼ Bash       ]                │
│ Input:    [npm test     ]                │
│ CWD:      [/Users/me/project]            │
│                                          │
│ [Test]                                   │
│                                          │
│ Result: ✅ Matched "Allow npm commands"  │
│         → allow                          │
│                                          │
│ — or —                                   │
│ Result: ⚠ No rule matched               │
│         → Manual review                  │
└──────────────────────────────────────────┘
```

呼叫 `check_rule_match(tool_name, tool_input, cwd)` → 顯示匹配結果。

### 6.6 前端型別定義

在 `src/types.ts` 新增：

```typescript
// ── Approval Rules Types ──

export interface RuleConditions {
  tool_name: string;
  path_pattern?: string;
  command_pattern?: string;
}

export interface ApprovalRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: RuleConditions;
  action: "allow" | "deny";
  priority: number;
  created_at: string;
}

export interface RuleMatchResult {
  matched: boolean;
  rule_id: string | null;
  rule_name: string | null;
  action: "allow" | "deny" | null;
}
```

---

## 7. 向下相容

### 7.1 Auto Approve All 與規則引擎的共存

| Auto Approve All | rules.json 存在 | 行為 |
|-----------------|-----------------|------|
| ON (flag file 存在) | 不重要 | 全部 auto-approve（flag file 優先） |
| OFF | 有規則 | 規則引擎匹配，未匹配的送手動審核 |
| OFF | 無規則/空 | 全部送手動審核（現有行為） |

### 7.2 FULL TRUST 按鈕行為

保持不變：
- FULL TRUST = `skip_dangerous=true` + `auto_approve=true`（寫 flag file）
- 規則引擎被 flag file 繞過

### 7.3 CAREFUL 按鈕行為

保持不變：
- CAREFUL = `skip_dangerous=false` + `auto_approve=false`（刪 flag file）
- 規則引擎自動接管

### 7.4 App 啟動時的行為

目前 `App.tsx` 在啟動時會自動啟用 auto-approve：

```typescript
// App.tsx line ~122
invoke("set_auto_approve", { enabled: true }).catch(() => {});
```

**需要改動**：移除此自動啟用行為。讓使用者自行決定要用 auto-approve 還是規則引擎。

若要保持「開箱即用」體驗，改為：
- 首次啟動（`rules.json` 不存在且 flag file 不存在）→ 自動匯入 `safe_defaults` preset
- 非首次啟動 → 不做任何改動

---

## 8. 邊界案例與安全考量

### 8.1 Path Traversal (`../`)

**策略：不正規化 `..`，但在文件中提醒使用者。**

- `src/../test/foo.ts` 不會被正規化為 `test/foo.ts`
- 如果使用者設了 `src/**` 的 allow rule，`src/../test/foo.ts` **不會**匹配（因為 glob 匹配的是字串，`../test/foo.ts` 不匹配 `src/**`）
- 這是 **safe by default** 的行為——不確定的路徑不會被自動 allow

### 8.2 Symlink

**策略：不跟隨 symlink。**

- 規則匹配的是路徑字串，不是 resolved 路徑
- 如果 `/tmp/safe -> /etc/passwd` 是 symlink，且使用者設了 `/tmp/**` 的 allow rule，`/tmp/safe` 會匹配
- 這是已知限制，但在 Claude Code 的使用場景中，symlink 攻擊向量很小（tool calls 由 LLM 產生，不是外部惡意輸入）

### 8.3 相對路徑 vs 絕對路徑

- 規則的 `path_pattern` 可以是相對或絕對
- Tool input 中的路徑若為相對，以 `cwd` 為 base 組合為絕對路徑
- 匹配時：
  - 絕對 pattern（`/Users/**`）→ 與絕對路徑匹配
  - 相對 pattern（`src/**`）→ 嘗試匹配路徑的任意後綴（見 Section 5.3 `_glob_match`）

### 8.4 Unicode / 特殊字元

- JSON 原生支援 Unicode，規則名稱和 pattern 都可含中文等字元
- 路徑中的空格：JSON 字串原生處理，不需 escape
- 路徑中的 glob 特殊字元（`*`, `?`, `[`, `]`）：在 `path_pattern` 中保留語義，在 tool_input 路徑中作為字面值。Python `fnmatch` 會正確處理

### 8.5 規則為空時的行為

- `rules.json` 存在但 `rules` array 為空 → 所有 request 送手動審核
- 所有規則都 `enabled=false` → 同上
- 這是明確且安全的預設行為

### 8.6 設定檔被外部修改

- Python bridge 每次都重新讀取 `rules.json`，所以外部修改立即生效
- Rust 端的 CRUD 操作使用原子性寫入（temp + rename），不會產生 partial write
- UI 不做 file watcher（太複雜且收益小）。使用者如果在外部編輯了 `rules.json`，需要切換 tab 或重新整理來看到更新
- **競爭條件**：UI 更新 rules.json 和 Python bridge 讀取可能同時發生。原子性寫入確保 Python 讀到的是完整的舊版或完整的新版，不會是半成品

### 8.7 Bash Command Pattern 的限制

`command_pattern` 使用 substring 匹配，不支援 regex。這是刻意的：

- Regex 在 UI 中難以正確輸入和理解
- Substring 匹配已足夠覆蓋常見 case（`npm `, `git `, `rm -rf`, `sudo `）
- 使用者可以組合多條規則來達到 regex 的效果

**已知繞過方式**：
- 如果使用者設了 `command_pattern: "rm -rf"`，Claude 可以用 `rm -r -f` 或 `find . -exec rm -rf {} \;` 繞過
- 這是 substring 匹配的本質限制。Spec 建議在 UI 中加入提示文字：「Command matching is substring-based and can be bypassed. Use as a convenience, not a security boundary.」

### 8.8 tool_input 結構不一致

Claude Code 的 `tool_input` 結構可能隨版本變化。防禦策略：

- 從 `tool_input` 取欄位時使用 `.get()` 而非直接索引
- 缺少預期欄位時，該條件視為不匹配（fail-safe）
- 不依賴 `tool_input` 中的非核心欄位

### 8.9 大量規則的效能

- 預期使用者有 10-50 條規則
- 每條規則的匹配是 O(1)（string compare + fnmatch），50 條規則的匹配 < 1ms
- 不需要索引或最佳化

---

## 9. 實作順序建議

### Phase 1: Rust 後端（規則 CRUD + 持久化）

1. 新增 `src-tauri/src/rules.rs` 模組
2. 實作 `RulesConfig` 的讀寫（含原子性寫入）
3. 實作 6 個 Tauri commands
4. 在 `lib.rs` 註冊 commands
5. 實作預設規則集

### Phase 2: Python Hook（規則匹配引擎）

1. 修改 `cat-bridge.py` 的 `handle_permission_request()`
2. 加入 `_load_rules()`、`_match_rules()`、`_glob_match()`
3. 加入 `_respond_deny()` 輔助函式
4. 測試各種匹配 case

### Phase 3: Frontend UI（規則管理介面）

1. 在 `src/types.ts` 新增型別
2. 改造 `PermissionPanel.tsx`：加入規則列表 + CRUD UI
3. 實作拖拽排序（可用 `@dnd-kit/sortable` 或手寫）
4. 實作新增規則表單
5. 實作 preset 匯入
6. 實作規則測試功能

### Phase 4: 整合與測試

1. 移除 `App.tsx` 中的自動 auto-approve 啟用
2. 加入首次啟動邏輯（自動匯入 safe_defaults）
3. 端到端測試：建立規則 → 觸發 PermissionRequest → 驗證 auto-approve/deny
4. 測試向下相容：flag file 存在時規則被繞過

---

## 10. 檔案變動清單

| 檔案 | 操作 | 說明 |
|------|------|------|
| `src-tauri/src/rules.rs` | **新增** | 規則 CRUD、持久化、匹配邏輯（Rust） |
| `src-tauri/src/lib.rs` | 修改 | 新增 `mod rules;`、註冊 7 個 Tauri commands |
| `src-tauri/resources/cat-bridge.py` | 修改 | 加入規則匹配引擎（Python） |
| `src-tauri/src/claude.rs` | 修改 | 可能移除/調整 `set_auto_approve` 相關邏輯（保留向下相容） |
| `src/types.ts` | 修改 | 新增 `ApprovalRule`, `RuleConditions`, `RuleMatchResult` 型別 |
| `src/components/PermissionPanel.tsx` | 修改 | 加入規則列表 UI、新增/編輯/刪除表單、preset 匯入、規則測試 |
| `src/App.tsx` | 修改 | 移除自動 auto-approve 啟用、加入首次啟動 preset 匯入邏輯 |
| `src/App.css` | 修改 | 規則卡片、表單、拖拽等 CSS 樣式 |
| `src-tauri/Cargo.toml` | 修改 | 加入 `uuid` crate 和可能的 `glob` crate |
