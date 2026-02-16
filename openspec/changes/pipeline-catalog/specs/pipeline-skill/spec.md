# Pipeline Skill Delta Spec（Phase 2）

## ADDED Requirements

### Requirement: Main Agent 模型建議章節
`/vibe:pipeline` SKILL.md MUST 新增「Main Agent 模型建議」章節，說明如何使用 Sonnet 作為 Main Agent 路由器。

#### Scenario: 包含 CLI 用法
WHEN 使用者閱讀 SKILL.md
THEN MUST 包含 `claude --model sonnet` 或 `ANTHROPIC_MODEL=claude-sonnet-4-20250514` 的用法說明

#### Scenario: 包含成本效益分析
WHEN 使用者閱讀 SKILL.md
THEN MUST 說明 Sonnet Main Agent + Opus sub-agents 的成本效益
AND MUST 說明 pipeline 模式下 Main Agent 僅做路由（非推理密集型任務）

#### Scenario: 包含 alias 範例
WHEN 使用者閱讀 SKILL.md
THEN MUST 包含 alias 設定範例（如 `alias vc='claude --model sonnet --plugin-dir ...'`）

#### Scenario: 包含安全保障說明
WHEN 使用者閱讀 SKILL.md
THEN MUST 說明 pipeline-guard 是 exit 2 硬阻擋，不依賴 Main Agent 模型能力
AND MUST 說明 sub-agent 模型由 agent 定義決定（不受 Main Agent 模型影響）

### Requirement: Layer 3 環境變數說明
`/vibe:pipeline` SKILL.md MUST 新增 Layer 3 LLM 分類器的環境變數說明。

#### Scenario: 包含 VIBE_CLASSIFIER_MODEL 說明
WHEN 使用者閱讀 SKILL.md
THEN MUST 說明 `VIBE_CLASSIFIER_MODEL` 環境變數（預設 Sonnet、可切換 Haiku）

#### Scenario: 包含 VIBE_CLASSIFIER_THRESHOLD 說明
WHEN 使用者閱讀 SKILL.md
THEN MUST 說明 `VIBE_CLASSIFIER_THRESHOLD` 環境變數（預設 0.7、設為 0 停用 Layer 3）
