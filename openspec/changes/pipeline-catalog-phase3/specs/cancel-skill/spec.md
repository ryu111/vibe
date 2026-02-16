# Cancel Skill Delta Spec（Phase 3）

## MODIFIED Requirements

### Requirement: 分類錯誤回饋流程
cancel SKILL.md MUST 在解除 pipeline 鎖定後，新增 AskUserQuestion 詢問取消原因。

完整修改後的工作流程：

1. 偵測狀態（不變）
2. 顯示現況（不變）
3. 解除鎖定（不變）
4. **取消原因回饋（新增）**：AskUserQuestion 三選項
5. 自動蒐集誤判語料（擴充）
6. 確認結果（不變）

#### Scenario: AskUserQuestion 三選項
WHEN pipeline 解除完成且原 `pipelineEnforced` 為 true
THEN MUST 使用 AskUserQuestion（multiSelect: false）詢問：
  - (a) "分類錯誤 -- 自動分類選了錯誤的 pipeline"
  - (b) "不需要 pipeline -- 這個任務不需要走工作流"
  - (c) "其他原因 -- 跳過回饋"

#### Scenario: 選擇「分類錯誤」
WHEN 使用者選擇 (a) 分類錯誤
THEN MUST 進一步使用 AskUserQuestion 詢問「正確的 pipeline 應該是？」
AND 選項 MUST 包含 10 種 pipeline 模板（full/standard/quick-dev/fix/test-first/ui-only/review-only/docs-only/security/none）
AND 每個選項 MUST 顯示 pipeline label 和簡要描述

#### Scenario: 選擇正確 pipeline 後記錄
WHEN 使用者選擇了正確的 pipeline
THEN MUST 將修正記錄寫入 `~/.claude/classifier-corpus.jsonl`
AND MUST 更新 `~/.claude/classifier-stats.json`

#### Scenario: 選擇「不需要 pipeline」
WHEN 使用者選擇 (b)
THEN 行為 MUST 與現有 cancel 完全一致（只解除鎖定 + 現有語料蒐集）
AND corpus 記錄的 `reason` MUST 為 `'no-pipeline'`

#### Scenario: 選擇「其他原因」
WHEN 使用者選擇 (c)
THEN 行為 MUST 與現有 cancel 完全一致
AND corpus 記錄的 `reason` MUST 為 `'other'`

#### Scenario: 非 enforced pipeline 不詢問
WHEN pipeline 解除但原 `pipelineEnforced` 為 false
THEN MUST 不顯示 AskUserQuestion（輕量 pipeline 取消不值得回饋）
AND 仍執行現有語料蒐集

### Requirement: classifier-corpus.jsonl 格式升級
cancel SKILL.md 寫入 `classifier-corpus.jsonl` 的格式 MUST 擴充以下欄位。

#### Scenario: 分類錯誤記錄
WHEN reason 為 'wrong-classification'
THEN JSONL 行 MUST 包含：
```json
{
  "prompt": "觸發的原始 prompt",
  "actual": "state.taskType（legacy）",
  "cancelled": true,
  "completedStages": [],
  "timestamp": "ISO",
  "reason": "wrong-classification",
  "expectedPipeline": "使用者選擇的正確 pipeline ID",
  "pipelineId": "原始自動分類的 pipeline ID",
  "layer": 2,
  "confidence": 0.8,
  "source": "regex",
  "matchedRule": "action:feature"
}
```

#### Scenario: 向後相容
WHEN 舊格式 corpus 行不含 reason/expectedPipeline 等欄位
THEN 後續消費端（evolve 知識進化）MUST 能容忍欄位缺失

### Requirement: classifier-stats.json 更新
cancel SKILL.md MUST 在記錄分類錯誤時同步更新 `~/.claude/classifier-stats.json`。

#### Scenario: 首次寫入 stats
WHEN `~/.claude/classifier-stats.json` 不存在
THEN MUST 建立檔案，初始化結構：
```json
{
  "totalClassifications": 0,
  "corrections": {
    "total": 1,
    "byLayer": { "1": 0, "2": 1, "3": 0 },
    "bySource": { "regex": 1, "llm": 0 }
  },
  "recentWindow": [
    { "timestamp": "ISO", "layer": 2, "source": "regex", "corrected": true }
  ]
}
```

#### Scenario: 累積更新 stats
WHEN `~/.claude/classifier-stats.json` 已存在
THEN MUST 讀取現有資料
AND `corrections.total` +1
AND `corrections.byLayer[layer]` +1
AND `corrections.bySource[source]` +1
AND `recentWindow` 追加一筆 `{ corrected: true }`
AND `recentWindow` 超過 50 筆時 MUST 移除最舊的記錄

#### Scenario: 非分類錯誤不更新 corrections
WHEN reason 為 'no-pipeline' 或 'other'
THEN `corrections` 計數 MUST 不增加
AND `recentWindow` 追加一筆 `{ corrected: false }`

### Requirement: pipeline-state correctionCount
cancel SKILL.md MUST 在 pipeline-state 中更新 `correctionCount` 計數器。

#### Scenario: 記錄修正次數
WHEN 使用者選擇「分類錯誤」
THEN state.correctionCount MUST +1

#### Scenario: correctionCount 初始化
WHEN state.correctionCount 不存在
THEN MUST 初始化為 1（首次修正）
