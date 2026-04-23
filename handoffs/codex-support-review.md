# Review Report: Multi-Provider Architecture + Codex Support

## Stage
Review

## Issues Found & Resolution

### P0 — 已修復
1. **SQL/shell injection** (codex.rs) — 新增 `is_valid_session_id()` 驗證，移除 `replace('\'', "''")`
2. **i64 cast overflow** (codex.rs:197) — 加 `std::cmp::min(tail_bytes, i64::MAX as u64)` guard

### P1 — 已修復
- **provider optional vs required** (types.ts) — 改為 required，消除所有 `?? "claude"` fallback

### P1 — 接受風險 / 後續改善
- `parse_iso8601_to_millis` 近似計算：排序用途可接受
- `pgrep -f "Codex"` 過寬：目前可用，後續可精確化
- `archived` 冗餘邏輯：不影響正確性
- 效能（每 3 秒 fork sqlite3 + pgrep）：目前可接受，後續考慮 rusqlite
- 缺 codex.rs 測試：後續補

### P2 — 記錄，不阻擋 ship
- state_5.sqlite 硬寫檔名
- discover_from_index cwd 空字串
- hasMultipleProviders 重複計算
- JUMP hardcode "Codex" app name
- [X] prefix 可讀性

## Verification
- cargo check: PASS
- tsc --noEmit: PASS
- npm test: 42/42 PASS

## Gate Verdict
PASS — P0 已修復，可 ship

## Next Recommended Stage
Ship
