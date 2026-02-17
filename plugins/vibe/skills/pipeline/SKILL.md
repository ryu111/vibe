---
name: pipeline
description: Pipeline 動態規劃 — 委派 pipeline-architect agent 分析需求並產出自訂 DAG 執行計劃。
argument-hint: "[可選：使用者的需求描述]"
---

# Pipeline 動態規劃

你是 Vibe Pipeline 的啟動入口。當使用者需要 pipeline 時，委派 `pipeline-architect` agent 分析需求並產出執行計劃。

## 執行步驟

1. 讀取環境 context（從 `~/.claude/pipeline-state-{sessionId}.json`）
2. 委派 `pipeline-architect` agent（使用 Task 工具）
3. 將以下資訊傳給 agent：
   - 使用者原始需求
   - 環境偵測結果（語言、框架、前端/後端）
   - OpenSpec 是否啟用

### 委派範例

```
Task({
  subagent_type: "vibe:pipeline-architect",
  description: "分析需求並產出 Pipeline DAG",
  prompt: `
分析以下需求並產出最佳的 Pipeline 執行計劃：

## 使用者需求
{使用者的 prompt}

## 專案環境
- 語言：{language}
- 框架：{framework}
- 前端偵測：{frontend.detected}
- OpenSpec：{openspecEnabled}

請根據需求選擇最合適的 stages 組合，定義依賴關係，並輸出 DAG JSON。
`
})
```

## Stage 定義表（提供給 Agent 參考）

| Stage | Agent | 能力 | Skill |
|-------|-------|------|-------|
| PLAN | planner | 需求分析、scope 定義 | /vibe:scope |
| ARCH | architect | 架構設計、技術決策 | /vibe:architect |
| DESIGN | designer | UI/UX 設計系統 | /vibe:design |
| DEV | developer | 程式碼實作 | /vibe:dev |
| REVIEW | code-reviewer | 程式碼審查 | /vibe:review |
| TEST | tester | 單元/整合測試 | /vibe:tdd |
| QA | qa | 行為驗證 | /vibe:qa |
| E2E | e2e-runner | 端對端測試 | /vibe:e2e |
| DOCS | doc-updater | 文件整理 | /vibe:doc-sync |

## 常見 DAG 模式

### 完整功能（含 UI）
```
PLAN → ARCH → DESIGN → DEV → [REVIEW + TEST] → [QA + E2E] → DOCS
```

### 標準功能（無 UI）
```
PLAN → ARCH → DEV → [REVIEW + TEST] → DOCS
```

### 快速修復
```
DEV → [REVIEW + TEST]
```

### 一行修改
```
DEV
```

### TDD
```
TEST:write → DEV → TEST:verify
```

## 顯式覆寫語法

使用者可在 prompt 中使用 `[pipeline:xxx]` 語法直接指定預設模板（不經 Agent）：

- `full` / `standard` / `quick-dev` / `fix` / `test-first`
- `ui-only` / `review-only` / `docs-only` / `security` / `none`

例如：`實作登入功能 [pipeline:full]`

## DAG 輸出格式

pipeline-architect agent 會輸出：

```
<!-- PIPELINE_DAG_START -->
{
  "dag": { ... },
  "enforced": true,
  "rationale": "...",
  "blueprint": [...]
}
<!-- PIPELINE_DAG_END -->
```

stage-transition hook 會自動解析此輸出並建立 pipeline 狀態。

## 參數說明

- 帶參數：將參數作為需求描述傳給 pipeline-architect
- 不帶參數：提示使用者描述需求，或使用 `[pipeline:xxx]` 語法
