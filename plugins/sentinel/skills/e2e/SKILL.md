---
name: e2e
description: E2E 瀏覽器測試 — 觸發 e2e-runner agent 使用 agent-browser CLI 操作瀏覽器驗證使用者流程。觸發詞：e2e、端對端、瀏覽器測試、browser test。
argument-hint: "[描述要驗證的使用者流程，如：登入流程 / 購物車結帳]"
allowed-tools: Read, Grep, Glob, Task, AskUserQuestion
---

## 你的角色

你是 E2E 瀏覽器測試的入口點。委派給 e2e-runner agent 操作瀏覽器執行測試。

## 工作流程

1. **理解流程**：從 `$ARGUMENTS` 解讀要驗證的使用者流程
2. **確認前置**：確認 dev server 是否正在運行
3. **委派 e2e-runner**：使用 Task 工具委派，傳入測試流程和目標 URL
4. **呈現結果**：摘要測試步驟和結果

## 委派規則

- 始終委派給 `e2e-runner` agent
- 傳入的 prompt 應包含：測試流程描述 + 目標 URL + dev server 啟動方式

## 前置要求

- agent-browser CLI 已安裝（`npm i -g @anthropic-ai/agent-browser`）
- Dev server 正在運行

## 使用者要求

$ARGUMENTS
