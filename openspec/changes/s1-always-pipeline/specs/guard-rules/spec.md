# guard-rules.js Delta Spec

## MODIFIED Requirements

### Requirement: READ_ONLY_TOOLS 白名單

新增 AskUserQuestion 到唯讀工具白名單，允許 Main Agent 在 Relay 模式下詢問使用者。

完整的 READ_ONLY_TOOLS：
```javascript
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'TaskList', 'TaskGet',
  'AskUserQuestion',  // S1: Main Agent 不確定時可詢問使用者
]);
```

#### Scenario: pipelineActive + 無 activeStages + AskUserQuestion
WHEN pipelineActive === true
AND activeStages.length === 0（Relay 模式）
AND toolName === 'AskUserQuestion'
THEN evaluate() 回傳 `{ decision: 'allow' }`（在 Rule 6 READ_ONLY_TOOLS 放行）

#### Scenario: AskUserQuestion 在非 pipeline 模式
WHEN pipelineActive === false
THEN evaluate() 在 Rule 3 直接回傳 `{ decision: 'allow' }`（與之前行為一致）

#### Scenario: AskUserQuestion 在 sub-agent 委派中
WHEN pipelineActive === true
AND activeStages.length > 0
THEN evaluate() 在 Rule 4 直接回傳 `{ decision: 'allow' }`（與之前行為一致）

### Requirement: evaluate() 短路鏈文件更新

Rule 6 的 JSDoc 註解中新增 AskUserQuestion 說明。

更新後的規則描述：
```
6. READ_ONLY_TOOLS → allow（唯讀白名單 + AskUserQuestion 互動查詢）
```
