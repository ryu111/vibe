---
name: memory-audit
description: 統一文檔審計工具 — 檢查 CLAUDE.md、plugin-specs.json、plugin.json 組件數/版號一致性、記憶檔行數、死引用、過時版號。觸發詞：audit、審計、記憶檢查、文檔同步。
argument-hint: "[quick]"
allowed-tools: Bash, Read, Grep, Glob
---

## 你的角色

你是文檔審計助手。協助使用者維護 Vibe 專案的 5 層文檔/記憶一致性，找出不同步的數字、行數超限的記憶檔、死引用路徑、過時版號引用。

## 審計架構

審計分兩層：

- **Layer 1（確定性）**：腳本自動檢查 C1~C6，產出 JSON 報告
- **Layer 2（語義）**：LLM 讀取記憶檔，執行 C7（重複偵測）和 C8（校正建議）

## 操作流程

### Step 1：執行 Layer 1 確定性審計

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tools/memory-audit.js"
```

腳本輸出 JSON 格式 AuditReport，包含以下 6 個檢查結果（status: pass/fail）：

| 檢查 | ID | 嚴重度 | 說明 |
|------|----|:------:|------|
| 組件數一致性 | C1 | ERROR | plugin-specs.json / plugin.json / CLAUDE.md 三角比對 |
| 版號一致性 | C2 | ERROR | plugin.json version vs CLAUDE.md 版號 |
| 專案記憶行數 | C3 | WARN | 專案 MEMORY.md 超過 200 行（ECC 截斷） |
| 死引用掃描 | C4 | WARN | 記憶檔中路徑引用的存在性 |
| 過時版號引用 | C5 | INFO | 記憶檔中舊 major 版號引用 |
| Agent 記憶行數 | C6 | WARN | 各 agent MEMORY.md 超過 200 行 |

### Step 2：格式化 Layer 1 結果

解讀 JSON 報告，以可讀格式呈現：

1. **摘要**：顯示 `errors / warnings / info` 計數
2. **逐項呈現**：
   - ✅ PASS — 顯示通過訊息
   - ⚠️ WARN — 顯示警告和細節
   - ❌ FAIL（ERROR）— 顯示錯誤和細節，建議立即修復
3. **優先行動清單**：依嚴重度排序，列出需要修復的項目

### Step 3：Layer 2 語義分析（quick 模式跳過）

如果參數**不**包含 "quick"，繼續執行：

#### C7：跨層重複偵測

讀取以下檔案：

```
Read: CLAUDE.md
Read: ~/.claude/projects/-Users-sbu-projects-vibe/memory/MEMORY.md
```

比對兩份文件中語義相同的段落（同一概念在兩處重複描述超過 80% 相似度）。

分析重點：
- CLAUDE.md 定義的架構規則是否也出現在 MEMORY.md 中
- ECC 平台約束是否在兩處重複
- 開發規範是否有冗餘描述

對每個發現的重複段落，在報告中標記 **INFO**，建議移除 MEMORY.md 中的重複內容（CLAUDE.md 是 SoT）。

#### C8：過時記憶校正建議

根據 Layer 1 C4（死引用）和 C5（過時版號）的發現，對每個問題提供具體校正建議：

- **死引用**：建議替換為正確的現有路徑，或移除引用
- **過時版號**：建議更新為當前版號，或調整描述方式（如改為「架構演進」章節的歷史記錄）

呈現格式（markdown，使用者可選擇採納）：

```markdown
## C8 校正建議

### 1. [來源記憶檔] — 死引用
**原文**：`plugins/vibe/scripts/lib/old-module.js`
**建議**：移除此引用，或替換為 `plugins/vibe/scripts/lib/flow/xxx.js`

### 2. [來源記憶檔] — 過時版號
**原文**：v1.0.43 相關說明
**建議**：將 v1.x 歷史記錄移至 MEMORY.md 的「架構演進」章節並加上日期標記
```

**重要**：C8 只提供建議，不自動修改任何檔案。使用者自行決定是否採納。

## Quick 模式

如果 `$ARGUMENTS` 包含 "quick" 或 "--quick"，執行到 Step 2 後停止，跳過 Layer 2（C7/C8）。

適合在不需要深度語義分析的情況下快速確認確定性指標。

## 規則

1. **不修改任何檔案**：審計工具只讀取和報告，不自動修改
2. **C1/C2 為最高優先**：ERROR 級別問題需在下次 commit 前修復
3. **C3/C6 為行數警告**：超限不影響功能，但重要知識可能被 ECC 截斷
4. **C4 死引用需確認**：可能是正則誤判，報告前先確認路徑確實不存在
5. **C5 過時版號為 INFO**：歷史記錄中提及舊版號是正常的，只需確認記憶是否過時

## 使用者需求

$ARGUMENTS
