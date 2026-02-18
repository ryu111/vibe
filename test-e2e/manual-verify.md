# Pipeline v4 手動驗證指引

> 本文件補充自動化 E2E 測試無法覆蓋的場景：
> Dashboard 即時性、WebSocket 即時推播、真實並行委派行為、ECC 平台特性。

**前置條件**（所有場景）：
```bash
# 啟動 vibe 開發環境
vc   # alias for: claude --plugin-dir ~/projects/vibe/plugins/vibe --plugin-dir ~/projects/vibe/plugins/forge

# 確認 Dashboard 已啟動
open http://localhost:3800
```

---

## I02：Dashboard WebSocket 即時更新

**場景描述**：驗證 Pipeline 執行中 Dashboard 透過 WebSocket 即時更新狀態，不需手動刷新頁面。

### 前置條件

- Dashboard 已啟動（`http://localhost:3800`）
- 瀏覽器開啟 Dashboard，切到 **Pipeline** 分頁

### 操作步驟

1. 在 Claude Code 送出以下 prompt：
   ```
   [pipeline:quick-dev] 修復 plugins/vibe/scripts/lib/hook-logger.js 的 truncate 函式，空字串應直接回傳空字串
   ```
2. 立即切換到瀏覽器的 Dashboard
3. 觀察 Pipeline 流程圖（第 2 分頁）
4. 不要手動刷新瀏覽器

### 預期結果

- [ ] Pipeline 流程圖自動顯示 DEV 階段進入 **active**（黃色或 spinning 動畫）
- [ ] DEV 完成後，REVIEW 自動轉為 active
- [ ] TEST 跟 REVIEW 同時為 active（barrier 並行）
- [ ] 所有階段完成後，顯示 COMPLETE
- [ ] **全程無需手動刷新頁面**

### 截圖位置

- `DEV active 時的 Pipeline 流程圖`：確認 DEV 卡片有 active 樣式
- `REVIEW+TEST 並行時的 Pipeline 流程圖`：兩個卡片同時顯示 active
- `COMPLETE 時的 Pipeline 流程圖`：所有卡片顯示完成狀態

---

## I03：Dashboard v4 State 適配

**場景描述**：驗證 Dashboard 前端正確適配 v4 state schema，各項指標正常顯示。

### 前置條件

- Dashboard 已啟動
- 執行過至少一次 pipeline（有 state 歷史）

### 操作步驟

1. 在 Claude Code 送出：
   ```
   [pipeline:standard] 新增 plugins/vibe/scripts/lib/utils/string-helpers.js，包含 truncate、capitalize 兩個工具函式
   ```
2. 開啟 Dashboard → **Dashboard** 分頁（第 1 分頁）
3. 觀察以下項目：
   - **Pipeline 指標面板**（完成比、階段數）
   - **Agent Status Panel**（14 agents 狀態）
   - **Mini Timeline**（里程碑事件）

### 預期結果

- [ ] Pipeline 指標面板顯示正確的階段數（standard = 6 stages）
- [ ] 指標中「完成比」隨 pipeline 進行動態更新（DEV 完成後 33%，依此類推）
- [ ] Agent Status Panel 在 DEV 委派時顯示 developer agent 的 active 燈號（綠色/黃色脈衝）
- [ ] Mini Timeline 正確顯示 `delegation.start`、`stage.complete`、`pipeline.complete` 等里程碑事件
- [ ] **不應出現** `Cannot read property of undefined` 等 JS 錯誤（開啟瀏覽器 Console 確認）

### 額外驗證步驟

4. 按 F12 開啟瀏覽器開發者工具 → Console
5. 確認無 JS 錯誤

### 截圖位置

- `指標面板完成進度`：確認百分比和階段數正確
- `Agent Status Panel active 狀態`：developer agent 燈號為綠/黃
- `Mini Timeline 里程碑事件`：確認事件類型和時間戳

---

## F05：ECC 真實並行委派行為

**場景描述**：驗證 REVIEW + TEST 確實以並行方式執行（ECC Sub-agent 限制：sub-agent 無法再生 sub-agent，barrier 機制需由 stage-transition hook 協調）。

### 前置條件

- 使用 quick-dev pipeline（DEV → REVIEW + TEST 並行）
- Dashboard 開啟且在 Pipeline 分頁

### 操作步驟

1. 送出 prompt：
   ```
   [pipeline:quick-dev] 補完 plugins/vibe/scripts/lib/sentinel/tool-detector.js 的邊界條件測試
   ```
2. 等待 DEV 階段完成
3. 仔細觀察 REVIEW 和 TEST 的啟動時序

### 預期結果（v4 barrier 機制）

- [ ] DEV 完成後，Main Agent 收到 `⛔ Pipeline [quick-dev]（DEV → REVIEW + TEST）已建立` 的 systemMessage
- [ ] REVIEW 委派首先啟動
- [ ] REVIEW 完成後回傳 `<!-- PIPELINE_ROUTE: {"verdict":"PASS","route":"BARRIER",...} -->`
- [ ] stage-transition hook 接收到 BARRIER route，等待 TEST 完成
- [ ] TEST 委派隨後啟動（**注意**：ECC 限制下可能是序列而非真正同時）
- [ ] 兩者都完成後，barrier 解鎖，pipeline COMPLETE

### 驗證 Barrier State

執行後查看 barrier state 檔案：
```bash
# 執行 pipeline 時在另一個終端觀察
watch -n 1 "ls ~/.claude/barrier-state-*.json 2>/dev/null && cat ~/.claude/barrier-state-*.json | python3 -m json.tool"
```

- [ ] 第一個 stage 完成時，barrier-state 記錄 `completed: [REVIEW]`
- [ ] 第二個 stage 完成時，barrier-state 被刪除（deleteBarrier on PASS）

### 截圖位置

- `barrier state 第一個 stage 完成時`：`completed: ["REVIEW"]`
- `Pipeline COMPLETE 狀態`：確認兩個 stage 都已完成

---

## B05：Full 九階段含 DESIGN 執行（前端專案）

**場景描述**：驗證前端專案中 DESIGN 階段不被跳過，full pipeline 確實執行 9 個完整階段。

### 前置條件

- 需要一個前端專案（含 React/Next.js 依賴）
- 建議使用 E2E 框架的 `frontend` variant，或手動建立：
  ```bash
  # 在一個測試目錄建立前端環境
  mkdir /tmp/test-frontend && cd /tmp/test-frontend
  git init
  echo '{"dependencies":{"react":"^19.0.0","next":"^15.0.0"}}' > package.json
  mkdir -p src/components
  echo 'export default function App() { return <div>Hello</div>; }' > src/components/App.tsx
  git add . && git commit -m "init"
  ```
- 在該目錄啟動 `vc`

### 操作步驟

1. 在前端專案目錄送出：
   ```
   [pipeline:full] 新增一個 StatusBadge React 組件到 src/components/StatusBadge.tsx
   ```
2. 觀察 pipeline 執行流程

### 預期結果

- [ ] env-detector 偵測到前端框架（React/Next.js）
- [ ] DESIGN 階段**不被跳過**（非前端時 DESIGN 會被 skip-predicates 跳過）
- [ ] designer agent 被委派，產出 design-system.md 或 mockup
- [ ] 全 9 個階段依序執行：PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → E2E → DOCS
- [ ] Dashboard 流程圖顯示所有 9 個階段

### 驗證方式

```bash
# Pipeline 完成後查看 state
node -e "
  const s = JSON.parse(require('fs').readFileSync(
    require('os').homedir() + '/.claude/pipeline-state-\$(ls ~/.claude/pipeline-state-*.json | tail -1 | xargs basename | sed \"s/pipeline-state-//;s/.json//\")', 'utf8'));
  console.log('Stages:', Object.keys(s.dag));
  console.log('Skipped:', Object.entries(s.stages).filter(([,v]) => v.status === 'skipped').map(([k]) => k));
"
```

- [ ] `Object.keys(s.dag)` 包含全部 9 個 stage（含 DESIGN）
- [ ] skipped 陣列**不含** DESIGN

### 截圖位置

- `env-detector 前端偵測結果`：state 中 environment.framework 含前端框架
- `DESIGN 階段 active`：designer agent 正在執行
- `全 9 階段完成的 Pipeline 流程圖`

---

## 快速驗證 Checklist

完成所有手動驗證後，請確認以下項目：

| 場景 | 核心驗證點 | 狀態 |
|------|-----------|------|
| I02 | WebSocket 即時更新，無需刷新 | [ ] |
| I03 | v4 state 在 Dashboard 正確顯示，無 JS 錯誤 | [ ] |
| F05 | Barrier 並行機制正確，barrier-state 被清除 | [ ] |
| B05 | 前端專案 DESIGN 不跳過，9 階段完整執行 | [ ] |

---

*建立日期：2026-02-19 | 對應 OpenSpec change: v4-real-testing*
