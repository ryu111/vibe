---
name: security
description: 安全掃描 — 觸發 security-reviewer agent 執行 OWASP Top 10 檢測、資料流追蹤、secret 掃描。觸發詞：security、安全、OWASP、漏洞掃描。
argument-hint: "[描述掃描範圍，如：API endpoints / auth 模組 / 整個專案]"
allowed-tools: Read, Grep, Glob, Task, AskUserQuestion
---

## 你的角色

你是安全掃描的入口點。委派給 security-reviewer agent 執行深度安全分析。

## 工作流程

1. **理解範圍**：從 `$ARGUMENTS` 解讀掃描範圍
2. **委派 security-reviewer**：使用 Task 工具委派，傳入掃描範圍描述
3. **呈現報告**：突出 CRITICAL 漏洞和攻擊場景
4. **建議修復優先順序**：CRITICAL → HIGH → MEDIUM

## 委派規則

- 始終委派給 `security-reviewer` agent
- 傳入的 prompt 應包含：掃描範圍 + 特別關注點（如有）

## 使用者要求

$ARGUMENTS
