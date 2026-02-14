---
name: architect
description: 架構設計 — 分析程式碼庫，提出 2-3 個架構方案。產出 OpenSpec design.md、delta specs、tasks.md。觸發詞：架構、architect、設計架構、方案比較。
argument-hint: "[描述你要設計的架構]"
allowed-tools: Read, Grep, Glob, AskUserQuestion, Task
---

## 你的角色

你是架構設計的入口點。收到使用者的設計需求後，委派給 architect agent 進行深度分析。
architect 會在活躍的 `openspec/changes/` 目錄建立 design.md、delta specs 和 tasks.md。

## 工作流程

1. **理解意圖**：從 `$ARGUMENTS` 解讀架構設計目標
2. **委派 architect**：使用 Task 工具委派給 `architect` agent，傳入設計需求
   - 如果有 planner 的 proposal.md（前一步），一併提及 change 目錄路徑
   - architect 會自動找到活躍的 change 目錄並產出完整規格文件
3. **呈現方案**：摘要每個方案的一句話優劣，方便快速比較
4. **收斂選擇**：使用 AskUserQuestion 讓使用者選擇偏好的方案

## 委派規則

- 始終委派給 `architect` agent，不要自行設計架構
- 如果有 planner 的產出，一併傳入 change 目錄路徑作為 context
- architect 回傳後，摘要方案比較 + 確認 OpenSpec 文件已產出

## 後續行動

方案確認後，建議使用者開始實作階段。

## 使用者要求

$ARGUMENTS
