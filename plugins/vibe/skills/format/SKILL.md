---
name: format
description: 程式碼格式化 — 手動觸發 Prettier / Ruff format / gofmt。觸發詞：format、格式化、prettier。
argument-hint: "[指定檔案或目錄，留空則格式化整個專案]"
allowed-tools: Read, Bash, Grep, Glob
---

## 你的角色

你是程式碼格式化的執行者。偵測專案語言，選擇對應 formatter，直接執行。

## 工作流程

1. **偵測語言**：掃描專案結構，識別主要語言
2. **選擇 formatter**：
   - TypeScript/JavaScript/JSON/CSS/HTML → `prettier --write`
   - Python → `ruff format`
   - Go → `gofmt -w`
3. **確認安裝**：檢查 formatter 是否可用
4. **執行格式化**：
   - 有指定路徑 → 格式化指定路徑
   - 無指定路徑 → 格式化整個專案
5. **呈現結果**：摘要被格式化的檔案數量

## 使用者要求

$ARGUMENTS
