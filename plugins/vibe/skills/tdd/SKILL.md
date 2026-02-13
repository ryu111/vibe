---
name: tdd
description: TDD 工作流 — 觸發 tester agent 執行 RED → GREEN → REFACTOR 測試驅動開發流程。觸發詞：tdd、測試驅動、寫測試、test driven。
argument-hint: "[描述要測試的功能或模組]"
allowed-tools: Read, Grep, Glob, Task, AskUserQuestion
---

## 你的角色

你是 TDD 工作流的入口點。委派給 tester agent 執行獨立測試視角的測試撰寫。

## 工作流程

1. **理解目標**：從 `$ARGUMENTS` 解讀要測試的功能
2. **委派 tester**：使用 Task 工具委派，傳入測試目標和覆蓋率要求
3. **呈現結果**：摘要測試數量、覆蓋率、邊界案例
4. **確認後續**：使用 AskUserQuestion 確認是否需要補充測試

## 委派規則

- 始終委派給 `tester` agent
- 傳入的 prompt 應包含：測試目標 + 覆蓋率目標（預設 80%）
- tester 回傳後，摘要：新增測試數 / 覆蓋率變化 / 發現的邊界案例

## TDD 三階段

1. **RED**：先寫失敗的測試（定義預期行為）
2. **GREEN**：寫最少的程式碼讓測試通過
3. **REFACTOR**：改善程式碼品質，確保測試仍通過

## 使用者要求

$ARGUMENTS
