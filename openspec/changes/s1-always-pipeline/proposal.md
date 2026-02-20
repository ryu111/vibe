# S1: Always-Pipeline 架構

## 問題

Pipeline v4（v2.1.9）使用三層分類器（Layer 1 顯式 / Layer 1.5 Regex / Layer 2 Main Agent 被動自分類），
存在 regex 誤判、Main Agent 傾向直接動手、選錯 pipeline 導致死鎖、回饋循環複雜等問題。

## 目標

簡化為三層：
- Layer 1: `[pipeline:xxx]` 顯式指定（保留不變）
- Layer 2: Main Agent (Opus) 主動選擇（強化 systemMessage + pipeline 選擇表）
- Layer 3: AskUserQuestion（不確定時問使用者）

## 影響範圍

- classifier.js（~257 行 -> ~60 行）
- pipeline-controller.js classify() 函式（~220 行 -> ~140 行）
- guard-rules.js（AskUserQuestion 白名單）
- 測試檔案重寫
