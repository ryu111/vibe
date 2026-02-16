# CLAUDE.md Delta Spec（Phase 2）

## ADDED Requirements

### Requirement: Main Agent 路由器模式說明
CLAUDE.md MUST 新增「Main Agent 路由器模式」章節（位於 Pipeline Catalog 段落之後），說明 Sonnet Main Agent 配置。

#### Scenario: 包含推薦配置
WHEN 開發者閱讀 CLAUDE.md
THEN MUST 說明 Pipeline 模式下 Main Agent 僅做路由分發
AND MUST 推薦 `claude --model sonnet` 用法
AND MUST 說明 sub-agent 模型不受 Main Agent 模型影響（由 agent 定義決定）

#### Scenario: 包含安全保障
WHEN 開發者閱讀 CLAUDE.md
THEN MUST 說明 pipeline-guard 是 exit 2 硬阻擋（不依賴模型遵從性）
AND MUST 說明 task-classifier 是 command hook（不依賴 Main Agent 模型能力）

#### Scenario: 包含環境變數列表
WHEN 開發者閱讀 CLAUDE.md
THEN MUST 列出以下環境變數：
  - `VIBE_CLASSIFIER_MODEL` -- Layer 3 LLM 分類模型（預設 Sonnet）
  - `VIBE_CLASSIFIER_THRESHOLD` -- Layer 2→3 降級閾值（預設 0.7）
