# Dashboard Issues — 待做清單

> 從 `dashboard.md` 規格分析中提取的已知問題和改進項目。
> 基於 vibe v5.0.4，`web/index.html` + `server.js` 實際程式碼審查。
> Phase 1-5 重設計完成（v5.0.5），部分問題已解決；v5.0.8 時前端組件化重構完成，見各項標記。

---

## Bug Fixes（已損壞/不正確的功能）

- [x] **MILESTONE_TYPES 含 4 個無效事件類型** ✅ 已解決（Phase 1-3 重設計）：新 Dashboard 里程碑事件清單已修正，移除 `delegation.end`/`pipeline.init`/`pipeline.classified`/`block.prevented` 等無效類型，改為 `task.classified`/`tool.blocked` 等正確類型。
- [ ] **Session 資源指標未渲染**：`.sc-res`（CPU/RAM 指標）CSS 已完整定義（`.sc-res-bar`、`.sc-res-fill.cpu`、`.sc-res-fill.ram`），但前端 Session Card 模板完全沒有渲染這個元素，功能停擺
- [ ] **skillsLit 布林值無法顯示使用中的 skill**：`getAgentInfo()` 回傳 `skillsLit = isActive`（純布林），`AgentStatus` 中所有 skill chip 要嘛全亮、要嘛全暗，無法顯示目前真正使用中的具體 skill（`r?.skillsUsed` 有資料但沒傳到 `AgentStatus`）
- [ ] **DESIGN stage 在 Pixel 模式沒有工位（多處缺失）**：Pixel 模式下 DESIGN stage 缺失三個映射：
  1. `CHARS['designer']` 未定義 — `charShadow()` 對 designer 回傳空字串，工位角色完全不可見
  2. `MA_POS` 缺少 `DESIGN` 鍵 — Main Agent 進入 DESIGN stage 時，位置 fallback 到 `MA_IDLE`（辦公室左上角），不會移動到 DESIGN 工位
  3. `DESK_OBJ` 缺少 `DESIGN` 鍵 — DESIGN 工位的桌面物件 `${DESK_OBJ[stage]}` 渲染為 `undefined`（顯示為空）
- [x] **stale 判斷閾值不一致** ✅ 已解決（Phase 1 server.js 修復）：`server.js` 已統一使用 `STALE_THRESHOLD_MS = 30 * 60 * 1000`（30 分鐘），與前端 sidebar 一致。
- [ ] **`ac-skill.used` 判斷永遠為 false**：`AgentCard` 中 `r?.skillsUsed?.includes(sk)` 判斷 skill 是否已使用，但 `stageResults` 的 `verdict` 物件沒有 `skillsUsed` 欄位（v4 state schema 無此欄位），永遠顯示未使用狀態

---

## Tech Debt（技術債務）

- [x] **`server.js` AGENT_EMOJI 與 `registry.js` STAGES 重複** ✅ 已解決（Phase 1 重設計）：`server.js` 現在動態從 `registry.js` 的 `STAGES` 建構 `AGENT_EMOJI`，消除重複維護。
- [x] **前端 `SM` 物件與 `registry.js` 不同步** ✅ 已解決（Phase 1-3 重設計）：新 Dashboard 透過 `/api/registry` 端點動態取得 stage metadata，前端不再有硬編碼的 `SM` 物件。
- [x] **前端 `TYPE_LABELS` 與 `registry.js` 重複** ✅ 已解決（Phase 1-3 重設計）：新 Dashboard 透過 `/api/registry` 取得 pipeline 標籤，前端的 `typeLabel()` 函式直接使用 `registry.pipelines[t].label`。
- [x] **`config.json` taskRoutes 與 `registry.js` REFERENCE_PIPELINES 重複** ✅ 已解決（Phase 5 清理）：`dashboard/config.json` 已移除（整個 build-time 靜態生成系統已廢棄），不再有重複定義。
- [x] **`adaptState()` 適配層長期應移除** ✅ 已解決（Phase 1-3 重設計）：新 Dashboard 完全移除 `adaptState()`，直接操作 v4 DAG state（`dag`/`stages` 欄位）。
- [ ] **`adaptState()` 的 `environment` 欄位說明不精確**：`adaptState()` 輸出的 `environment` 欄位直接使用 `raw.environment || {}`，但 v4 state schema 本身不保證 `environment` 存在（該欄位是 pipeline-architect agent 自行填入的選填欄位），`node-context.js` 注入給 sub-agent 的環境快照欄位名為 `env`（精簡版），兩者語意不同
- [ ] **`AGENT_ROSTER` 中 `main`、`explore`、`plan` 三個系統 agent 無真實對應**：這三個 agent 是前端 UI 概念（從 pipeline agent 推斷 Main Agent 狀態），但顯示方式（detect `delegation.start` 事件）不夠精確，可能誤報
- [x] **eventCat 分類邏輯在 `server.js` 和 `schema.js` 各定義一份** ✅ 已解決（Phase 1 server.js 修復）：`server.js` 現在動態從 `schema.js` 的 `CATEGORIES` 建構 `EVENT_TYPE_TO_CAT` 映射，`eventCat()` 函式使用此映射，消除重複。
- [ ] **Timeline 事件的 `agent name` 無獨立欄位**：`formatEvent()` 把 emoji + text 合成一個字串，前端無法獨立取得 agent 名稱做進一步篩選或群組

---

## Enhancements（改進項目）

- [ ] **DESIGN stage 加入 designer 像素角色**：補充 `CHARS.designer` 7×10 像素網格定義 + `CHAR_PAL.designer` 調色盤，使 Pixel 模式下 DESIGN 工位有可見的角色
- [ ] **Timeline 事件加入 `agent` 獨立欄位**：`formatEvent()` 回傳物件補充 `agent` 欄位，方便前端做 per-agent 篩選和顯示
- [ ] **Runtime/Build-time 主題系統統一**：Runtime SPA 的 `:root` 色彩變數（Catppuccin Mocha）與 Build-time 靜態生成的 10 主題系統分開維護，應抽取共用設計 token
- [ ] **Dashboard Tab 里程碑事件可切換完整模式**：右欄「最近事件」目前只顯示里程碑類型（過濾 `tool.used`），應提供切換按鈕顯示完整事件流
- [ ] **Session Card 加入 pipeline 類型 emoji 圖示**：目前 Session Card 只顯示文字 pipeline 標籤，加入對應 emoji 可提升辨識度
- [ ] **WebSocket 重連狀態更豐富**：目前重連中只顯示「連線中…」橘色點，可以顯示重試次數和下次重試倒數
- [ ] **Pixel 模式 DESIGN 工位補齊缺口**：除像素角色外，DESIGN stage 在 `ROW1` 中有工位但 `SM.DESIGN.todos` 的掃描動畫可能不夠精確（目前顯示讀取 design.md / 偵測 search.py / 產出設計系統 / 產出 HTML mockup / 開啟瀏覽器預覽）
- [ ] **報告導出加入 timeline 篩選狀態**：`exportReport()` 目前固定取前 30/50 筆 timeline，應尊重當前 `tlFilter`/`tlTab` 篩選設定
- [ ] **Session 資源指標（CPU/RAM）真實資料源**：CSS 已定義 `.sc-res`，需要在後端 state 加入 CPU/RAM 指標欄位並在 Session Card 渲染
- [ ] **快捷鍵 `?` 提示 Toast 內容不完整**：`?` 鍵觸發的 Toast 提示字串只列出部分快捷鍵（`1/2/3 Tab · ↑↓ 切換 · S 側邊 · F 全螢幕 · C 聚焦 · E 導出 · P 主題 · ⌘± 縮放`），缺少 `j/k` 替代鍵說明；另外目前程式碼無 `Escape` 鍵處理，若需要關閉全螢幕等功能應補充

---

## 優先級排序

| 優先級 | 問題 | 影響範圍 | 理由 |
|:------:|------|---------|------|
| 高 | `MILESTONE_TYPES` 含 4 個無效事件類型 | `index.html` MILESTONE_TYPES | 里程碑過濾含 dead filter，可能遺漏應顯示的事件 |
| 高 | DESIGN stage 無像素工位（pixel 模式 CHARS/MA_POS/DESK_OBJ 三處缺失） | `index.html` CHARS + MA_POS + DESK_OBJ | 功能損壞，使用者可見 |
| 高 | `ac-skill.used` 永遠為 false | `index.html` AgentCard | 功能損壞，skills 狀態顯示完全無效 |
| 高 | `skillsLit` 布林值無法顯示使用中 skill | `index.html` getAgentInfo | Agent 面板 skill chip 資訊失準 |
| 中 | `stale` 判斷閾值不一致（30min vs 1h） | `index.html` + `server.js` | 邏輯矛盾，使用者預期行為不符 |
| 中 | `server.js` AGENT_EMOJI 與 `registry.js` 重複 | `server.js` L126-133 | 維護風險，新增 agent 容易漏更新 |
| 中 | 前端 `SM` 與 `registry.js` 不同步 | `index.html` SM 物件 | 維護風險，新增/修改 stage 需雙重維護 |
| 中 | `adaptState()` 適配層長期應移除 | `index.html` adaptState() | 技術債，增加除錯複雜度 |
| 低 | `eventCat` 在 server.js 和 schema.js 各一份 | `server.js` eventCat() | 技術債，低風險重複 |
| 低 | Session 資源指標 CSS 已定義但未渲染 | `index.html` Session Card | 功能缺席，非阻斷性 |
| 低 | Timeline 事件缺 `agent` 獨立欄位 | `server.js` formatEvent() | 改進項目，影響未來可擴充性 |

---

## Phase 1-5 重設計成果（v5.0.5）

以下功能已在 Dashboard Phase 1-5 重設計中完成：

| 功能 | 說明 |
|------|------|
| DAG 流程圖 | 取代 Snake Grid + Pixel Office，SVG+HTML 混合 DAG 視覺化 |
| StatsCards 統計卡片 | 4 張統計卡片（Compact/Guard 攔截/Retry 回退/Session 時長）|
| 動態 Pipeline 進度條 | 各 stage 狀態色塊 |
| Sidebar 自動排序 | 活躍優先 → 最近活動，移除排序下拉 |
| Toolbar 精簡 | 保留全螢幕/導出/縮放，移除像素主題和聚焦模式 |
| /api/registry 端點 | stages/pipelines/agents metadata，前端不再硬編碼 |
| Heartbeat Memory 顯示 | Agent 面板標題列顯示 Server heap 用量（MB）|

## 相關檔案索引

| 檔案 | 路徑 | 狀態 |
|------|------|------|
| Runtime SPA | `plugins/vibe/web/` | ✅ 重設計完成（Phase 1-5）+ ✅ v5.0.8 組件化重構|
| Dashboard Server | `plugins/vibe/server.js` | ✅ 重構完成（registry/schema/stale 統一）|
| Stage Registry | `plugins/vibe/scripts/lib/registry.js` | ✅ 現為 SoT，server.js 動態引用 |
| Timeline Schema | `plugins/vibe/scripts/lib/timeline/schema.js` | ✅ CATEGORIES 現由 server.js 動態引用 |
| 視覺配置 | `dashboard/config.json` | ✅ 已廢棄移除（build-time 靜態系統廢棄）|
