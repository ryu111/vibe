# Dashboard Issues — 待做清單

> 從 `dashboard.md` 規格分析中提取的已知問題和改進項目。
> 基於 vibe v2.0.13，`web/index.html` + `server.js` 實際程式碼審查。

---

## Bug Fixes（已損壞/不正確的功能）

- [ ] **MILESTONE_TYPES 含 4 個無效事件類型**：Dashboard Tab 右欄「最近事件」的里程碑過濾清單 `MILESTONE_TYPES`（`index.html` L1835）包含 4 個在 `schema.js` 中不存在的事件類型，這些類型永遠不會匹配到任何實際 timeline 事件（dead filter 條目）：
  - `delegation.end`（schema.js 只有 `delegation.start`，無對應 end 事件）
  - `pipeline.init`（不存在，分類完成事件為 `task.classified`）
  - `pipeline.classified`（不存在，應為 `task.classified`）
  - `block.prevented`（不存在，工具阻擋事件為 `tool.blocked`）
- [ ] **Session 資源指標未渲染**：`.sc-res`（CPU/RAM 指標）CSS 已完整定義（`.sc-res-bar`、`.sc-res-fill.cpu`、`.sc-res-fill.ram`），但前端 Session Card 模板完全沒有渲染這個元素，功能停擺
- [ ] **skillsLit 布林值無法顯示使用中的 skill**：`getAgentInfo()` 回傳 `skillsLit = isActive`（純布林），`AgentStatus` 中所有 skill chip 要嘛全亮、要嘛全暗，無法顯示目前真正使用中的具體 skill（`r?.skillsUsed` 有資料但沒傳到 `AgentStatus`）
- [ ] **DESIGN stage 在 Pixel 模式沒有工位（多處缺失）**：Pixel 模式下 DESIGN stage 缺失三個映射：
  1. `CHARS['designer']` 未定義 — `charShadow()` 對 designer 回傳空字串，工位角色完全不可見
  2. `MA_POS` 缺少 `DESIGN` 鍵 — Main Agent 進入 DESIGN stage 時，位置 fallback 到 `MA_IDLE`（辦公室左上角），不會移動到 DESIGN 工位
  3. `DESK_OBJ` 缺少 `DESIGN` 鍵 — DESIGN 工位的桌面物件 `${DESK_OBJ[stage]}` 渲染為 `undefined`（顯示為空）
- [ ] **stale 判斷閾值不一致**：Sidebar 分組使用 30 分鐘（`1800_000ms`），`isStaleSession()`（批次清理用）使用 1 小時（`3600_000ms`），兩個函式的閾值不同，導致「顯示為 stale 但清理按鈕不清理」的邏輯矛盾
- [ ] **`ac-skill.used` 判斷永遠為 false**：`AgentCard` 中 `r?.skillsUsed?.includes(sk)` 判斷 skill 是否已使用，但 `stageResults` 的 `verdict` 物件沒有 `skillsUsed` 欄位（v4 state schema 無此欄位），永遠顯示未使用狀態

---

## Tech Debt（技術債務）

- [ ] **`server.js` AGENT_EMOJI 與 `registry.js` STAGES 重複**：`server.js` 第 126-133 行硬編碼了 12 個 agent→emoji 映射，與 `registry.js` 的 `STAGES` 物件（emoji unicode）各自維護，新增 agent 必須同時改兩處
- [ ] **前端 `SM` 物件與 `registry.js` 不同步**：`index.html` 的 `SM` 硬編碼 9 個 stage 的 agent 名稱、emoji、color、todos、skills，與 `registry.js` STAGES 獨立維護，新增/修改 stage 需同步兩處
- [ ] **前端 `TYPE_LABELS` 與 `registry.js` 重複**：`index.html` 的 `TYPE_LABELS` 映射 10 個 pipeline ID → 中文標籤，與 `registry.js` REFERENCE_PIPELINES 的 `label` 欄位重複
- [ ] **`config.json` taskRoutes 與 `registry.js` REFERENCE_PIPELINES 重複**：`dashboard/config.json` 的 `taskRoutes` 陣列定義了 10 個 pipeline 的 label/stages/color，與 `registry.js` 定義重複
- [ ] **`adaptState()` 適配層長期應移除**：v4 已穩定，前端應直接讀取 `dag`/`stages` 欄位，不需要透過 `adaptState()` 轉換為 v2 扁平格式；適配層增加閱讀複雜度且不易除錯
- [ ] **`adaptState()` 的 `environment` 欄位說明不精確**：`adaptState()` 輸出的 `environment` 欄位直接使用 `raw.environment || {}`，但 v4 state schema 本身不保證 `environment` 存在（該欄位是 pipeline-architect agent 自行填入的選填欄位），`node-context.js` 注入給 sub-agent 的環境快照欄位名為 `env`（精簡版），兩者語意不同
- [ ] **`AGENT_ROSTER` 中 `main`、`explore`、`plan` 三個系統 agent 無真實對應**：這三個 agent 是前端 UI 概念（從 pipeline agent 推斷 Main Agent 狀態），但顯示方式（detect `delegation.start` 事件）不夠精確，可能誤報
- [ ] **eventCat 分類邏輯在 `server.js` 和 `schema.js` 各定義一份**：`server.js` 的 `eventCat()` 用字串前綴判斷分類，但 `schema.js` 的 `CATEGORIES` 才是 SoT，兩者可能不同步
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

## 相關檔案索引

| 檔案 | 路徑 | 主要問題 |
|------|------|---------|
| Runtime SPA | `plugins/vibe/web/index.html` | MILESTONE_TYPES dead filter、SM/TYPE_LABELS 重複、CHARS/MA_POS/DESK_OBJ 缺 designer/DESIGN、adaptState 適配層 |
| Dashboard Server | `plugins/vibe/server.js` | AGENT_EMOJI 重複、eventCat 重複、stale 閾值 |
| Stage Registry | `plugins/vibe/scripts/lib/registry.js` | 應為 SoT，但多處未被 Dashboard 引用 |
| Timeline Schema | `plugins/vibe/scripts/lib/timeline/schema.js` | CATEGORIES 是 SoT 但 server.js eventCat 未使用 |
| 視覺配置 | `dashboard/config.json` | taskRoutes 與 registry.js 重複 |
