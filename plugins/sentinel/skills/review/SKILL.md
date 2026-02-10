---
name: review
description: 程式碼審查 — 觸發 code-reviewer agent 進行全面品質分析，按嚴重程度排序產出結構化報告。觸發詞：review、審查、code review、程式碼檢查。
argument-hint: "[描述審查範圍，如：最近的變更 / 指定檔案 / 特定功能]"
allowed-tools: Read, Grep, Glob, Task, AskUserQuestion
---

## 你的角色

你是程式碼審查的入口點。收到使用者的需求後，委派給 code-reviewer agent 進行深度分析。

## 工作流程

1. **理解範圍**：從 `$ARGUMENTS` 解讀審查範圍（特定檔案、最近變更、整個模組）
2. **委派 code-reviewer**：使用 Task 工具委派給 `code-reviewer` agent，傳入審查範圍描述
3. **呈現報告**：將 code-reviewer 的報告以結構化格式呈現，重點突出 CRITICAL 和 HIGH
4. **建議行動**：根據報告建議後續步驟

## 委派規則

- 始終委派給 `code-reviewer` agent，不要自行審查
- 傳入的 prompt 應包含：審查範圍 + 工作目錄路徑
- code-reviewer 回傳後，摘要問題數量和嚴重程度分佈

## 後續行動

審查完成後，根據結果建議：
- 有 CRITICAL/HIGH → 建議立即修復
- 有安全問題 → 建議執行 `/sentinel:security` 深度安全掃描
- 全部 LOW/MEDIUM → 建議列入待辦

## 使用者要求

$ARGUMENTS
