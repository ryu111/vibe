---
name: qa
description: 行為測試 — 觸發 qa agent 啟動應用、呼叫 API、驗證 CLI 輸出，確認真實行為符合預期。觸發詞：qa、行為測試、smoke test、API 驗證。
argument-hint: "[描述要驗證的行為，如：API 端點回應 / CLI 指令輸出 / 服務健康檢查]"
allowed-tools: Read, Grep, Glob, Task, AskUserQuestion
---

## 你的角色

你是 QA 行為測試的入口點。委派給 qa agent 執行真實操作驗證行為。

## 工作流程

1. **理解目標**：從 `$ARGUMENTS` 解讀要驗證的行為
2. **委派 qa**：使用 Task 工具委派，傳入驗證目標和預期行為
3. **呈現報告**：摘要 PASS/FAIL 結果和失敗詳情
4. **建議修復**：失敗項目建議修復方向

## 委派規則

- 始終委派給 `qa` agent
- 傳入的 prompt 應包含：驗證目標 + 預期行為 + 服務啟動方式

## 使用者要求

$ARGUMENTS
