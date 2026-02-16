# Pipeline Skill Delta Spec（Phase 3）

## MODIFIED Requirements

### Requirement: /vibe:pipeline 雙模式
`/vibe:pipeline` SKILL.md MUST 升級為雙模式：無參數時提供互動式 AskUserQuestion 選擇器，有參數時維持現有行為。

#### Scenario: 無參數觸發互動式選擇器
WHEN 使用者執行 `/vibe:pipeline`（無參數）
THEN MUST 使用 AskUserQuestion（multiSelect: false）顯示 10 種 pipeline 模板
AND 每個選項 MUST 包含 pipeline label 和簡要描述
AND 選項排序 MUST 按使用頻率（full/standard/quick-dev 在前）

#### Scenario: 使用者選擇 pipeline 後
WHEN 使用者從 AskUserQuestion 選擇了一個 pipeline（如 "full"）
THEN MUST 在回應中指引使用者在下一個 prompt 中使用 `[pipeline:full]` 語法
AND MUST 說明此語法會觸發 Layer 1 顯式覆寫（100% 信心度）
AND MUST 不直接修改 pipeline state（pipeline 啟動由 task-classifier 處理）

#### Scenario: 有參數維持現有行為
WHEN 使用者執行 `/vibe:pipeline full`
THEN 行為 MUST 與現有完全一致（顯示 full pipeline 的詳細資訊）
AND MUST 不顯示 AskUserQuestion

#### Scenario: Pipeline 進行中的處理
WHEN 使用者在 pipeline 進行中呼叫 `/vibe:pipeline`
THEN pipeline-guard MUST 攔截 AskUserQuestion（exit 2 硬阻擋）
AND SKILL.md MUST 包含說明：「Pipeline 進行中不支援切換，請先用 /cancel 退出」

#### Scenario: Skill 技術規格不變
WHEN 驗證 V-SK 規則
THEN argument-hint MUST 保持為 `"[可選：pipeline 模板名稱，如 full]"`
AND MUST 為 Reference skill（不 fork agent）
AND MUST 不超過 15,000 字元預算

#### Scenario: 選項格式
WHEN AskUserQuestion 顯示選項
THEN 每個選項 MUST 使用以下格式：
  - label: `"{label}（{id}）"`，如 `"完整開發（full）"`
  - description: `"{description} | 階段：{stages}"`，如 `"新功能（含 UI）| 階段：PLAN→ARCH→DESIGN→DEV→REVIEW→TEST→QA→E2E→DOCS"`
