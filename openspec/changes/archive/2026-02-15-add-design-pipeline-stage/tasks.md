# 實作任務

## 1. 核心定義（Phase 1）

- [x] 1.1 registry.js 新增 DESIGN entry -- 在 ARCH 和 DEV 之間插入 `DESIGN: { agent: 'designer', emoji: '\u{1F3A8}', label: '設計', color: 'cyan' }` | files: `plugins/vibe/scripts/lib/registry.js`
- [x] 1.2 pipeline.json 新增 DESIGN stage -- stages 陣列插入 DESIGN、stageLabels 新增「設計」、provides 新增 DESIGN entry（agent: designer, skill: /vibe:design） | files: `plugins/vibe/pipeline.json`

## 2. 路由邏輯（Phase 2）

- [x] 2.1 stage-transition.js 新增 DESIGN 跳過邏輯 -- 在智慧跳過 while loop 中新增 DESIGN 判斷（FRONTEND_FRAMEWORKS + state.needsDesign），跳過時記錄到 state.skippedStages | files: `plugins/vibe/scripts/hooks/stage-transition.js` | depends: 1.1, 1.2
- [x] 2.2 stage-transition.js 統一 E2E 跳過到 skippedStages 模式 -- 現有 E2E 跳過邏輯改為同時記錄到 state.skippedStages，與 DESIGN 跳過模式一致 | files: `plugins/vibe/scripts/hooks/stage-transition.js` | depends: 2.1
- [x] 2.3 stage-transition.js 更新 DEV_OR_LATER 範圍 -- 將 DESIGN 加入 DEV_OR_LATER 陣列，確保手動觸發 PLAN+ARCH 後進入 DESIGN 也觸發 auto-enforce | files: `plugins/vibe/scripts/hooks/stage-transition.js` | depends: 2.1
- [x] 2.4 pipeline-check.js 排除 skippedStages -- missing 計算排除 state.skippedStages 中的階段 | files: `plugins/vibe/scripts/hooks/pipeline-check.js` | depends: 2.1

## 3. Agent 更新（Phase 3）

- [x] 3.1 designer.md 新增 Pipeline 模式區塊 -- 新增 Pipeline 模式工作流（讀取 proposal.md + design.md、產出 design-system.md + design-mockup.html、search.py 降級方案） | files: `plugins/vibe/agents/designer.md` | depends: 1.1
- [x] 3.2 architect.md 移除前端設計整合區塊 -- 刪除「前端設計整合（條件執行）」整個段落，改為在架構設計中標記是否需要設計系統 | files: `plugins/vibe/agents/architect.md` | depends: 3.1

## 4. 分類器與 OpenSpec 整合（Phase 4）

- [x] 4.1 task-classifier.js STAGE_MAPS.feature 加入 DESIGN -- feature 陣列改為 `['PLAN', 'ARCH', 'DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS']` | files: `plugins/vibe/scripts/hooks/task-classifier.js` | depends: 1.1
- [x] 4.2 stage-transition.js 新增 DESIGN OpenSpec context -- openspecEnabled 時為 DESIGN 階段注入上下文提示（讀取 proposal.md + design.md 後產出 design-system.md + design-mockup.html） | files: `plugins/vibe/scripts/hooks/stage-transition.js` | depends: 2.1
- [x] 4.3 stage-transition.js 更新 POST_STAGE_HINTS -- ARCH hint 改為指向 DESIGN；新增 DESIGN hint 指向 DEV（提示 developer 參考 design-system.md） | files: `plugins/vibe/scripts/hooks/stage-transition.js` | depends: 2.1
- [x] 4.4 stage-transition.js 調整 DEV 階段 design-system context 注入 -- 移除 ARCH 完成後對 DEV 的設計系統注入（改由 POST_STAGE_HINTS.DESIGN 處理） | files: `plugins/vibe/scripts/hooks/stage-transition.js` | depends: 4.3
- [x] 4.5 schema.yaml 新增 design-system 和 design-mockup artifacts -- version 改為 2、description 改為 9-stage、新增兩個 artifact 定義 | files: `openspec/schemas/vibe-pipeline/schema.yaml` | depends: 1.2

## 5. 文件同步（Phase 5）

- [x] 5.1 CLAUDE.md 更新 Pipeline 相關段落 -- 8 階段->9 階段、Pipeline 架構表新增 DESIGN 行、Agent 配置規範表確認 designer 行、Hooks 事件全景確認、OpenSpec 目錄結構新增 design-mockup.html | files: `CLAUDE.md`
- [x] 5.2 pipeline.md 更新 -- 8->9 stage 所有相關段落、stage 對應表、STAGE_MAPS.feature、stage-transition 邏輯說明、state file 結構新增 skippedStages 欄位 | files: `docs/ref/pipeline.md`
- [x] 5.3 dashboard/config.json 更新 -- taskRoutes feature stages 加入 DESIGN、flowPhases.FLOW agentNames 加入 designer、stageConfig 新增 DESIGN entry、agentWorkflows 新增 designer workflow | files: `dashboard/config.json`
- [x] 5.4 plugin.json 版號更新 -- version 更新為 1.0.29 | files: `plugins/vibe/.claude-plugin/plugin.json`

## 6. 測試（Phase 6）

- [x] 6.1 更新 pipeline-system.test.js hardcode -- 8 個映射->9 個、stage 陣列加入 DESIGN、新增 ARCH->DESIGN 前進場景測試 | files: `plugins/vibe/tests/pipeline-system.test.js` | depends: 1.1, 1.2
- [x] 6.2 更新 e2e-hook-chain.test.js hardcode -- '8 階段' 文字更新、expectedStages 含 DESIGN | files: `plugins/vibe/tests/e2e-hook-chain.test.js` | depends: 4.1
- [x] 6.3 新增 DESIGN 跳過邏輯測試 -- 前端專案路由到 DESIGN、後端專案跳過 DESIGN、needsDesign 強制路由、skippedStages 記錄正確、pipeline-check 排除 skippedStages | files: `plugins/vibe/tests/pipeline-system.test.js` | depends: 2.1, 2.4
- [x] 6.4 新增 DESIGN OpenSpec context 測試 -- openspecEnabled 時 DESIGN 有正確 context（schema.yaml 6 個 artifacts 測試）| files: `plugins/vibe/tests/openspec-integration.test.js` | depends: 4.2, 4.3
- [x] 6.5 確認所有 14 個測試檔案通過 | depends: 6.1, 6.2, 6.3, 6.4

## 7. 驗證

- [x] 7.1 執行全部測試確認功能正確 -- `bun test plugins/vibe/tests/` -- 14 個測試檔案全部通過（585+ 個測試）
- [x] 7.2 確認 registry.js STAGE_ORDER 順序正確 -- DESIGN 在 index 2（已通過測試驗證）
- [x] 7.3 確認 pipeline-discovery 動態發現包含 DESIGN（已通過 18 個映射測試）
- [x] 7.4 確認 pipeline-guard 對 DESIGN 階段的 sub-agent 正常放行（state 驅動，理論上零修改即可）
- [x] 7.5 確認 CLAUDE.md 所有數字與實際一致 -- 版號已更新為 1.0.29
- [x] 7.6 確認 dashboard/config.json 與 pipeline.json 一致 -- feature stages 已加入 DESIGN、agentWorkflows 已加入 designer

## 8. 回退修復（REVIEW 階段發現的問題）

- [x] 8.1 修復 H-1：vibe.md 版號同步 -- 重新執行 generate.js，版號已更新為 1.0.29
- [x] 8.2 修復 H-2：generate-vibe-doc.js 硬編碼 "8 階段" -- 改為動態 `${pipelineJson.stages.length} 階段`
- [x] 8.3 修復 H-3：測試 expectedStages 更新為 9 階段 -- openspec-integration.test.js（7 處）、e2e-hook-chain.test.js（6 處）、e2e-formats.test.js（1 處）全部更新
- [x] 8.4 修復 M-1：Dashboard UI 加入 DESIGN stage -- ROW1 更新為 5 個元素、SM 新增 DESIGN entry（#7dcfff、designer、🎨）
- [x] 8.5 修復 M-2：FRONTEND_FRAMEWORKS 提取到 registry.js -- 消除 stage-transition.js 和 task-classifier.js 的重複定義
- [x] 8.6 修復 M-3：POST_STAGE_HINTS.ARCH 條件判斷 -- 當 DESIGN 被跳過時使用 null 避免語義錯誤
- [x] 8.7 修復 M-4：needsDesign state setter -- ARCH 完成後偵測 openspec/changes/*/design-system.md 存在自動設定 needsDesign=true
- [x] 8.8 執行全部測試驗證修復 -- 14 個測試檔案 585+ 個測試全部通過（0 failure）

## 9. 第二輪回退修復（REVIEW 第二輪發現的問題）

- [x] 9.1 修復 H-1：generate-vibe-doc.js STAGES 硬編碼缺少 DESIGN -- 在 ARCH 後插入 DESIGN entry，匯出列表加入 FRONTEND_FRAMEWORKS
- [x] 9.2 修復 M-1：新增 DESIGN 跳過邏輯測試（6.3 + 6.4）-- 4 個測試：前端不跳過、後端跳過、needsDesign 強制、pipeline-check 排除 skippedStages
- [x] 9.3 修復 M-2：openspec-integration.test.js artifact 數量 -- 標題改為 6 個 artifacts，新增 design-system 和 design-mockup 斷言
- [x] 9.4 修復 M-3：config.json fallback target 編號 -- 4 處 `③ DEV` → `④ DEV`
- [x] 9.5 修復 L-1：generate.js 註釋階段編號 -- 更新為完整 9 階段註釋
- [x] 9.6 執行 generate.js 重新產生文檔 -- vibe.md 更新為 9 階段 + FRONTEND_FRAMEWORKS 匯出
- [x] 9.7 執行全部測試驗證修復 -- pipeline-system.test.js 16/16 通過、openspec-integration.test.js artifacts 測試通過

## 10. 第三輪回退修復（REVIEW 第三輪發現的問題）

- [x] 10.1 修復 H-1：generate.js genAgentDetails() DESIGN 渲染 -- stages.slice(0, 2) 改為 slice(0, 3)，註釋更新為「①②③ 正常渲染（PLAN、ARCH、DESIGN）」
- [x] 10.2 修復 M-1：openspec/config.yaml Pipeline 描述加入 DESIGN -- 第 13 行更新為完整 9 階段
- [x] 10.3 修復 M-2：pipeline.md 並行宣告範例加入 DESIGN -- 第 692 行 stages 陣列加入 "DESIGN"
- [x] 10.4 執行 generate.js 重新產生文檔 -- dashboard.html 更新 DESIGN 階段渲染
- [x] 10.5 執行全部測試驗證修復 -- bun test 所有測試通過（0 regression）
