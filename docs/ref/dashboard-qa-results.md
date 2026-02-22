# Dashboard QA 行為測試報告

> 測試日期：2026-02-21 | 基於 server.js + dashboard.md 規格（v5.0.5）

## 環境

- **服務**：`bun /Users/sbu/projects/vibe/plugins/vibe/server.js`（已啟動）
- **健康檢查**：✅ Port 3800 回應 200

---

## HTTP API 測試結果

| # | 操作 | 預期 | 實際 | 結果 |
|:-:|------|------|------|:----:|
| 1 | `GET /` | 200 + HTML | 200 + `text/html; charset=utf-8` | ✅ |
| 2 | `GET /api/sessions` | 200 + JSON `{ [sid]: state }` | 200 + Object with UUID keys | ✅ |
| 3 | `GET /api/clients` | 200 + `{ count: number }` | 200 + `{"count":5}` | ✅ |
| 4 | `GET /api/registry` | 200 + stages/pipelines/agents | 200 + 9 stages, 10 pipelines, 10 agents | ✅ |
| 5 | `POST /api/sessions/cleanup` | 200 + `{ ok, cleaned }` | 200 + `{"ok":true,"cleaned":0}` | ✅ |
| 6 | `GET /styles.css` | 200 + CSS | 200 + 26,045 bytes | ✅ |
| 7 | `GET /app.js` | 200 + JS | 200 + 18,354 bytes | ✅ |
| 8 | `GET /components/sidebar.js` | 200 + JS module | 200 + 4,060 bytes | ✅ |
| 9 | `GET /components/dag-view.js` | 200 + JS module | 200 + 9,409 bytes | ✅ |
| 10 | `GET /state/pipeline.js` | 200 + JS module | 200 + 4,014 bytes | ✅ |
| 11 | `GET /lib/utils.js` | 200 + JS module | 200 + 2,081 bytes | ✅ |

## WebSocket 測試結果

| # | 操作 | 預期 | 實際 | 結果 |
|:-:|------|------|------|:----:|
| 12 | 連線 `ws://localhost:3800/ws` | 連線成功 | `WebSocket CONNECTED` | ✅ |
| 13 | 接收 `init` 訊息 | `{ type: "init", sessions, alive, metrics }` | sessions=1, alive=150 | ✅ |
| 14 | 發送 `ping` → 接收 `pong` | 伺服器回傳 `"pong"` | `ping→pong: OK` | ✅ |

## 安全驗證結果

| # | 操作 | 預期 | 實際 | 結果 |
|:-:|------|------|------|:----:|
| 15 | `DELETE /api/sessions/not-a-uuid` | 400 + UUID 格式錯誤 | 400 + `{"ok":false,"error":"invalid session id"}` | ✅ |
| 16 | `GET /../../../etc/passwd` | 404（路徑遍歷防護） | 404 | ✅ |
| 17 | `GET /%2e%2e%2fetc%2fpasswd` | 404（URL encoded 防護） | 404 | ✅ |
| 18 | `GET /nonexistent-page` | 404 | 404 | ✅ |
| 19 | `DELETE /api/sessions/{valid-uuid-not-exist}` | 200 + `{ ok: true }` | 200 + `{"ok":true,"deleted":"..."}` | ✅ |

---

## /api/registry 完整性驗證

| 檢查項目 | 預期 | 實際 | 結果 |
|---------|------|------|:----:|
| 包含 pipeline-architect | true | true | ✅ |
| 全部 9 個 stage 存在 | PLAN,ARCH,DESIGN,DEV,REVIEW,TEST,QA,E2E,DOCS | 9 stages | ✅ |
| 每個 stage 有 agent/emoji/label/color | 全部必要欄位存在 | 9/9 OK | ✅ |
| stages 為 Object | is_object=true | true | ✅ |
| pipelines 為 Object | is_object=true | true | ✅ |
| agents 為 Array | is_array=true | true | ✅ |
| agents 總數 | 10（9 stage agents + pipeline-architect） | 10 | ✅ |

---

## 三維驗證摘要（OpenSpec Verify）

| 維度 | 結果 | 說明 |
|------|:----:|------|
| 完整性 | ✅ | dashboard.md 3.2 節全部 11 個 HTTP 端點均已實作並通過測試 |
| 正確性 | ✅ | 所有 WHEN/THEN 行為（回應格式、狀態碼、安全防護）符合規格 |
| 一致性 | ✅ | server.js 架構與 dashboard.md 描述一致（Bun HTTP+WS、/api/registry 動態 metadata、路徑遍歷防護） |

---

## 問題清單

### WARNING
- 路徑遍歷防護回傳 404 而非 403（server.js L482：`WEB_DIR` 邊界檢查後 fall-through 到靜態 404）。技術上安全，但 RFC 最佳實踐建議 403。
- `/api/sessions` 目前只有 1 個 session，`alive` 回傳 150 個 session 的 heartbeat 存在，顯示舊 session heartbeat 檔案未清理。

### SUGGESTION
- `DELETE /api/sessions/{有效 UUID 但不存在}` 回傳 `200 + ok:true`，可考慮改為 `404` 以更符合 REST 語意。

---

## 測試執行摘要

- **總測試數**：19
- **通過**：19 / 19
- **失敗**：0
- **警告**：2（不影響功能）
- **服務狀態**：測試期間未重啟（預存服務）
