# Designer Agent Delta Spec

## ADDED Requirements

### Requirement: Pipeline 模式工作流

designer agent 在 Pipeline 模式下接收 proposal.md 和 design.md 作為輸入，產出 design-system.md 和 design-mockup.html。

#### Scenario: Pipeline 模式偵測

WHEN designer 被 pipeline stage-transition 委派
THEN 偵測 openspec/changes/ 中的活躍 change 目錄
AND 讀取 proposal.md 和 design.md
AND 以 Pipeline 模式執行

#### Scenario: Pipeline 模式產出

WHEN Pipeline 模式執行完成
THEN 產出 design-system.md 到 openspec/changes/{name}/design-system.md
AND 產出 design-mockup.html 到 openspec/changes/{name}/design-mockup.html

#### Scenario: design-mockup.html 格式

WHEN design-mockup.html 被產出
THEN 檔案為自包含 HTML（inline CSS + JS）
AND 可直接在瀏覽器開啟預覽
AND 包含色彩方案視覺化
AND 包含字體配對展示
AND 包含關鍵元件 mockup

#### Scenario: search.py 不可用時的降級

WHEN Pipeline 模式下 search.py 回傳 NOT_FOUND
THEN designer 基於 proposal.md 和 design.md 手動產出基礎設計規範
AND 不依賴 ui-ux-pro-max
AND 在 design-system.md 標記「手動產出，未使用 ui-ux-pro-max」

#### Scenario: 獨立模式不受影響

WHEN designer 被 /vibe:design 直接呼叫（非 pipeline）
THEN 行為與修改前完全一致
AND 不要求 proposal.md 或 design.md

### Requirement: 身份標識

designer agent 在 Pipeline 模式下輸出正確的身份標識。

#### Scenario: 開始工作

WHEN Pipeline 模式開始
THEN 輸出 '🎨 Designer 開始設計分析...'

#### Scenario: 完成工作

WHEN Pipeline 模式完成
THEN 輸出 '🎨 Designer 設計分析完成'

## REMOVED Requirements

### Requirement: Architect 前端設計整合（條件執行）

architect.md 中的「前端設計整合（條件執行）」區塊被移除。此職責移交給 DESIGN 階段的 designer agent。

Reason: 職責分離 -- architect 專注技術架構，designer 專注視覺設計
Migration: architect 不再呼叫 search.py，改為在 design.md 中標記「需要設計系統」供 DESIGN 階段處理
