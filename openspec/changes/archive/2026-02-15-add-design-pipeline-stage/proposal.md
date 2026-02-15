# DESIGN 階段導入 Pipeline

## 為什麼（Why）

### 目前的限制

1. **設計斷層**：目前 designer agent 只能透過 `/vibe:design` 獨立呼叫或 ARCH 階段由 architect 條件性呼叫 search.py。設計產出（design-system.md）沒有正式的 pipeline 階段保障，容易被跳過。

2. **缺乏預覽驗證**：architect 產出的 design-system.md 是純 markdown 規範，開發者直接進入 DEV 階段實作。使用者無法在實作前透過視覺化 mockup 預覽確認設計方向，導致 DEV 完成後才發現設計不符預期，造成大量回退。

3. **前端/後端一體化問題**：所有專案無論是否涉及前端，都走相同的 8 階段 pipeline。純後端專案不需要設計階段，但前端專案卻缺少正式的設計驗證環節。

4. **設計與架構職責模糊**：v1.0.27 中 architect 兼任設計系統產出（Layer 2），違反單一職責原則。architect 應專注於技術架構，designer 應專注於視覺設計。

### 預期效果

- 前端專案在 DEV 之前有正式的設計驗證環節
- 使用者可透過 HTML mockup 在瀏覽器預覽設計稿
- 純後端/CLI 專案自動跳過 DESIGN 階段，零影響
- architect 和 designer 職責清晰分離

## 變更內容（What Changes）

### 1. Pipeline 階段擴展
- **BREAKING**：pipeline 從 8 階段變為 9 階段：`PLAN -> ARCH -> DESIGN -> DEV -> REVIEW -> TEST -> QA -> E2E -> DOCS`
- `pipeline.json` 新增 DESIGN stage 定義
- `registry.js` 新增 DESIGN stage 到所有映射

### 2. 條件性路由
- `stage-transition.js` 新增 ARCH -> DESIGN -> DEV 路由邏輯
- 根據環境偵測（前端框架/UI 檔案存在）決定是否路由到 DESIGN
- 純後端/CLI 專案：ARCH -> DEV（跳過 DESIGN，類似現有 E2E 跳過邏輯）

### 3. Designer Agent 增強
- `designer.md` 更新：支援 Pipeline 模式工作流（接收 proposal.md + design.md）
- 新增 HTML mockup 產出能力（瀏覽器可預覽的視覺設計稿）
- 產出路徑：`openspec/changes/{name}/design-mockup.html`

### 4. Task Classifier 更新
- `STAGE_MAPS.feature` 加入 DESIGN（條件性）
- 偵測前端框架時自動包含 DESIGN 階段

### 5. 相關 Hook 適配
- `pipeline-guard.js` / `guard-rules.js`：已用 pipeline state 驅動，無需修改邏輯
- `pipeline-check.js`：透過 `discoverPipeline()` 動態發現，無需修改邏輯
- `stage-transition.js`：ARCH 完成後的 context 提示需調整（原 POST_STAGE_HINTS.ARCH）

### 6. Architect 職責精簡
- 移除 `architect.md` 中「前端設計整合（條件執行）」區塊
- architect 不再直接呼叫 search.py 產出 design-system.md
- 改為在 design.md 中標記「需要設計系統」，由 DESIGN 階段處理

### 7. 文件同步
- CLAUDE.md 更新（Pipeline 架構表、Agent 配置、stage 數量）
- `docs/ref/pipeline.md` 更新
- `dashboard/config.json` 更新
- `openspec/schemas/vibe-pipeline/schema.yaml` 更新
- `docs/plugin-specs.json` 確認
- `plugin.json` 版號 -> 1.0.29

## 能力定義（Capabilities）

- [ ] C1：Pipeline 9 階段順序定義 — registry.js + pipeline.json 同步新增 DESIGN stage
- [ ] C2：條件性路由 — stage-transition 根據前端偵測結果決定 ARCH->DESIGN 或 ARCH->DEV
- [ ] C3：Designer Pipeline 模式 — designer agent 接收 proposal.md + design.md，產出 design-system.md + HTML mockup
- [ ] C4：Task Classifier 條件性 DESIGN — feature 類型偵測到前端框架時 expectedStages 包含 DESIGN
- [ ] C5：OpenSpec DESIGN 階段 context — stage-transition 注入 DESIGN 階段的 OpenSpec 上下文提示
- [ ] C6：Architect 職責精簡 — 移除 architect 的 search.py 條件呼叫，改由 DESIGN 階段處理
- [ ] C7：全系統文件同步 — CLAUDE.md / pipeline.md / dashboard config / schema.yaml 一致

## 影響分析（Impact）

- **受影響檔案**：
  - `plugins/vibe/scripts/lib/registry.js` -- 新增 DESIGN stage
  - `plugins/vibe/pipeline.json` -- 新增 DESIGN stage + provides
  - `plugins/vibe/scripts/hooks/stage-transition.js` -- 條件路由 + 跳過邏輯 + DESIGN context
  - `plugins/vibe/scripts/hooks/task-classifier.js` -- STAGE_MAPS 條件性 DESIGN
  - `plugins/vibe/scripts/lib/flow/classifier.js` -- 無需修改（分類邏輯不變）
  - `plugins/vibe/agents/designer.md` -- Pipeline 模式工作流 + HTML mockup
  - `plugins/vibe/agents/architect.md` -- 移除設計整合區塊
  - `plugins/vibe/skills/design/SKILL.md` -- 待確認是否需要調整
  - `plugins/vibe/.claude-plugin/plugin.json` -- 版號更新
  - `plugins/vibe/scripts/hooks/pipeline-init.js` -- 無需修改（動態發現）
  - `plugins/vibe/scripts/hooks/pipeline-guard.js` -- 無需修改（state 驅動）
  - `plugins/vibe/scripts/hooks/pipeline-check.js` -- 無需修改（動態發現）
  - `plugins/vibe/scripts/lib/sentinel/guard-rules.js` -- 無需修改
  - `plugins/vibe/scripts/lib/flow/pipeline-discovery.js` -- 無需修改
  - `openspec/schemas/vibe-pipeline/schema.yaml` -- 新增 design-system artifact
  - `dashboard/config.json` -- 新增 DESIGN 相關配置
  - `docs/ref/pipeline.md` -- pipeline 文件更新
  - `docs/plugin-specs.json` -- 確認數量
  - `CLAUDE.md` -- 多處數字和表格更新

- **受影響模組**：flow（核心路由）、sentinel（無需改，state 驅動）
- **registry.js 變更**：是 -- 新增 DESIGN stage 定義
- **hook 變更**：stage-transition（路由邏輯）、task-classifier（expectedStages）

## 階段分解

### Phase 1：核心定義（registry + pipeline.json）
- **產出**：DESIGN stage 在 registry.js 和 pipeline.json 中正式定義
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/lib/registry.js` -- 新增 DESIGN stage（agent: designer, emoji: paintbrush, label: 設計, color: cyan）
  - `/Users/sbu/projects/vibe/plugins/vibe/pipeline.json` -- stages 陣列插入 DESIGN、stageLabels 新增、provides 新增 DESIGN entry
- **依賴**：無
- **風險**：STAGE_ORDER 是 `Object.keys(STAGES)` 自動生成，DESIGN 的插入位置取決於 STAGES 物件中的屬性順序。JS 物件的 key 順序為插入順序，因此必須在 ARCH 之後、DEV 之前插入。
- **驗收條件**：
  - `STAGE_ORDER` 為 `['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS']`
  - `AGENT_TO_STAGE['designer']` === `'DESIGN'`
  - `NAMESPACED_AGENT_TO_STAGE['vibe:designer']` === `'DESIGN'`
  - `pipeline.json` 的 stages 陣列含 DESIGN
  - `pipeline.json` 的 provides.DESIGN 指向 designer agent 和 `/vibe:design` skill

### Phase 2：條件路由（stage-transition 智慧跳過）
- **產出**：ARCH 完成後根據前端偵測結果決定路由
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/hooks/stage-transition.js` -- 新增 DESIGN 跳過邏輯（類似 E2E 的 isApiOnly 跳過）
- **依賴**：Phase 1
- **風險**：
  - 前端偵測判斷邏輯需明確定義。建議使用 `state.environment` 中的 `framework` 資訊 + `tools.designSystem` 判斷。
  - 需確認 `env-detector.js` 的 framework 偵測覆蓋率是否足夠。目前偵測 11 種框架，其中 8 種為前端框架（next.js / nuxt / remix / astro / svelte / vue / react / angular），3 種為後端框架（express / fastify / hono）。
- **設計決策**：
  - 判斷條件：框架為前端類型 OR pipeline state 中有 `needsDesign: true` 標記（由 architect 在 design.md 中標記）
  - 前端框架清單：`['next.js', 'nuxt', 'remix', 'astro', 'svelte', 'vue', 'react', 'angular']`（與 task-classifier 中的 `FRONTEND_FRAMEWORKS` 一致）
  - 跳過條件：非前端框架 AND 無 `needsDesign` 標記
  - 跳過訊息格式：`DESIGN（純後端/CLI 專案不需視覺設計）`
- **驗收條件**：
  - 前端專案（React/Vue/Next.js 等）：ARCH -> DESIGN -> DEV
  - 後端專案（Express/Fastify 等）：ARCH -> DEV（跳過 DESIGN）
  - state.environment.framework 判斷正確路由
  - 跳過時在 systemMessage 中顯示跳過說明

### Phase 3：Designer Agent 增強
- **產出**：designer agent 支援 Pipeline 模式工作流
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/agents/designer.md` -- 新增 Pipeline 模式區塊
  - `/Users/sbu/projects/vibe/plugins/vibe/agents/architect.md` -- 移除「前端設計整合（條件執行）」區塊
- **依賴**：Phase 1
- **風險**：
  - designer agent 需要能讀取 openspec change 目錄中的 proposal.md 和 design.md
  - HTML mockup 產出需要定義模板結構和品質標準
  - ui-ux-pro-max 未安裝時的降級方案（目前已有 NOT_FOUND 檢查，但 pipeline 模式下需要更明確的處理）
- **設計決策**：
  - Pipeline 模式下 designer 產出：design-system.md + design-mockup.html
  - 獨立模式（/vibe:design）保持現有行為不變
  - HTML mockup 為自包含 HTML 檔案（inline CSS/JS），可直接在瀏覽器開啟
  - 降級方案：search.py 不可用時，designer 基於 proposal.md 和 design.md 手動產出基礎設計規範（不依賴 ui-ux-pro-max）
- **驗收條件**：
  - designer agent 在 pipeline 模式下能讀取 proposal.md + design.md
  - 產出 design-system.md 到 openspec change 目錄
  - 產出 design-mockup.html 可在瀏覽器預覽
  - 獨立模式行為不受影響

### Phase 4：Task Classifier 條件性 DESIGN
- **產出**：feature 類型偵測到前端時 expectedStages 包含 DESIGN
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/hooks/task-classifier.js` -- STAGE_MAPS.feature 動態化
- **依賴**：Phase 1
- **風險**：
  - `STAGE_MAPS` 目前是靜態常量。改為動態需要確保不破壞現有分類邏輯。
  - 偵測前端框架需要在 task-classifier 執行時讀取 pipeline state 的 environment 資訊。
- **設計決策**：
  - `STAGE_MAPS.feature` 保持靜態為完整 9 階段（含 DESIGN）
  - 在 pipeline-init 階段或 task-classifier 中，根據 env-detector 結果決定是否從 expectedStages 移除 DESIGN
  - 替代方案：不在 task-classifier 處理，完全由 stage-transition 的跳過邏輯處理（更簡潔，待確認）
- **驗收條件**：
  - 前端專案的 expectedStages 包含 DESIGN
  - 後端專案的 expectedStages 不包含 DESIGN
  - pipeline-check 正確處理 DESIGN 階段的存在/缺失

### Phase 5：OpenSpec + Stage Context 整合
- **產出**：DESIGN 階段的 OpenSpec 上下文提示完整
- **修改檔案**：
  - `/Users/sbu/projects/vibe/plugins/vibe/scripts/hooks/stage-transition.js` -- 新增 DESIGN 的 OpenSpec context + POST_STAGE_HINTS
  - `/Users/sbu/projects/vibe/openspec/schemas/vibe-pipeline/schema.yaml` -- 新增 design-system artifact
- **依賴**：Phase 2
- **風險**：
  - POST_STAGE_HINTS.ARCH 目前提示 DEV 參考 design-system.md。插入 DESIGN 階段後，ARCH 的 hint 應指向 DESIGN，DESIGN 的 hint 指向 DEV。
  - stage-transition 中現有的 design-system 偵測邏輯（DEV 階段 context 注入）需要調整。
- **驗收條件**：
  - `openspecEnabled` 時，DESIGN 階段有正確的 OpenSpec context 提示
  - POST_STAGE_HINTS 調整：ARCH -> DESIGN 提示（而非 DEV 提示）
  - schema.yaml 新增 design-system artifact（requires: [proposal, design]）
  - design-system 偵測邏輯從 DEV context 注入改為 DESIGN 階段處理

### Phase 6：文件同步 + 測試
- **產出**：所有文件同步 + 測試通過
- **修改檔案**：
  - `/Users/sbu/projects/vibe/CLAUDE.md` -- Pipeline 架構表（8->9 階段）、Agent 配置規範、Hooks 事件全景確認
  - `/Users/sbu/projects/vibe/docs/ref/pipeline.md` -- pipeline 流程文件
  - `/Users/sbu/projects/vibe/dashboard/config.json` -- flowPhases/stageConfig/agentWorkflows/taskRoutes
  - `/Users/sbu/projects/vibe/docs/plugin-specs.json` -- 確認數量（agent/skill 數量不變）
  - `/Users/sbu/projects/vibe/plugins/vibe/.claude-plugin/plugin.json` -- version 1.0.29
  - `/Users/sbu/projects/vibe/plugins/vibe/tests/` -- 新增/更新測試
- **依賴**：Phase 1-5
- **風險**：
  - CLAUDE.md 中有多處硬編碼的「8 階段」文字需全部更新
  - dashboard/config.json 的 flowPhases 結構需決定 DESIGN 歸屬（FLOW phase 或獨立 phase）
  - 現有 14 個測試檔案需確認無 hardcode 8 階段假設
- **驗收條件**：
  - 所有現有測試通過（14 個測試檔案）
  - 新增 DESIGN 階段專屬測試：
    - stage-transition 條件路由測試（前端 -> DESIGN / 後端 -> 跳過）
    - registry DESIGN stage 映射測試
    - task-classifier DESIGN 包含/排除測試
  - CLAUDE.md 所有數字與實際一致
  - dashboard/config.json 與 pipeline.json 一致

## 風險摘要

| 風險 | 嚴重度 | 緩解方案 |
|------|:------:|---------|
| STAGE_ORDER 插入順序依賴 JS 物件 key 順序 | 中 | 在 registry.js 中 DESIGN 定義放在 ARCH 和 DEV 之間，並加註釋說明順序重要性；或改用顯式陣列定義 STAGE_ORDER |
| 前端偵測覆蓋率不足（某些專案未被 env-detector 識別） | 低 | architect 可在 pipeline state 設 `needsDesign: true` 作為備選路由觸發條件 |
| 現有測試 hardcode 8 階段 | 中 | Phase 6 全面掃描測試中的 stage 假設，逐一修正 |
| designer HTML mockup 品質標準未定義 | 低 | Phase 3 先定義基礎模板結構，後續迭代改進 |
| POST_STAGE_HINTS 鏈調整遺漏 | 中 | Phase 5 明確列出所有 hint 調整項目，逐一驗證 |
| task-classifier STAGE_MAPS 動態化複雜度 | 中 | 替代方案：保持 STAGE_MAPS 靜態，完全由 stage-transition 跳過邏輯處理（更簡潔） |
| CLAUDE.md 數字更新遺漏 | 低 | `claude-md-check` Stop hook 會自動偵測不一致 |

## 回滾計畫

1. **Git 回滾**：所有變更在單一 commit 中，`git revert` 即可完整回滾
2. **registry.js 回滾**：移除 DESIGN entry，STAGE_ORDER 自動恢復為 8 階段
3. **pipeline.json 回滾**：移除 DESIGN stage 和 provides
4. **stage-transition 回滾**：移除 DESIGN 跳過邏輯和 context 注入
5. **designer.md 回滾**：恢復到 v1.0.27 版本（純獨立模式）
6. **architect.md 回滾**：恢復「前端設計整合」區塊

所有變更都是新增/修改型（非刪除型），回滾風險低。pipeline-discovery 的動態發現機制確保移除 DESIGN stage 後其他階段不受影響。

## 待確認事項

1. **STAGE_MAPS 策略**：feature 的 STAGE_MAPS 是靜態包含 DESIGN 後由 stage-transition 跳過，還是動態生成 expectedStages？建議使用前者（更簡潔，跳過邏輯集中在 stage-transition）。
2. **HTML mockup 開啟方式**：designer 產出 mockup 後，是否由 stage-transition 自動呼叫 `open` 指令在瀏覽器開啟？還是提示使用者手動開啟？
3. **DESIGN 階段使用者確認**：DESIGN 是否需要突破 pipeline 自動模式，允許 AskUserQuestion 讓使用者確認設計方向？如果是，pipeline-guard 需要為 DESIGN 階段開特例。
4. **designer agent model**：目前是 sonnet。Pipeline 模式下是否需要升級到 opus 以獲得更好的設計判斷？
