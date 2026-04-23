# Codex CLI Research Notes

## 實際驗證結果（本機 ~/.codex/）

### 目錄結構
```
~/.codex/
├── config.toml              # 專案信任等級、plugin 設定
├── .codex-global-state.json # UI 狀態
├── installation_id          # UUID
├── auth.json                # 認證憑證
├── models_cache.json        # 模型清單快取
├── state_5.sqlite           # 主資料庫（threads 表）
├── logs_2.sqlite            # 執行日誌
├── session_index.jsonl      # 輕量 session 索引
├── archived_sessions/       # 對話 JSONL 檔
│   └── rollout-{timestamp}-{uuid}.jsonl
├── sessions/                # 空目錄（活躍 session 在 SQLite）
├── plugins/
├── skills/
├── rules/
└── memories/
```

### SQLite threads 表 schema（session metadata）
```sql
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,          -- "vscode"
    model_provider TEXT NOT NULL,  -- "openai"
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,   -- "on-request"
    tokens_used INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    cli_version TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '',
    git_sha TEXT, git_branch TEXT, git_origin_url TEXT,
    ...
);
```

### JSONL 對話格式（archived_sessions/rollout-*.jsonl）

每行一個 JSON，type 欄位區分：

1. **session_meta** — 第一行，session metadata
   ```json
   {"timestamp":"...","type":"session_meta","payload":{"id":"...","cwd":"...","cli_version":"0.122.0-alpha.1","source":"vscode","model_provider":"openai"}}
   ```

2. **event_msg** — 事件（task_started 等）
   ```json
   {"timestamp":"...","type":"event_msg","payload":{"type":"task_started","turn_id":"...","model_context_window":258400}}
   ```

3. **turn_context** — 每個 turn 的上下文
   ```json
   {"timestamp":"...","type":"turn_context","payload":{"turn_id":"...","cwd":"...","approval_policy":"on-request","model":"gpt-5.4"}}
   ```

4. **response_item** — 對話內容，多種子類型：
   - `role=user, type=message, content=[{type:"input_text"}]` — 使用者輸入
   - `role=assistant, type=message, content=[{type:"output_text"}]` — AI 回覆
   - `role=developer, type=message` — 系統指令
   - `type=reasoning` — 推理過程（無 role）
   - `type=function_call` — 工具呼叫（無 role）
   - `type=function_call_output` — 工具結果（無 role）
   - `type=custom_tool_call` / `type=custom_tool_call_output`

### session_index.jsonl 格式
```json
{"id":"uuid","thread_name":"title","updated_at":"ISO-8601"}
```

### 進程偵測
- App binary: `/Applications/Codex.app/Contents/MacOS/Codex`
- pgrep: `pgrep -f "Codex"` 或 `pgrep Codex`
- source 通常是 "vscode"

### Hook 支援
- **不支援 Claude Code 風格的 hooks**
- 有 plugins/skills/rules 機制但格式完全不同
- approval 透過 `--approval-mode` 控制
