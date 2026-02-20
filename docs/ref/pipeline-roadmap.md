# Pipeline v5 改善路線圖

> 架構方向：**Always-Pipeline** — Pipeline 是 Vibe 的常態，非可選附加功能
> 建立日期：2026-02-20 | 基準版本：v2.1.9
> 追蹤方式：各 Section 的 checkbox 依序完成
> 實作順序：S1 → S2 → S3 → S4 → S5 → S6 → S7（編號 = 執行順序）

---

## 零、架構轉型：Always-Pipeline

### 核心洞察

Pipeline 不是「要不要啟動」的二元決定，而是 Vibe 的**基本運作模式**。
Main Agent 的角色 = **Pipeline 路由器**，它自己直接回答問題 = `chat` pipeline。

```
舊架構（v2.1.9）：
  使用者 prompt
      ↓
  Hook: regex 猜測「需不需要 pipeline？」
      ├─ 猜是 → 建 DAG → pipelineActive=true → 阻擋 Main Agent
      └─ 猜否 → none → pipelineActive=false → Main Agent 直接操作
  問題：猜錯 → 死鎖 or 不必要的 pipeline

新架構（v5）：
  使用者 prompt
      ↓
  Hook: 有 [pipeline:xxx]？ → 直接建 DAG（Layer 1，保留）
      ↓ 沒有
  Main Agent (Opus) 自主選擇：
      ├─ 高信心 → 直接呼叫 /vibe:pipeline [pipeline:xxx]
      ├─ 中信心 → 選擇 + 告知使用者可覆寫
      ├─ 低信心 → AskUserQuestion 反問使用者
      └─ 問答/研究 → 直接回答（= chat pipeline）
```

### 設計原則

| 原則 | 說明 |
|------|------|
| **Pipeline 是常態** | 每個互動都經過 pipeline 路由，`chat` 是合法的 pipeline 類型 |
| **Opus 做判斷** | 語意理解取代正則比對，Main Agent 是最佳分類器 |
| **不確定就問** | AskUserQuestion 取代靜默 fallback，消除誤分類死鎖 |
| **失敗安全** | 選錯 pipeline = 浪費（可 cancel），不選 pipeline ≠ 死鎖 |
| **複合分解** | 串列 pipeline 處理順序依賴，利用現有 FSM reset 循環 |
| **決策分配** | 確定性 → 程式碼 ∣ 語意模糊 → AI ∣ AI 也不確定 → 人類 |

### 分類層級（v5）

```
Layer 1: [pipeline:xxx] 顯式指定（hook 處理，deterministic）
    ↓ 沒有顯式指定
Layer 2: Main Agent (Opus) 自主選擇（語意理解，完整 context）
    ↓ 不確定
Layer 3: AskUserQuestion（反問使用者確認）
```

### 刪除項

| 組件 | 刪除內容 | 原因 |
|------|---------|------|
| `classifier.js` | `HEURISTIC_RULES`（6 條 regex）| Opus 語意理解完全取代 |
| `classifier.js` | `classifyByHeuristic()` | 不再需要 regex 分類 |
| `classifier.js` | `buildPipelineCatalogHint()` | 併入 pipeline skill 的 systemMessage |
| `classifier.js` | `QUESTION_PATTERNS` / `FILE_PATH_PATTERN` | regex 層全部移除 |
| `pipeline-controller.js` | feedback loop 邏輯（~50 行）| 無二元閘門，無循環 |
| `pipeline-controller.js` | COMPLETE→reset 30 秒冷卻 | 簡化狀態管理 |
| `pipeline-controller.js` | Layer 2 8 條決策表 systemMessage | 改為「選 pipeline」指令 |

---

## 一、痛點 → 行動 交叉矩陣

以**痛點優先**排列。

| 痛點 | 嚴重度 | 現況 | 解法方向 |
|------|:------:|------|---------|
| **Classifier 架構缺陷** | 🔴 高 | regex 誤判 + Main Agent 被動自分類 → 死鎖 | S1: Always-Pipeline + Opus 主動選擇 |
| **Stage 粒度太粗** | 🟠 中高 | DEV 做全部 task → REVIEW 一次看全部 → 晚發現問題 | S3: Phase-Level D-R-T 循環 |
| **REVIEW 越權修改** | 🟠 中高 | REVIEW agent 自己改程式碼而非返回 DEV | S2: Agent ⛔ 約束 + guard 收緊 |
| **跨 Stage 知識斷裂** | 🟠 中 | Reflexion Memory 只在同 stage 重試間共享 | S4: pipeline-wisdom 跨 stage 累積 |
| **Pipeline-Architect DAG 品質** | 🟡 中 | Sonnet 偶爾產出不完整 DAG | S2: 結構化 prompt + 灰色地帶確認 |
| **Context 壓力** | 🟢 低 | ENABLE_TOOL_SEARCH + 注入量優化已緩解 | S5: Stage 完成時壓縮狀態摘要 |
| **REVIEW 品質** | 🟢 低 | 單一 LLM agent 判斷 | S6: 三信號驗證 |
| **成功標準模糊** | 🟢 低 | agent 不知做到什麼程度算完 | S7: Goal Objects |

---

## 二、行動清單（S1 → S7 依序實作）

### 🔴 S1：Always-Pipeline 架構（核心改造）

**問題本質**：

1. regex 分類器常誤判（`改成` 被判為 fix-change、問句被判為 bugfix）
2. Layer 2 是 advisory — Main Agent 收到「請選 pipeline」但傾向直接動手
3. 選錯 pipeline → `pipelineActive=true` → Main Agent 被阻擋 → 死鎖
4. 回饋循環複雜（COMPLETE→reset 冷卻、cancelled 抑制、stale 偵測）

**解法**：

- 刪除 regex Layer 1.5 — Opus 的語意理解遠勝正則比對
- 強化 pipeline skill systemMessage — 讓 Main Agent **主動選擇**（非被動回應）
- 新增 AskUserQuestion 作為 Layer 3 兜底 — 不確定時問使用者
- 簡化 controller 狀態管理 — 消除回饋循環

**新 classify() 流程**：

```
classify(sessionId, prompt):
  1. Layer 1: extractExplicitPipeline(prompt)
     → 有 → 建 DAG + systemMessage 委派指令（不變）

  2. Layer 2: 注入「選 pipeline」systemMessage
     → Main Agent (Opus) 分析 prompt
     → 高信心：直接呼叫 /vibe:pipeline [pipeline:xxx]
     → 低信心：AskUserQuestion 問使用者
     → 問答/研究：直接回答（chat pipeline，不需呼叫）

  結果：
  - guard 不需改（pipelineActive=false 時 AskUserQuestion 本來就放行）
  - 沒有 regex 可以誤判
  - 不確定的 prompt 由人類最終決定
```

**新 systemMessage 設計**：

```
你是 Pipeline 路由器。分析使用者需求，選擇最合適的工作流：

| Pipeline | 適用場景 | 使用方式 |
|----------|---------|---------|
| chat | 問答、研究、解釋、查詢、trivial | 直接回答，不呼叫 pipeline |
| fix | hotfix、一行修改、改設定/常量 | 呼叫 /vibe:pipeline [pipeline:fix] |
| quick-dev | bugfix + 補測試、小改動（2-5 檔案）| 呼叫 /vibe:pipeline [pipeline:quick-dev] |
| standard | 新功能（無 UI）、大重構 | 呼叫 /vibe:pipeline [pipeline:standard] |
| full | 新功能（含 UI）| 呼叫 /vibe:pipeline [pipeline:full] |
| test-first | TDD 工作流 | 呼叫 /vibe:pipeline [pipeline:test-first] |
| ui-only | 純 UI/樣式調整 | 呼叫 /vibe:pipeline [pipeline:ui-only] |
| review-only | 程式碼審查 | 呼叫 /vibe:pipeline [pipeline:review-only] |
| docs-only | 純文件更新 | 呼叫 /vibe:pipeline [pipeline:docs-only] |
| security | 安全修復 | 呼叫 /vibe:pipeline [pipeline:security] |

判斷原則：
- 偏向使用 pipeline（寧可多走品質流程也不要漏）
- 不確定時用 AskUserQuestion 問使用者
- 複合任務：分解後依序執行（第一個完成 → 開始第二個）
```

**Checklist**：

- [ ] S1.1 — classifier.js：刪除 `HEURISTIC_RULES`、`classifyByHeuristic()`、`QUESTION_PATTERNS`、`FILE_PATH_PATTERN`
- [ ] S1.2 — classifier.js：`classifyWithConfidence()` 簡化為 Layer 1 + fallback `{ source: 'main-agent' }`
- [ ] S1.3 — classifier.js：刪除 `buildPipelineCatalogHint()`（功能併入 systemMessage）
- [ ] S1.4 — pipeline-controller.js：`classify()` 中 `source === 'main-agent'` 路徑改為注入新 systemMessage（pipeline 選擇表）
- [ ] S1.5 — pipeline-controller.js：刪除 COMPLETE→reset 30 秒冷卻邏輯
- [ ] S1.6 — pipeline-controller.js：刪除 cancelled 抑制邏輯（非顯式分類被抑制的路徑）
- [ ] S1.7 — pipeline-controller.js：簡化升降級判斷（去除 stale 偵測複雜度）
- [ ] S1.8 — pipeline-controller.js：systemMessage 加入 AskUserQuestion 引導（不確定時問使用者）
- [ ] S1.9 — pipeline-controller.js：systemMessage 加入複合任務分解引導
- [ ] S1.10 — 測試：新增 20+ 分類場景測試（覆蓋 10 種 pipeline + chat + 複合 + 邊界）
- [ ] S1.11 — 測試：驗證 AskUserQuestion 在 pipelineActive=false 時不被 guard 阻擋
- [ ] S1.12 — 驗證：實際 session 測試 10 個常見 prompt，確認 Opus 分類準確度
- [ ] S1.13 — 清理：刪除 classifier.js 中無用的 exports（classifyByHeuristic / buildPipelineCatalogHint）
- [ ] S1.14 — 文檔：更新 CLAUDE.md Classifier 架構描述（三層 → 二層 + AskUserQuestion）
- [ ] S1.15 — 文檔：更新 MEMORY.md classifier 相關記憶

**影響範圍**：
- `plugins/vibe/scripts/lib/flow/classifier.js`（大幅簡化）
- `plugins/vibe/scripts/lib/flow/pipeline-controller.js`（刪除 ~80 行回饋邏輯）
- `plugins/vibe/tests/classifier-*.test.js`（重寫測試）
- `plugins/vibe/tests/pipeline-catalog-integration.test.js`（調整預期）

**刪除統計**（預估）：
- classifier.js：~140 行 → ~60 行（刪 ~80 行 regex + heuristic）
- pipeline-controller.js classify()：~220 行 → ~140 行（刪 ~80 行回饋循環）
- 總計刪除 ~160 行，新增 ~20 行 systemMessage

**預估影響**：
| 指標 | 現狀 | S1 後 |
|------|------|-------|
| 分類準確度 | ~70%（regex 誤判 + Main Agent 被動） | ~90%（Opus 主動 + 可反問） |
| 死鎖機率 | 中（誤分類 → pipelineActive=true） | 極低（誤分類 → 浪費，不死鎖） |
| 分類器維護成本 | 高（每個 false positive 要加負面排除） | 極低（無 regex 規則需維護） |
| 使用者控制感 | 低（靜默 fallback 到 none） | 高（不確定時被問 + [pipeline:xxx] 覆寫） |

---

### 🟠 S2：結構化 Architect + REVIEW 越權防護

**問題 A — Pipeline-Architect DAG 品質**：

pipeline-architect（Sonnet）收到模糊 prompt 時，偶爾產出 `{ DEV: { deps: [] } }` 的不完整 DAG。`ensureQualityStagesIfDev` 事後補救，但不如源頭約束。

**解法 A — Pipeline-Architect**：在 agent.md 中注入結構化決策模板：

```
1. 任務類型？（新功能 / 修復 / 重構 / 文件 / 設計）
2. 涉及幾個檔案？（1 = fix, 2-5 = quick-dev, 5+ = standard/full）
3. 需要 UI 變更嗎？（是 = full, 否 = standard）
→ 優先使用 Pipeline Catalog 模板，只有真正需要自訂 DAG 時才產出自訂結構
```

**解法 B — ARCH 灰色地帶（GSD Discuss Phase）**：

```
在設計完成前，你必須明確回答以下灰色地帶：
- API response 格式？（JSON 結構、錯誤碼慣例）
- 錯誤處理策略？（throw vs return error vs Result type）
- 日誌級別？（debug/info/warn/error 的使用場景）
- 測試策略？（unit only / + integration / + e2e）
- 狀態管理？（local state / global store / server state）
在 design.md 中記錄每個決策。
```

**問題 B — REVIEW 越權修復**：

REVIEW agent 有時自己修改程式碼而不返回 DEV，根因：
1. `activeStages` 包含 REVIEW → guard 放行所有工具（含 Write/Edit）
2. Agent.md 缺乏 ⛔ 硬性禁止寫入的約束

```
問題流程：
  REVIEW 發現 bug → 自己修了 → verdict: PASS → 跳過 DEV
  結果：REVIEW 不再是獨立品質門（自己改自己過）

正確流程：
  REVIEW 發現 bug → verdict: FAIL, route: DEV → DEV 修復 → REVIEW 再檢查
```

修復：
1. code-reviewer.md + security-reviewer.md：⛔ 禁止使用 Write/Edit 修改程式碼
2. guard-rules.js：REVIEW/TEST stage active 時，阻擋對 src/ 的 Write/Edit（可選強化）

**Checklist**：

- [ ] S2.1 — agents/pipeline-architect.md：新增結構化三問決策模板
- [ ] S2.2 — agents/pipeline-architect.md：明確「優先使用 Catalog 模板」指令
- [ ] S2.3 — agents/pipeline-architect.md：新增「最低品質保證」規則（有 DEV 必有 REVIEW+TEST）
- [ ] S2.4 — agents/architect.md：新增灰色地帶確認清單（5 項 ⛔ 強制）
- [ ] S2.5 — agents/architect.md：要求在 design.md 記錄決策
- [ ] S2.6 — agents/code-reviewer.md：⛔ 禁止 Write/Edit 修改程式碼（只能寫 context_file 報告）
- [ ] S2.7 — agents/security-reviewer.md：同 S2.6 約束
- [ ] S2.8 — guard-rules.js：REVIEW/TEST stage 時阻擋對 src/ 的 Write/Edit（可選強化層）
- [ ] S2.9 — 驗證：用 3 個模糊 prompt 測試 pipeline-architect 產出品質
- [ ] S2.10 — 驗證：測試 REVIEW agent 發現問題時確實返回 FAIL 而非自行修改

**影響範圍**：
- `plugins/vibe/agents/pipeline-architect.md`
- `plugins/vibe/agents/architect.md`
- `plugins/vibe/agents/code-reviewer.md`
- `plugins/vibe/agents/security-reviewer.md`
- `plugins/vibe/scripts/lib/sentinel/guard-rules.js`（可選）

**預估影響**：不完整 DAG 從偶發降到極少；REVIEW 越權修改完全消除

---

### 🟠 S3：Phase-Level D-R-T 循環（細粒度 Pipeline）

**問題本質**：

現在 DAG 的粒度是 **stage**（DEV/REVIEW/TEST），不是 **task**。
當 tasks.md 有 5 個 task 時：

```
現在：
  DEV(task 1-5 全做) → REVIEW(全部一次看) → TEST(全部一次測)
  問題：task 1 有問題 → task 2-5 建立在錯誤基礎上 → 全部返工

改為：
  Phase 1: DEV:1 → REVIEW:1 → TEST:1
  Phase 2: DEV:2 → REVIEW:2 → TEST:2
  Phase 3: DEV:3 → REVIEW:3 → TEST:3
  優勢：task 1 的問題在 task 2 開始前就被抓到
```

**核心改動**：

1. **tasks.md 格式升級**：PLANNER/ARCHITECT 按 phase 分組 task，標記 phase 間依賴
2. **DAG 自動生成**：從 phase 結構自動產出 suffixed stage DAG（DEV:1 → REVIEW:1 → TEST:1 → ...）
3. **TodoList 進度可視化**：pipeline 建立後同步 TaskList，使用者即時看到每個 phase 的 D-R-T 進度
4. **DEV agent 自檢**：每完成一個 task 先 self-review 再繼續（零成本品質提升）

**tasks.md 新格式**：

```markdown
# Tasks

## Phase 1: Auth Login
deps: []
- [ ] 建立 login API endpoint（src/routes/auth.js）
- [ ] 加入 JWT token 生成（src/lib/jwt.js）

## Phase 2: Auth Register
deps: [Phase 1]
- [ ] 建立 register API endpoint（src/routes/auth.js）
- [ ] email 驗證流程（src/lib/email.js）

## Phase 3: Auth Middleware
deps: [Phase 1]
- [ ] JWT 驗證 middleware（src/middleware/auth.js）
- [ ] route 保護（src/routes/index.js）
```

**自動生成的 DAG**：

```javascript
// Phase 2 依賴 Phase 1，Phase 3 也依賴 Phase 1
// Phase 2 和 Phase 3 無互依賴 → 可並行
{
  "DEV:1": { deps: [] },
  "REVIEW:1": { deps: ["DEV:1"] },
  "TEST:1": { deps: ["DEV:1"], barrier: "quality:1", barrierNext: "DEV:2" },
  "DEV:2": { deps: ["REVIEW:1", "TEST:1"] },
  "REVIEW:2": { deps: ["DEV:2"] },
  "TEST:2": { deps: ["DEV:2"], barrier: "quality:2" },
  "DEV:3": { deps: ["REVIEW:1", "TEST:1"] },  // 可與 Phase 2 並行
  "REVIEW:3": { deps: ["DEV:3"] },
  "TEST:3": { deps: ["DEV:3"], barrier: "quality:3" },
  "DOCS": { deps: ["REVIEW:2", "TEST:2", "REVIEW:3", "TEST:3"] }
}
```

**TodoList 進度呈現**：

```
Pipeline: standard (3 phases)
  ✅ Phase 1: Auth Login     [DEV:1 ✓] [REVIEW:1 ✓] [TEST:1 ✓]
  🔄 Phase 2: Auth Register  [DEV:2 🔄] [REVIEW:2 ⏳] [TEST:2 ⏳]
  🔄 Phase 3: Auth Middleware [DEV:3 🔄] [REVIEW:3 ⏳] [TEST:3 ⏳]
```

Main Agent 在 DAG 建立後用 TaskCreate 建立每個 phase 的 todo。
stage-transition 在 PASS/FAIL 時透過 pipeline-controller 同步 TaskUpdate。

**觸發條件**：

- tasks.md 有 ≥ 2 個 phase → 啟用 phase-level D-R-T
- tasks.md 只有 1 個 phase 或無 phase 分組 → 退化為現有行為（單 D-R-T）
- `[pipeline:fix]` 等單階段 pipeline → 不受影響

**Checklist**：

- [ ] S3.1 — agents/planner.md：指引在 proposal.md 中按 phase 分組需求
- [ ] S3.2 — agents/architect.md：指引在 tasks.md 中使用 phase 格式（含 deps 標記）
- [ ] S3.3 — 新增 `plugins/vibe/scripts/lib/flow/phase-parser.js`（解析 tasks.md phase 結構）
- [ ] S3.4 — phase-parser.js：parsePhasesFromTasks() 提取 phase 名稱、deps、task 列表
- [ ] S3.5 — phase-parser.js：generatePhaseDag() 從 phase 結構產出 suffixed stage DAG
- [ ] S3.6 — phase-parser.js：處理 phase 間依賴（deps → DAG edges）+ 獨立 phase 並行
- [ ] S3.7 — pipeline-controller.js：handlePipelineArchitectComplete() 整合 phase DAG 生成
- [ ] S3.8 — pipeline-controller.js：DAG 建立後用 TaskCreate 建立 phase-level todos
- [ ] S3.9 — pipeline-controller.js：onStageComplete() 同步 TaskUpdate（phase 進度）
- [ ] S3.10 — agents/developer.md：⛔ 新增自檢指令「每完成一個 task 先 self-review 再繼續」
- [ ] S3.11 — node-context.js：suffixed stage 的 Node Context 注入 phase 範圍限定（只給該 phase 的 task）
- [ ] S3.12 — 測試：phase 解析 + DAG 生成 + TodoList 同步整合測試
- [ ] S3.13 — 測試：2-phase 和 3-phase 場景的 E2E 驗證
- [ ] S3.14 — 文檔：更新 CLAUDE.md Pipeline 委派架構 + OpenSpec tasks.md 格式

**影響範圍**：
- 新增 `plugins/vibe/scripts/lib/flow/phase-parser.js`
- `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
- `plugins/vibe/scripts/lib/flow/node-context.js`
- `plugins/vibe/agents/planner.md`
- `plugins/vibe/agents/architect.md`
- `plugins/vibe/agents/developer.md`

**預估影響**：
| 指標 | 現狀 | S3 後 |
|------|------|-------|
| DEV 返工範圍 | 全部 task | 僅失敗 phase 的 task |
| 問題發現時機 | 所有 task 完成後 | 每個 phase 完成後 |
| 使用者可見進度 | 無 | TaskList 即時顯示 |
| 並行利用率 | 僅 REVIEW+TEST barrier | Phase 間也可並行 |

---

### 🟠 S4：Wisdom Accumulation（跨 Stage 知識傳遞）

**問題本質**：
```
DEV 發現 → 「專案用 snake_case 命名」
REVIEW 輸出 → 「建議改用 snake_case」（重複已知慣例）
TEST 失敗 → 「某 edge case 未處理」
下次 DEV → 不知道這個 edge case（重複犯錯）
```

**解法**：每個 stage PASS 完成時，從 context_file 提取結構化學習，累積到 `pipeline-wisdom-{sid}.md`，後續 stage 透過 Node Context 注入。

**資料流**：
```
stage-transition.js (PASS 後)
  → 讀取 context_file（品質 stage 報告）
  → 提取 wisdom 摘要（≤ 200 chars/stage）
  → 追加到 pipeline-wisdom-{sid}.md

node-context.js (下一個 stage 委派時)
  → 讀取 pipeline-wisdom-{sid}.md
  → 注入 buildNodeContext() 的 wisdom 欄位
  → formatNodeContext() 輸出 wisdom=... 段
```

**wisdom 結構**（每 stage 一段）：
```markdown
## DEV
- 慣例：snake_case 命名、ESM import
- 注意：auth middleware 用 JWT，非 session

## REVIEW
- 發現：src/utils.js 有未處理的 null 邊界
- 建議：所有 async 函式加 try-catch
```

**Checklist**：

- [ ] S4.1 — 新增 `plugins/vibe/scripts/lib/flow/wisdom.js`（readWisdom/writeWisdom/extractWisdom）
- [ ] S4.2 — wisdom.js：extractWisdom() 從 context_file 內容提取結構化摘要（≤ 200 chars）
- [ ] S4.3 — wisdom.js：writeWisdom() 追加到 `~/.claude/pipeline-wisdom-{sid}.md`
- [ ] S4.4 — wisdom.js：readWisdom() 讀取並截斷（MAX_WISDOM_CHARS = 500）
- [ ] S4.5 — pipeline-controller.js：onStageComplete() 分支 C（PASS）後呼叫 extractWisdom + writeWisdom
- [ ] S4.6 — node-context.js：buildNodeContext() 新增 wisdom 欄位（讀取 pipeline-wisdom）
- [ ] S4.7 — node-context.js：formatNodeContext() 新增 `wisdom=...` 輸出段
- [ ] S4.8 — node-context.js：MAX_NODE_CONTEXT_CHARS 從 2000 調整為 2500
- [ ] S4.9 — session-cleanup.js：清理 `pipeline-wisdom-*.md` 殘留檔案
- [ ] S4.10 — 測試：wisdom 讀寫 + 截斷 + Node Context 整合測試
- [ ] S4.11 — 文檔：更新 CLAUDE.md State 與命名慣例 + MEMORY.md

**影響範圍**：
- 新增 `plugins/vibe/scripts/lib/flow/wisdom.js`
- `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
- `plugins/vibe/scripts/lib/flow/node-context.js`
- `plugins/vibe/scripts/hooks/session-cleanup.js`

**預估影響**：REVIEW/TEST 重複問題減少 30-50%，DEV 返工次數減少

---

### 🟡 S5：FIC 狀態壓縮（Context 效率 + Crash Recovery）

**問題本質**：stage 完成後，Main Agent context 中累積大量委派指令 + stage-transition 回報。humanlayer 的 FIC 方法論建議每個 phase 結束後主動壓縮。

**解法**：stage-transition PASS 後，生成壓縮狀態摘要寫入 `pipeline-status-{sid}.md`：

```markdown
# Pipeline Status [standard] — Session abc123

## 已完成
- [x] PLAN: 需求分析完成，3 個 user story
- [x] ARCH: 採用 Repository Pattern，PostgreSQL + Redis
- [x] DEV: 實作 src/auth/ 模組（5 檔案）

## 進行中
- [ ] REVIEW: 等待委派

## 決策記錄
- API 格式：JSON + HTTP status codes
- 錯誤處理：自訂 AppError class + global handler
```

此檔案有雙重用途：
1. **Crash Recovery**：取代三層推斷，直接從狀態檔案恢復
2. **Compact 恢復**：compact 後 Main Agent 可從此檔案重建 context

**Checklist**：

- [ ] S5.1 — 新增 `plugins/vibe/scripts/lib/flow/status-writer.js`（generate/update/read）
- [ ] S5.2 — status-writer.js：從 pipeline state 產生 Markdown 狀態摘要
- [ ] S5.3 — status-writer.js：包含已完成 stage 摘要 + 進行中 + 決策記錄（從 wisdom 提取）
- [ ] S5.4 — pipeline-controller.js：onStageComplete() PASS 後呼叫 status-writer.update()
- [ ] S5.5 — pipeline-init.js：resume/compact 時讀取 status file 注入 additionalContext
- [ ] S5.6 — pipeline-controller.js：onSessionStop() crash recovery 優先讀取 status file
- [ ] S5.7 — session-cleanup.js：清理 `pipeline-status-*.md` 殘留檔案
- [ ] S5.8 — 測試：status file 生成 + resume 恢復 + crash recovery 整合
- [ ] S5.9 — 文檔：更新 CLAUDE.md State 與命名慣例

**影響範圍**：
- 新增 `plugins/vibe/scripts/lib/flow/status-writer.js`
- `plugins/vibe/scripts/lib/flow/pipeline-controller.js`
- `plugins/vibe/scripts/hooks/pipeline-init.js`
- `plugins/vibe/scripts/hooks/session-cleanup.js`

**預估影響**：Compact 後恢復品質提升，crash recovery 準確度提升

---

### 🟡 S6：三信號驗證（REVIEW 品質提升）

**問題本質**：REVIEW stage 目前是單一 LLM agent 判斷，偶爾放過真正的問題或過度報告。

**解法（hive Triangulated Verification）**：

```
Signal 1: Deterministic rules（lint + type-check + test 結果）
  → 在 REVIEW agent 委派前，自動收集最新 lint/test 結果
  → 注入 Node Context 的 signals 欄位

Signal 2: LLM 判斷（現有 code-reviewer agent）
  → 結合 Signal 1 做出綜合判斷

Signal 3: 低信心升級（可選）
  → REVIEW verdict 含 "uncertain" 標記時
  → stage-transition 注入 AskUserQuestion 確認
```

**Checklist**：

- [ ] S6.1 — node-context.js：新增 `collectSignals()` 收集 lint/test 最新結果
- [ ] S6.2 — node-context.js：buildNodeContext() 為 REVIEW/TEST stage 注入 signals 欄位
- [ ] S6.3 — node-context.js：formatNodeContext() 新增 `signals=lint:0err,test:42pass` 輸出
- [ ] S6.4 — agents/code-reviewer.md：指引參考 signals 做判斷（lint 0 error → 跳過 lint 檢查）
- [ ] S6.5 — pipeline-controller.js：REVIEW verdict 含 uncertain + FAIL → 低信心升級邏輯
- [ ] S6.6 — 測試：signals 收集 + Node Context 注入 + 低信心升級
- [ ] S6.7 — 文檔：更新 pipeline.md 品質機制描述

**影響範圍**：
- `plugins/vibe/scripts/lib/flow/node-context.js`
- `plugins/vibe/agents/code-reviewer.md`
- `plugins/vibe/scripts/lib/flow/pipeline-controller.js`

**預估影響**：REVIEW 誤判率降低

---

### 🟢 S7：Goal Objects 標準化

**問題本質**：模糊 prompt → 模糊成功標準 → agent 不知道做到什麼程度算完。

**解法（hive Outcome-Driven）**：在 OpenSpec `proposal.md` 中標準化 Goal 結構：

```yaml
## Goal
success_criteria:
  - metric: test_coverage
    target: ">= 80%"
    weight: 0.3
  - metric: lint_clean
    target: "0 errors"
    weight: 0.2
  - metric: functional
    description: "用戶可以登入並看到 dashboard"
    weight: 0.5
constraints:
  - type: hard
    rule: "不改動 auth middleware 的公開 API"
  - type: soft
    rule: "偏好 functional style"
```

**Checklist**：

- [ ] S7.1 — agents/planner.md：指引在 proposal.md 產出 Goal 結構
- [ ] S7.2 — agents/code-reviewer.md：參照 Goal success_criteria 做驗證
- [ ] S7.3 — agents/tester.md：從 success_criteria 推導測試案例
- [ ] S7.4 — 文檔：更新 OpenSpec 規格管理描述

**影響範圍**：
- `plugins/vibe/agents/planner.md`
- `plugins/vibe/agents/code-reviewer.md`
- `plugins/vibe/agents/tester.md`

**預估影響**：品質 stage 判斷有明確標準，減少主觀性

---

## 三、實作順序與依賴

```
S1 ──→ S2 ──→ S3 ──→ S4 ──→ S5 ──→ S6 ──→ S7
架構    Agent   Phase   Wisdom  FIC    三信號  Goal
基礎    約束    D-R-T   累積    壓縮    驗證    物件
```

| 順序 | 項目 | 依賴 | 重點 |
|:----:|------|------|------|
| **S1** | Always-Pipeline 架構 | 無 | 刪 regex + Opus 主動選擇 + AskUserQuestion |
| **S2** | Architect + REVIEW 防護 | S1 | Agent ⛔ 約束 + tasks.md 格式基礎 |
| **S3** | Phase-Level D-R-T | S1 + S2 | 細粒度循環 + TodoList 可視化 |
| **S4** | Wisdom Accumulation | S1 | 跨 stage 知識傳遞 |
| **S5** | FIC 壓縮 | S1 + S4 | 狀態摘要 + crash recovery |
| **S6** | 三信號驗證 | S4 | lint/test signal 注入 REVIEW |
| **S7** | Goal Objects | 無 | 成功標準量化 |

---

## 四、預期效果

| 指標 | 現狀 | S1 後 | S1-S3 後 | S1-S5 後 | 全部完成 |
|------|:----:|:-----:|:--------:|:--------:|:-------:|
| 分類準確度 | ~70% | ~90% | ~90% | ~90% | ~90% |
| 死鎖機率 | 中 | 極低 | 極低 | 極低 | 極低 |
| REVIEW 越權修改率 | ~20% | ~20% | ~0% | ~0% | ~0% |
| DEV 返工範圍 | 全部 task | 全部 task | 僅失敗 phase | 僅失敗 phase | 僅失敗 phase |
| DEV 返工次數 | ~1.5 | ~1.5 | ~0.4 | ~0.3 | ~0.3 |
| REVIEW 重複問題率 | ~30% | ~30% | ~15% | ~5% | ~3% |
| 使用者進度可見性 | 無 | 無 | TaskList 即時 | TaskList 即時 | TaskList 即時 |
| Crash Recovery 準確度 | ~80% | ~80% | ~80% | ~95% | ~95% |
| REVIEW 誤判率 | ~15% | ~15% | ~10% | ~10% | ~5% |

---

## 五、與生態系統分析的對應表

| 生態系統發現 | 原始來源 | **行動項** | 說明 |
|-------------|---------|:----------:|------|
| P1: FIC 壓縮 | humanlayer | **S5** | stage-transition 生成壓縮摘要 |
| P2: Discuss Phase | GSD | **S2** | ARCH agent 注入灰色地帶清單 |
| P3: Wave 並行 | GSD | **S3** | tasks.md phase 格式 + 自動並行推斷 |
| P4: Goal Objects | hive | **S7** | proposal.md Goal 結構 |
| P5: Wisdom | oh-my-opencode | **S4** | pipeline-wisdom 跨 stage 累積 |
| M1: Stream-JSON | claude-flow | **不適用** | 等 ECC Agent Teams 支援 |
| M2: 三信號驗證 | hive | **S6** | lint/test signal 注入 |
| M3: Checkpointing | claude-flow | **併入 S5** | 與 FIC 壓縮整合 |
| M4: Category Routing | oh-my-opencode | **不適用** | 模型選擇已在 registry.js 固定 |
| M5: Semantic Retrieval | serena | **延後** | 需 MCP server 整合 |
| M6: 5Q Reboot | planning-with-files | **併入 S5** | pipeline-status.md 結構化恢復 |
| **Always-Pipeline** | 架構討論 | **S1** | 消除二元閘門 + Opus 主動選擇 + AskUserQuestion 兜底 |
| **Phase-Level D-R-T** | 架構討論 | **S3** | 細粒度 phase 循環 + TodoList 進度可視化 |
| **REVIEW 越權防護** | 架構討論 | **S2** | Agent 硬約束 + 可選 guard 收緊 |

---

## 六、技術風險

| 風險 | 嚴重度 | 緩解策略 |
|------|:------:|---------|
| S1 Opus 選錯 pipeline | 低 | 錯 = 浪費（可 cancel），不 = 死鎖；AskUserQuestion 補兜底；[pipeline:xxx] 永遠可覆寫 |
| S1 Main Agent 忽略 systemMessage 直接動手 | 中 | pipeline-guard 硬阻擋寫入工具（現有機制不變）；systemMessage 用 ⛔ 強制標記 |
| S1 AskUserQuestion 被過度觸發 | 低 | systemMessage 明確「高信心直接選、低信心才問」；Opus 理解力足夠 |
| S1 複合 prompt 分解失敗 | 低 | 退化為單 pipeline（不 crash）；使用者可手動分兩次輸入 |
| S2 REVIEW guard 過度收緊 | 低 | 只阻擋 src/ 寫入，context_file 寫入不受影響；先用 agent.md 軟約束 |
| S2 灰色地帶清單被 agent 忽略 | 低 | 用 ⛔ 強制標記 + design.md 檢查 |
| S3 sub-agent 呼叫倍增成本 | 中 | 只有 ≥ 2 phase 才啟用；單 phase 退化為現有行為；phase 間可並行抵消延遲 |
| S3 tasks.md 格式不被 agent 遵守 | 低 | planner/architect agent.md ⛔ 強制 + 範例模板；退化為現有行為（不 crash） |
| S3 suffixed stage 追蹤複雜度 | 中 | 已有 resolveSuffixedStage 機制（v2.0.10）；擴展而非重寫 |
| S4 wisdom 累積過大佔 context | 低 | 每 stage ≤ 200 chars + 整體上限 500 chars + 三層截斷 |
| S5 status file 與 state file 不同步 | 中 | status file 由 state file 衍生（唯讀快照），不反向更新 |

---

## 七、總 Checkbox 進度

### S1：Always-Pipeline 架構 — 0/15
- [ ] S1.1 — classifier.js：刪除 HEURISTIC_RULES + classifyByHeuristic + QUESTION_PATTERNS + FILE_PATH_PATTERN
- [ ] S1.2 — classifier.js：classifyWithConfidence() 簡化（Layer 1 + fallback main-agent）
- [ ] S1.3 — classifier.js：刪除 buildPipelineCatalogHint()
- [ ] S1.4 — pipeline-controller.js：main-agent 路徑改為注入新 systemMessage
- [ ] S1.5 — pipeline-controller.js：刪除 COMPLETE→reset 30 秒冷卻
- [ ] S1.6 — pipeline-controller.js：刪除 cancelled 抑制邏輯
- [ ] S1.7 — pipeline-controller.js：簡化升降級判斷
- [ ] S1.8 — pipeline-controller.js：systemMessage 加入 AskUserQuestion 引導
- [ ] S1.9 — pipeline-controller.js：systemMessage 加入複合任務分解引導
- [ ] S1.10 — 測試：20+ 分類場景測試
- [ ] S1.11 — 測試：AskUserQuestion guard 放行驗證
- [ ] S1.12 — 驗證：10 個 prompt 實測
- [ ] S1.13 — 清理：刪除無用 exports
- [ ] S1.14 — 文檔：CLAUDE.md 更新
- [ ] S1.15 — 文檔：MEMORY.md 更新

### S2：Architect + REVIEW 防護 — 0/10
- [ ] S2.1 — pipeline-architect.md 三問模板
- [ ] S2.2 — pipeline-architect.md 優先 Catalog
- [ ] S2.3 — pipeline-architect.md 品質保證規則
- [ ] S2.4 — architect.md 灰色地帶清單
- [ ] S2.5 — architect.md 決策記錄指令
- [ ] S2.6 — code-reviewer.md ⛔ 禁止 Write/Edit
- [ ] S2.7 — security-reviewer.md ⛔ 禁止 Write/Edit
- [ ] S2.8 — guard-rules.js REVIEW/TEST 寫入阻擋（可選）
- [ ] S2.9 — pipeline-architect 驗證測試
- [ ] S2.10 — REVIEW 越權修改驗證測試

### S3：Phase-Level D-R-T — 0/14
- [ ] S3.1 — planner.md phase 分組指引
- [ ] S3.2 — architect.md tasks.md phase 格式
- [ ] S3.3 — 新增 phase-parser.js
- [ ] S3.4 — parsePhasesFromTasks() 實作
- [ ] S3.5 — generatePhaseDag() 實作
- [ ] S3.6 — phase 依賴 → DAG edges + 並行
- [ ] S3.7 — handlePipelineArchitectComplete() 整合
- [ ] S3.8 — DAG 建立後 TaskCreate 同步
- [ ] S3.9 — onStageComplete() TaskUpdate 同步
- [ ] S3.10 — developer.md 自檢指令
- [ ] S3.11 — Node Context phase 範圍限定
- [ ] S3.12 — phase 解析 + DAG 生成測試
- [ ] S3.13 — 2-3 phase E2E 驗證
- [ ] S3.14 — 文檔更新

### S4：Wisdom Accumulation — 0/11
- [ ] S4.1 — 新增 wisdom.js
- [ ] S4.2 — extractWisdom() 實作
- [ ] S4.3 — writeWisdom() 實作
- [ ] S4.4 — readWisdom() + 截斷
- [ ] S4.5 — onStageComplete() 整合
- [ ] S4.6 — buildNodeContext() wisdom 欄位
- [ ] S4.7 — formatNodeContext() wisdom 輸出
- [ ] S4.8 — MAX_NODE_CONTEXT_CHARS 調整
- [ ] S4.9 — session-cleanup 清理
- [ ] S4.10 — 測試
- [ ] S4.11 — 文檔更新

### S5：FIC 狀態壓縮 — 0/9
- [ ] S5.1 — 新增 status-writer.js
- [ ] S5.2 — Markdown 摘要生成
- [ ] S5.3 — 決策記錄整合 wisdom
- [ ] S5.4 — onStageComplete() 整合
- [ ] S5.5 — pipeline-init.js resume 整合
- [ ] S5.6 — crash recovery 優先讀取
- [ ] S5.7 — session-cleanup 清理
- [ ] S5.8 — 測試
- [ ] S5.9 — 文檔更新

### S6：三信號驗證 — 0/7
- [ ] S6.1 — collectSignals() 實作
- [ ] S6.2 — buildNodeContext() signals 欄位
- [ ] S6.3 — formatNodeContext() signals 輸出
- [ ] S6.4 — code-reviewer.md 指引
- [ ] S6.5 — 低信心升級邏輯
- [ ] S6.6 — 測試
- [ ] S6.7 — 文檔更新

### S7：Goal Objects — 0/4
- [ ] S7.1 — planner.md Goal 結構
- [ ] S7.2 — code-reviewer.md 參照 Goal
- [ ] S7.3 — tester.md 推導測試
- [ ] S7.4 — 文檔更新

**總計：0/70 項**
