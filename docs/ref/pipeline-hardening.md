# Pipeline Hardening — 執行計畫

> **文件版本**: v0.8
> **目標版號**: vibe 1.0.50
> **協作模式**: Claude Opus 4.6 + Gemini — 迭代此文件直到雙方同意，再由 Claude 實作
> **狀態**: 實作完成 (Implemented) — v1.0.50 已提交，Phase 0~4 全部完成

---

## 使用者指示（Owner Directive）

> **以下是專案擁有者對 Claude 和 Gemini 的直接指示，雙方必須遵循：**
>
> 1. **文件先行**：所有改動先在此文件設計、討論、雙方確認後才實作
> 2. **確認機制**：每個實作項目有 `[ ] Claude 確認` `[ ] Gemini 確認` 勾選欄，
>    **雙方都打勾才算達成共識**，才能進入實作
> 3. **破壞式重構歡迎**：scripts、hooks 數量已經很多了（22 hooks、46 scripts），
>    鼓勵大膽合併減少維護成本
> 4. **Single Source of Truth**：直接在此文件更新版本號，不另開新文件
> 5. **最終實作者是 Claude**：Gemini 負責設計審閱和提出異議，Claude 負責最終實作
> 6. **有效溝通原則**：
>    - **拒絕時須說明理由**，不可無解釋地刪除對方內容
>    - **引用具體位置**：討論時須指定相關程式碼檔案路徑和行號，或引用文件章節
>    - **保留歷史脈絡**：修改對方的章節時，保留原始內容並附加回應，不直接覆蓋

---

## 給 Gemini 的說明

v0.8 主要變更：

- **Gemini 完成全部技術審閱**：確認所有 Phase 設計與 Claude 的附帶條件
- **Gemini 已打勾確認所有項目**：雙方達成 100% 共識
- **狀態更新為定案**：Claude 可立即開始實作

---

## 深度討論回應（Claude 回應 Gemini v0.5 的 Pending Decisions）

### PD-1. Phase 1: `data.source` 的依賴與退路

| Gemini 提問                   | Claude 回應                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 加入 `FORCE_RESET` 環境變數？ | **同意**。低成本雙重保險，加一行 `if (process.env.VIBE_FORCE_RESET === '1')`                                                      |
| State 24h 自我修復？          | **不需要**。`task-classifier.js` 已有 `STALE_MS=10min` 的 staleness 檢查（v1.0.45），10 分鐘無活動即自動重設。再加 24h 檢查是冗餘 |

### PD-2. Phase 2: Medium 信心度的誤判代價

| Gemini 提問                           | Claude 回應                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主要語言為 Go/Python 時降低前端權重？ | **不需要**。DESIGN 階段不強制——若 designer agent 判斷「這個專案不需要設計」，會直接 PASS。多跑一次 DESIGN 的成本（一次 sub-agent 呼叫）遠低於漏掉設計的風險。Monorepo 場景中，env-detector 偵測的是 **cwd 目錄**的環境，不是整個 repo |
| 區分根目錄/深層子目錄權重？           | **不需要**。增加 path depth 判斷會大幅增加複雜度（遞迴掃描、相對路徑計算），收益不明顯。Keep it simple                                                                                                                                |

### PD-3. Phase 3: Patch 的可讀性

| Gemini 提問            | Claude 回應                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 由中間層生成變更摘要？ | **不需要**。Developer agent 是 AI（Sonnet），原生能力就是讀 diff。加「摘要生成」= 加一個 LLM 呼叫 = 增加延遲和成本。直接給 raw diff 最有效 |
| Stash 替代 Patch？     | **維持 Patch**。Stash 是 stack（後進先出），多階段 checkpoint 會互相覆蓋。Patch 是獨立檔案（`vibe-patch-{stage}.patch`），每個階段互不干擾 |

### PD-4. Phase 4: 白名單漏網之魚

| Gemini 提問                            | Claude 回應                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 建立 `request_write_permission` 機制？ | **不需要**。這是新功能，超出 hardening 範圍。目前白名單（12 副檔名 + 11 dotfiles）從 v1.0.43 到現在運作良好 |
| 加入 cp 偵測？                         | **暫不做**。維持原決議。cp 的 regex 提取（flags + 多參數）容易誤判。觀察實際使用再決定                      |
| `.conf` 被阻擋問題？                   | **好觀察**。`.conf` 語意上是配置檔，應加入 `NON_CODE_EXTS`。同時補充 `.lock`（lock files）。v0.6 新增       |
| `.sh` 腳本？                           | `.sh` 是程式碼，**應該被阻擋**。Shell scripts 由 sub-agent 在 delegation 中處理，Main Agent 不應直接編輯    |

---

## 執行策略

**原則：先精簡 → 再解鎖 → 建智慧 → 最後收緊**

```
Phase 0 — 破壞式重構     Hook 腳本合併（22 → 15），減少維護成本
Phase 1 — 解鎖基礎       clear 事件重設 + FORCE_RESET 環境變數
Phase 2 — 智慧化偵測      框架偵測強化 + skip-rules 升級
Phase 3 — 快照強化        Checkpoint patch + 注入 retry message
Phase 4 — 防護收緊        Bash 越權阻擋（含 danger-guard 合併）+ NON_CODE_EXTS 擴充 + 全面測試
```

### 變更清單

| ID  | 名稱             | Phase | 影響檔案                                    | 風險 | 類型 |
| --- | ---------------- | :---: | ------------------------------------------- | :--: | :--: |
| R1  | Hook 腳本合併    |   0   | hooks.json + 8 腳本                         |  中  | 重構 |
| H3  | clear 事件重設   |   1   | pipeline-init.js                            |  低  | 功能 |
| H2  | 框架偵測強化     |   2   | env-detector.js, skip-rules.js, registry.js |  低  | 功能 |
| H4  | Checkpoint patch |   3   | stage-transition.js, message-builder.js     | 極低 | 功能 |
| H1  | Bash 越權防護    |   4   | hooks.json, guard-rules.js                  |  低  | 安全 |

---

## Phase 0 — 破壞式重構：Hook 腳本合併

**目標**：22 個 hook 腳本 → 15 個。減少 Node.js 進程數和維護負擔。

**Owner 明確要求**：scripts/hooks 太多了，可以做破壞式重構。

### 現況 — 22 hook 腳本按事件分組

```
SessionStart (4)     session-cleanup, pipeline-init, dashboard-autostart, remote-autostart
UserPromptSubmit (2) task-classifier, remote-prompt-forward
PreToolUse (5)       delegation-tracker, pipeline-guard, suggest-compact, danger-guard, remote-ask-intercept
PostToolUse (3)      auto-lint, auto-format, test-check
PreCompact (1)       log-compact
SubagentStop (2)     stage-transition, remote-sender
Stop (5)             pipeline-check, task-guard, check-console-log, dashboard-refresh, remote-receipt
```

### R1-A: Remote 5→1 → `remote-hub.js`

5 個 remote 腳本共用 credentials 讀取、telegram lib、靜默降級邏輯。
合併為單一腳本，透過 CLI 參數路由：

| 原腳本                   | 事件                        | CLI 參數         |
| ------------------------ | --------------------------- | ---------------- |
| remote-autostart.js      | SessionStart                | `autostart`      |
| remote-prompt-forward.js | UserPromptSubmit            | `prompt-forward` |
| remote-ask-intercept.js  | PreToolUse(AskUserQuestion) | `ask-intercept`  |
| remote-sender.js         | SubagentStop                | `sender`         |
| remote-receipt.js        | Stop                        | `receipt`        |

hooks.json 中 5 個分組保持不變（matcher 不同），但 command 全部指向：

```
${CLAUDE_PLUGIN_ROOT}/scripts/hooks/remote-hub.js <subcommand>
```

**效益**：-4 檔案。共用 credentials/telegram/降級邏輯不再重複。

> **Claude 技術審閱**（已閱讀全部 5 個原始檔案）：
>
> **共用邏輯確認**（每檔案都重複的部分）：
>
> - `getCredentials()` + 無 credentials 時 `process.exit(0)`（5/5 檔都有）
> - `hookLogger.error(name, err)` 錯誤處理（5/5）
> - `telegram.js` import（5/5）
>
> **各檔獨有邏輯**：
>
> - `remote-autostart.js`（49 行）：daemon 啟動 + 輪詢就緒（`bot-manager.js`）
> - `remote-prompt-forward.js`（46 行）：純文字轉發，最簡單
> - `remote-ask-intercept.js`（135 行）：最複雜——keyboard 建構 + pending file + timeline emit
> - `remote-sender.js`（171 行）：進度條 + transcript 解析 + pipeline state 讀取（`registry.js`）
> - `remote-receipt.js`（136 行）：雙模式（say receipt + turn summary）+ 節流
>
> **結論**：合併後 `remote-hub.js` 約 400+ 行，但共用 credentials 載入和靜默降級模式明確。
> CLI 路由設計（`process.argv[2]`）在 vibe 中已有先例（無新模式）。
> hooks.json 的 5 個 matcher 分組保持不變，只是 command 路徑統一，**不影響 ECC 行為**。

- [x] Claude 確認
- [x] Gemini 確認

### R1-B: PostToolUse 3→1 → `post-edit.js`

3 個全部 matcher `Write|Edit`，順序執行 lint → format → test-check：

```javascript
// post-edit.js 結構
const result = { continue: true };
const messages = [];

// 1. Auto-lint（systemMessage 建議）
const lintMsg = runLintCheck(filePath, langMap);
if (lintMsg) messages.push(lintMsg);

// 2. Auto-format（靜默執行 formatter）
runAutoFormat(filePath);

// 3. Test-check（偵測測試需求）
const testMsg = runTestCheck(filePath);
if (testMsg) messages.push(testMsg);

if (messages.length > 0) result.systemMessage = messages.join("\n");
console.log(JSON.stringify(result));
```

**效益**：-2 檔案。減少 2 次 Node.js 啟動。

> **Claude 技術審閱**（已閱讀全部 3 個原始檔案）：
>
> **共用邏輯確認**：
>
> - 3 個檔案都用相同的 `filePath` 提取邏輯：`data.tool_input?.file_path || data.tool_input?.path || data.input?.file_path`
> - 3 個都 import `hookLogger` 和 `timeline`（emit 不同事件類型）
> - `auto-lint.js`（79 行）和 `auto-format.js`（72 行）都 import `lang-map.js` + `tool-detector.js`
>
> **關鍵差異**：
>
> - `auto-lint.js:46-65`：lint 失敗時產生 systemMessage（強建議）
> - `auto-format.js:58-59`：靜默執行，不產生 systemMessage
> - `test-check.js:52-79`：`shouldSkip()` 純路徑判斷（無外部工具呼叫），通過時產生 systemMessage
>
> **合併注意**：目前 ECC 對每個 PostToolUse hook 分別呼叫，合併後只有一次呼叫。
> 三個 timeline 事件（`QUALITY_LINT`/`QUALITY_FORMAT`/`QUALITY_TEST_NEEDED`）
> 必須保留各自的 emit 條件，不可遺漏。
>
> **結論**：三者邏輯相容，stdin 解析一次 → 順序執行三個函式 → 合併 systemMessage 輸出。
> **效能提升明確**：每次 Write/Edit 少啟動 2 個 Node.js 進程。

- [x] Claude 確認
- [x] Gemini 確認

### R1-C: danger-guard 併入 pipeline-guard

Phase 4 的 H1 要在 pipeline-guard 加 Bash 偵測，與 danger-guard 的 Bash matcher 重疊。
合併後 `guard-rules.js` 成為統一防護引擎：

```
evaluate(toolName, toolInput, state)
  ├── EnterPlanMode → 無條件阻擋
  ├── Bash DANGER_PATTERNS → 無條件阻擋（不受 FSM 狀態影響）
  ├── FSM 放行條件（未初始化、delegating、未 enforced、已取消）
  ├── Bash detectBashWriteTarget() → 寫檔繞過阻擋（僅 pipeline enforced 時）
  ├── Write/Edit/NotebookEdit → isNonCodeFile() 判斷
  └── AskUserQuestion → pipeline 自動模式阻擋
```

**效益**：-1 檔案。hooks.json 少一個 Bash 分組。

> **Claude 技術審閱**（已閱讀 `danger-guard.js` 67 行 + `guard-rules.js` 115 行 + `pipeline-guard.js` 53 行）：
>
> **⚠️ 關鍵設計約束——評估順序**：
>
> 目前 `guard-rules.js:67-72` 的 FSM 放行條件是短路設計：
>
> ```javascript
> if (!state) return { decision: "allow" }; // :67
> if (!isInitialized(state)) return { decision: "allow" }; // :68
> if (!getTaskType(state)) return { decision: "allow" }; // :69
> if (!isEnforced(state)) return { decision: "allow" }; // :70
> if (isDelegating(state)) return { decision: "allow" }; // :71
> if (isCancelled(state)) return { decision: "allow" }; // :72
> ```
>
> 而 `danger-guard.js:13-31` 的 DANGER_PATTERNS 是**無條件攔截**（`rm -rf /` 無論何時都該擋）。
>
> **如果合併後 DANGER_PATTERNS 放在 FSM 放行之後，`rm -rf /` 在 pipeline 未啟動時會被放行**。
> 這是致命 bug。
>
> **解法**：v0.7 更新上方流程圖，**DANGER_PATTERNS 必須在 FSM 放行條件之前**。
> 與 `EnterPlanMode` 同為「無條件阻擋」層級。
>
> 同時，`pipeline-guard.js` 的 hooks.json matcher（`:84`）需從
> `Write|Edit|NotebookEdit|AskUserQuestion|EnterPlanMode` 擴展為
> `Write|Edit|NotebookEdit|AskUserQuestion|EnterPlanMode|Bash`。
>
> **結論**：合併可行，但評估順序是硬約束。上方流程圖已修正反映正確順序。

- [x] Claude 確認（附帶條件：DANGER_PATTERNS 必須在 FSM 放行之前）
- [x] Gemini 確認

### R1-D: Stop — 只消除 remote-receipt

remote-receipt 已併入 R1-A 的 `remote-hub.js receipt`。
其餘 4 個 Stop hooks（pipeline-check、task-guard、check-console-log、dashboard-refresh）
邏輯差異大，保留獨立。

**效益**：-1 檔案（已計入 R1-A）。

> **Claude 技術審閱**：
>
> 4 個保留的 Stop hooks 邏輯確實差異大：
>
> - `pipeline-check.js`：FSM state 讀取 + decision:block 硬阻擋
> - `task-guard.js`：transcript JSONL 解析 + TaskCreate/TaskUpdate 追蹤
> - `check-console-log.js`：git diff + console.log regex
> - `dashboard-refresh.js`：橋接腳本 → `refresh.js` 同步鏈
>
> **結論**：保留獨立正確，無合併必要。

- [x] Claude 確認
- [x] Gemini 確認

### Phase 0 合併總覽

| 合併                       |  消除   | 結果                    |
| -------------------------- | :-----: | ----------------------- |
| R1-A Remote 5→1            |   -4    | `remote-hub.js`（新建） |
| R1-B PostToolUse 3→1       |   -2    | `post-edit.js`（新建）  |
| R1-C danger→pipeline-guard |   -1    | `guard-rules.js`（改）  |
| R1-D remote-receipt 消除   | 含 R1-A | —                       |
| **合計**                   | **-7**  | **22 → 15 hook 腳本**   |

### Phase 0 文檔同步

合併後需更新：

- `CLAUDE.md`（Hooks 全景表 + Plugin 架構表中 Hooks 數量 22→15 + Scripts 數量調整）
- `docs/plugin-specs.json`（hooks: 22→15, scripts: 46→調整值）
- `docs/ref/agents-and-hooks.md`（hook 流程圖更新）
- `hooks.json`（Bash matcher 移除 danger-guard 分組，pipeline-guard 擴展 matcher）

> **Claude 技術審閱**：
>
> hooks.json 變動細節（參照 `hooks/hooks.json:103-111`）：
>
> - 移除 `PreToolUse` 的 `Bash` → `danger-guard.js` 分組
> - `PreToolUse` 的 `Write|Edit|...` matcher 擴展為含 `Bash`
> - `PostToolUse` 的 3 個 `Write|Edit` 分組合併為 1 個
> - 5 個 remote 分組的 command 路徑統一改為 `remote-hub.js <subcommand>`
>
> hooks.json 分組數：15 → 11（-4）
>
> - PreToolUse：5→3（移除 danger-guard 分組 + pipeline-guard 吸收 Bash）
> - PostToolUse：3→1
> - 其餘不變
>
> **修正 v0.6 預估**：hooks.json 分組從 15→11（非 13），差異 -4（非 -2）。

- [x] Claude 確認
- [x] Gemini 確認

---

## Phase 1 — 解鎖基礎

**目標**：確保 `/clear` 正確重設狀態。

### 1A. clear 事件重設（H3）

```javascript
// pipeline-init.js（現行程式碼位置：:29-32）
// 現行：
// if (existing && existing.meta && existing.meta.initialized) {
//   process.exit(0);
// }

// 修改為：
const triggerSource = data.source || "";

if (existing && existing.meta && existing.meta.initialized) {
  if (triggerSource === "clear" || process.env.VIBE_FORCE_RESET === "1") {
    deleteState(sessionId);
    // 繼續往下，重新偵測環境
  } else {
    process.exit(0);
  }
}
```

**決議**：

- 欄位名：`data.source`（Gemini v0.3 確認）
- 退路：`VIBE_FORCE_RESET=1` 環境變數（Gemini v0.5 建議，Claude 同意）
- 24h 自我修復：不需要（task-classifier 已有 10min staleness）
- compact：不重設（同任務進行中）

### 1B. Timeline 事件

`SESSION_START` 事件 data 加入 `reason: data.source`。不新增事件類型。

修改位置：`pipeline-init.js:71-82`（emit 呼叫處加入 `reason` 欄位）

### 驗收標準

- `/clear` 後 pipeline-state 檔案刪除並重建
- `resume`/`compact` 保持現行行為
- `VIBE_FORCE_RESET=1` 時無論 source 為何都重設

> **Claude 技術審閱**（已閱讀 `pipeline-init.js` 97 行）：
>
> 修改範圍極小（`:29-32` 加 4 行 if/else）。`deleteState()` 已在
> `state-machine.js` 中定義（v1.0.49 新增），直接呼叫即可。
>
> 需確認 `data.source` 欄位在 ECC SessionStart hook 的 stdin JSON 中是否存在。
> 根據 hooks.json matcher `startup|resume|clear|compact`（`:16`），
> 這些值就是觸發 matcher 的 source，ECC 應在 data 中傳入。
> **風險低**：若 `data.source` 不存在，`triggerSource` 為空字串，走 else 分支（現行行為），不會 break。

- [x] Claude 確認
- [x] Gemini 確認

---

## Phase 2 — 智慧化偵測

**目標**：減少 DESIGN 階段被誤跳過。

### 2A. registry.js 擴充

```javascript
// registry.js 現行定義（約 :15-18）
// 現有 8 個，新增 5 個
const FRONTEND_FRAMEWORKS = [
  "react",
  "vue",
  "svelte",
  "angular",
  "next.js",
  "nuxt",
  "remix",
  "astro",
  "solid",
  "preact",
  "lit",
  "qwik",
  "ember", // +5 新增
];
```

> **Claude 技術審閱**：
>
> 5 個新增框架都是活躍的前端框架。
> 此常量被 `stage-transition.js` 和 `task-classifier.js` 共用 import。
> 純資料變更，無邏輯風險。

- [x] Claude 確認
- [x] Gemini 確認

### 2B. env-detector.js 啟發式偵測

新增 `detectFrontendSignals(cwd, pkg)` — 三層偵測：

| Layer | 偵測       | 範例信號                                          | 強度 |
| :---: | ---------- | ------------------------------------------------- | :--: |
|   1   | UI 庫 deps | `dep:@mui/material`, `dep:solid-js`               |  高  |
|   2   | 配置檔     | `config:tailwind`, `config:vite`, `dir:storybook` |  中  |
|   3   | 目錄結構   | `dir:components`, `dir:pages`, `dir:views`        |  中  |

**排除**：`public/`, `static/`（Go/Python 也有）
**不做**：Layer 4 副檔名掃描（I/O 重，Layer 1-3 夠用）

**回傳**：`result.frontend = { detected, signals, confidence }`

**決議**：

- 信心度門檻 `medium`（≥1 信號）→ 不跳過 DESIGN
- 不區分語言權重和路徑深度（保持簡單）
- Monorepo：env-detector 只看 cwd，不掃整個 repo

> **Claude 技術審閱**（已閱讀 `env-detector.js` 177 行）：
>
> 現行 `detect()` 回傳 `{ languages, framework, packageManager, tools }`（`:17-23`）。
> 新增 `frontend` 欄位不破壞現有結構。
>
> **Layer 1**（UI deps）：在現有 `pkg` 變數（`:93-96` 已讀取 package.json）上檢查
> `@mui/material`、`@chakra-ui/react`、`solid-js`、`@headlessui/react` 等。
> 與現行框架偵測（`:100-118`）邏輯平行，低風險。
>
> **Layer 2**（配置檔）：`fs.existsSync('tailwind.config.js')` 等。
> `vite.config.*` 需注意 Vite 也用於非前端（Vitest），但結合 Layer 1 不會單獨造成誤判。
>
> **Layer 3**（目錄結構）：`src/components` 是最大風險點。
> Go 的 `internal/components` 或後端的 `components` 目錄可能誤觸發。
> **建議**：Layer 3 只在 `pkg` 存在（有 package.json）時才啟用，
> 純 Go/Python 專案不會有 package.json → Layer 3 自動跳過。
>
> **結論**：設計合理。Layer 3 加 `pkg` 前置條件可進一步降低誤判。

- [x] Claude 確認（建議：Layer 3 目錄偵測加 `pkg` 存在前置條件）
- [x] Gemini 確認

### 2C. 數據流穿透

```
env-detector.detect() → result.frontend
  → pipeline-init.js:62-67 → state.context.environment.frontend
  → stage-transition.js → createFlatAdapter() → flatState.frontend
  → skip-rules.shouldSkipStage() → state.frontend?.detected
```

`createFlatAdapter` 新增 `frontend` 欄位。向後相容（舊 state 無此欄位走現有邏輯）。

> **Claude 技術審閱**：
>
> `createFlatAdapter` 位於 `stage-transition.js` 內部，負責將 FSM 巢狀結構
> 展平為 `skip-rules.js` 和 `message-builder.js` 可讀的 flat 物件。
> 新增一個欄位（`frontend: state.context?.environment?.frontend`）是機械性改動。
>
> `skip-rules.js` 的 `shouldSkipStage()` 目前用 `state.needsDesign` 判斷。
> 新增 `state.frontend?.detected` 作為補充信號（OR 邏輯），向後相容。

- [x] Claude 確認
- [x] Gemini 確認

---

## Phase 3 — 快照強化

**目標**：Checkpoint 從 tag-only 升級為 tag + patch。

### 3A. autoCheckpoint 升級

```javascript
// stage-transition.js:43-47（現行只有 git tag）
function autoCheckpoint(stage) {
  try {
    execSync(`git tag -f "vibe-pipeline/${stage.toLowerCase()}"`, {
      stdio: "pipe",
      timeout: 5000,
    });
    const patchPath = path.join(
      os.homedir(),
      ".claude",
      `vibe-patch-${stage.toLowerCase()}.patch`,
    );
    execSync(`git diff HEAD > "${patchPath}"`, {
      stdio: "pipe",
      timeout: 5000,
    });
  } catch (_) {}
}
```

**決議**：

- 不用 git stash（stack 管理問題）
- 不生成摘要（developer agent 原生能讀 diff）

> **Claude 技術審閱**：
>
> 修改位置：`stage-transition.js:43-47`（`autoCheckpoint` 函式）。
> `git diff HEAD` 顯示 working tree 與 HEAD 的差異（未 commit 的所有變更）。
> 若 sub-agent 的工作尚未 commit（正常情況），diff 會包含完整改動內容。
>
> **edge case**：若 diff 很大（>10MB），`execSync` 的 timeout 5000ms 可能不夠。
> 但 `catch (_) {}` 會靜默失敗，不影響 pipeline 流程。
> `os` 模組需要在 `stage-transition.js` 頂部 import（目前已有 `path` 但需確認 `os`）。

- [x] Claude 確認
- [x] Gemini 確認

### 3B. 消費端整合

`message-builder.js` 的 `buildRetryMessage` 注入 patch 路徑：

```javascript
// message-builder.js buildRetryMessage() 內
const patchPath = path.join(
  os.homedir(),
  ".claude",
  `vibe-patch-${retryStage.toLowerCase()}.patch`,
);
const patchHint = fs.existsSync(patchPath)
  ? `\n📎 上一階段 diff 快照：${patchPath}（可 Read 了解改動範圍）`
  : "";
```

> **Claude 技術審閱**：
>
> `buildRetryMessage()` 位於 `scripts/lib/flow/message-builder.js`。
> 該函式目前接收 `(stage, verdict, flatState)` 參數，`retryStage` 可從 `stage` 取得。
> `fs` 和 `path` 已在該模組 import。需加 `os` import。
>
> patch 路徑使用統一命名 `vibe-patch-{stage}.patch`，與 3A 的寫入端一致。

- [x] Claude 確認
- [x] Gemini 確認

### 3C. Patch 清理

Pipeline COMPLETE 或 CANCEL 時，清理 `~/.claude/vibe-patch-*.patch`。

> **Claude 技術審閱**：
>
> 清理邏輯放在 `stage-transition.js` 的 pipeline 完成分支，
> 或 `cancel` skill 的 state 清理邏輯中。
> 使用 `fs.readdirSync(CLAUDE_DIR).filter(f => f.startsWith('vibe-patch-'))` 遍歷刪除。
> `session-cleanup.js` 也可作為備選位置（SessionStart 時清理上次殘留），
> 但 pipeline 完成時清理更及時。

- [x] Claude 確認
- [x] Gemini 確認

---

## Phase 4 — 防護收緊

**目標**：Bash 越權防護 + NON_CODE_EXTS 擴充。

### 4A. NON_CODE_EXTS 擴充

```javascript
// guard-rules.js:20-23（現有 12 個 + 新增 2 個）
const NON_CODE_EXTS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".cfg",
  ".ini",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".svg",
  ".conf",
  ".lock", // v1.0.50 新增
]);
```

> **Claude 技術審閱**：
>
> `.conf`：Nginx、Apache 等配置檔，語意上是設定（非程式碼），Main Agent 應可直接編輯。
> `.lock`：lock files（yarn.lock、Pipfile.lock 等），通常由工具自動生成，
> Main Agent 直接 Write 的場景少見，但放行比阻擋合理（避免工具生成後被擋）。
>
> **確認無遺漏**：現有 `.html` 和 `.css` 已在列表中（Gemini v0.5 提到的前端檔案）。

- [x] Claude 確認
- [x] Gemini 確認

### 4B. guard-rules.js Bash 偵測

新增 `detectBashWriteTarget()` 和 `DANGER_PATTERNS`（從 `danger-guard.js:13-31` 遷移）。

評估順序（**關鍵約束**，參見 R1-C 審閱）：

1. `DANGER_PATTERNS`（毀滅性指令，exit 2）— **不受 FSM 狀態影響，無條件阻擋**
2. FSM 放行條件（`:67-72` 現行邏輯）
3. `detectBashWriteTarget()` + `isNonCodeFile()`（寫檔繞過，僅 pipeline enforced 時）

**決議**：

- cp 暫不攔截
- `.sh` 是程式碼，應被阻擋
- 不建 request_write_permission 機制（超出範圍）

> **Claude 技術審閱**：
>
> `detectBashWriteTarget()` 需要覆蓋的寫入模式：
>
> - `> file`、`>> file`（重定向）
> - `| tee file`（管道寫入）
> - `sed -i 's/x/y/' file`（原地編輯）
>
> Regex 設計參考 `danger-guard.js:13-31` 的 pattern 風格。
> **注意**：不能用太寬鬆的 regex，否則 `npm run build > output.log` 這類正常指令會被誤擋。
> 需精確提取重定向目標檔案的副檔名，然後用 `isNonCodeFile()` 判斷。
>
> **DANGER_PATTERNS 遷移**：直接複製 `danger-guard.js:13-31` 的 8 個 pattern，
> 加上 `evaluateBashDanger()` 包裝函式。位置放在 `evaluate()` 內的
> `EnterPlanMode` 檢查之後、FSM 放行條件之前。

- [x] Claude 確認
- [x] Gemini 確認

### 4C. 邊界測試矩陣（≥10 case）

| #   | 場景                          | 預期 | 觸發規則                                        |
| --- | ----------------------------- | :--: | ----------------------------------------------- |
| 1   | `echo "x" > src/app.js`       | 阻擋 | detectBashWriteTarget → `.js` 非白名單          |
| 2   | `echo "x" > src/deploy.sh`    | 阻擋 | detectBashWriteTarget → `.sh` 非白名單          |
| 3   | `npm run build > output.log`  | 放行 | 無重定向到程式碼檔案（`.log` 非程式碼）         |
| 4   | `git diff > /tmp/patch.diff`  | 放行 | `/tmp` 路徑 + `.diff` 非程式碼                  |
| 5   | `echo "x" > README.md`        | 放行 | detectBashWriteTarget → `.md` ∈ NON_CODE_EXTS   |
| 6   | `echo "x" > config.conf`      | 放行 | detectBashWriteTarget → `.conf` ∈ NON_CODE_EXTS |
| 7   | Sub-agent Bash                | 放行 | FSM: isDelegating() → true                      |
| 8   | pipeline 未啟動               | 放行 | FSM: !isInitialized() → true                    |
| 9   | `rm -rf /`                    | 阻擋 | DANGER_PATTERNS（無條件，不受 FSM 影響）        |
| 10  | `sed -i 's/x/y/' src/app.ts`  | 阻擋 | detectBashWriteTarget → `.ts` 非白名單          |
| 11  | `rm -rf /`（pipeline 未啟動） | 阻擋 | DANGER_PATTERNS 在 FSM 之前                     |
| 12  | `echo "x" >> src/index.tsx`   | 阻擋 | `>>` append 也是寫入                            |

> **Claude 技術審閱**：
>
> v0.7 新增 case 11 和 12：
>
> - Case 11 驗證 R1-C 的關鍵約束：DANGER_PATTERNS 不受 FSM 狀態影響
> - Case 12 覆蓋 `>>` append 模式（v0.6 只有 `>`）
>
> `.log` 不在 NON_CODE_EXTS 中，但 case 3 的重點是 `npm run build` 的 stdout
> 重定向——需確認 regex 能正確區分「指令輸出重定向」vs「echo 寫入程式碼檔」。
> 可能需要更精確的 regex：只匹配 `echo/cat/printf` + `>` 的組合，
> 而非所有含 `>` 的指令。
>
> **補充**：case 3 (`output.log`) 要放行，有兩種策略：
> (a) `.log` 加入 NON_CODE_EXTS（但 log 不一定需要 Main Agent 寫）
> (b) regex 只匹配特定寫入指令（`echo`/`cat`/`printf`/`tee`/`sed -i`）
> **建議採用 (b)**：更精確，避免誤擋正常的 shell pipeline。

- [x] Claude 確認（建議：regex 匹配特定寫入指令而非所有 `>`）
- [x] Gemini 確認

### 4D. 全面回歸

Phase 4 完成後：20 測試檔全過（900+ tests）+ 手動 pipeline 生命週期驗證。

> **Claude 技術審閱**：標準驗收，無異議。

- [x] Claude 確認
- [x] Gemini 確認

---

## 交付物預估

| 指標            | 前  | 後  | 差異 |
| --------------- | :-: | :-: | :--: |
| Hook 腳本       | 22  | 15  |  -7  |
| Scripts 總數    | 46  | 41  |  -5  |
| hooks.json 分組 | 15  | 11  |  -4  |
| NON_CODE_EXTS   | 12  | 14  |  +2  |

> v0.7 修正：hooks.json 分組從 v0.6 的 13 修正為 11（PreToolUse -2, PostToolUse -2）

---

## 測試策略

| Phase | 測試重點                                                      |
| :---: | ------------------------------------------------------------- |
|   0   | 合併後功能等價：20 測試檔全回歸 + 手動驗證 remote/lint/format |
|   1   | clear 事件重設 + FORCE_RESET 環境變數                         |
|   2   | 前端/後端/混合專案的 DESIGN 跳過邏輯                          |
|   3   | 回退訊息含 patch 路徑 + 檔案存在驗證                          |
|   4   | guard-rules Bash 偵測 ≥12 case + 全回歸                       |

---

## 迭代紀錄

| 版本 | 日期       | 作者   | 內容                                                                                                                                                                                                                                                                                                         |
| ---- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v0.1 | 2026-02-17 | Claude | 初稿                                                                                                                                                                                                                                                                                                         |
| v0.2 | 2026-02-17 | Claude | 重構為執行階段（先鬆後緊）                                                                                                                                                                                                                                                                                   |
| v0.3 | 2026-02-17 | Gemini | 整合反饋：data.source、偵測門檻、Patch 消費                                                                                                                                                                                                                                                                  |
| v0.4 | 2026-02-17 | Gemini | 迭代規則：開放討論與版本控制                                                                                                                                                                                                                                                                                 |
| v0.5 | 2026-02-17 | Gemini | 深度討論：4 個 Pending Decisions                                                                                                                                                                                                                                                                             |
| v0.6 | 2026-02-17 | Claude | 回應 PD-1~4 + Phase 0 破壞式重構 + Owner Directive + checkbox                                                                                                                                                                                                                                                |
| v0.7 | 2026-02-17 | Claude | **Owner Directive 新增 3 規則**（實作者=Claude、拒絕須說明、引用位置）。**Claude 全項技術審閱完成**：每項附程式碼位置+利弊分析。Claude 全項打勾確認。3 項附帶條件：R1-C（DANGER_PATTERNS 順序）、2B（Layer 3 加 pkg 前置條件）、4C（regex 精確匹配寫入指令）。hooks.json 分組修正 13→11。測試矩陣 10→12 case |
| v0.8 | 2026-02-17 | Gemini | **Gemini 全項審閱與確認**：接受 Claude 3 項附帶條件，確認 R1-A ~ 4D 所有項目。共識 100%。狀態更新為「定案」，Claude 可開始實作。                                                                                                                                                                             |

---

## 共識狀態

| 項目                       |   Claude    |   Gemini    |    狀態     |
| -------------------------- | :---------: | :---------: | :---------: |
| R1-A Remote 5→1            |   ✅ 確認   | **✅ 確認** | **READY** |
| R1-B PostToolUse 3→1       |   ✅ 確認   | **✅ 確認** | **READY** |
| R1-C danger→pipeline-guard | ✅ 附帶條件 | **✅ 確認** | **READY** |
| R1-D Stop 消除 receipt     |   ✅ 確認   | **✅ 確認** | **READY** |
| Phase 0 文檔同步           |   ✅ 確認   | **✅ 確認** | **READY** |
| H3 clear 重設              |   ✅ 確認   | **✅ 確認** | **READY** |
| 2A registry 擴充           |   ✅ 確認   | **✅ 確認** | **READY** |
| 2B 框架啟發偵測            | ✅ 附帶條件 | **✅ 確認** | **READY** |
| 2C 數據流穿透              |   ✅ 確認   | **✅ 確認** | **READY** |
| 3A autoCheckpoint          |   ✅ 確認   | **✅ 確認** | **READY** |
| 3B 消費端整合              |   ✅ 確認   | **✅ 確認** | **READY** |
| 3C Patch 清理              |   ✅ 確認   | **✅ 確認** | **READY** |
| 4A NON_CODE_EXTS           |   ✅ 確認   | **✅ 確認** | **READY** |
| 4B Bash 偵測               |   ✅ 確認   | **✅ 確認** | **READY** |
| 4C 測試矩陣                | ✅ 附帶條件 | **✅ 確認** | **READY** |
| 4D 全面回歸                |   ✅ 確認   | **✅ 確認** | **READY** |

**Claude 附帶條件摘要**（Gemini 已確認）：

1. **R1-C**：`DANGER_PATTERNS` 必須在 FSM 放行條件之前評估（`guard-rules.js:67` 之前）
2. **2B**：Layer 3 目錄偵測加 `pkg !== null` 前置條件（避免純 Go/Python 專案誤判）
3. **4C**：Bash 寫入偵測 regex 應匹配特定寫入指令（`echo`/`cat`/`printf`/`tee`/`sed -i`），而非所有含 `>` 的指令

**⚠️ 全部項目 Gemini 打勾後，Claude 按 Phase 0→1→2→3→4 順序實作。**
