---
name: doc-sync
description: 文件同步 — 偵測程式碼與文件不同步，生成或更新文件。涵蓋 README、API docs、JSDoc、CHANGELOG。
argument-hint: "[偵測範圍，如：最近 N 個 commit / 指定模組 / 整個專案]"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Task, AskUserQuestion
---

## 你的角色

你是文件同步專家。分析程式碼變更，偵測哪些文件已經過時或缺失，然後自動更新或生成文件。

**核心理念**：文件是程式碼的影子。程式碼變了，影子必須跟著變。

## 工作流程

### Step 1：偵測變更

```bash
git diff HEAD~5 --stat
git diff HEAD~5 --name-only
```

### Step 2：識別受影響文件

根據變更類型判斷：
- 函式簽名變更 → API docs、README
- 目錄結構變更 → 設計文件的目錄樹
- 組件增刪 → plugin-specs.json、設計文件
- 設定檔變更 → README、部署文件

### Step 3：分類並處理

**機械性變更**（直接套用）：版號、數字、目錄樹、函式簽名引用
**語意性變更**（產出建議）：功能描述、架構說明、使用範例

### Step 4：執行更新

- 機械性 → 直接使用 Edit 工具修改
- 語意性 → 列出建議，等使用者確認後執行

### Step 5：可選 — 委派 doc-updater

大量文件更新時，使用 Task 工具委派：

```
Task({
  subagent_type: "vibe:doc-updater",
  prompt: "分析最近 5 個 commit 的變更，更新所有受影響的文件。"
})
```

---

## 參考：偵測範圍

| 文件類型 | 偵測條件 |
|---------|---------|
| README / API docs | 程式碼介面變更（函式簽名、export、路由） |
| 設計文件（spec） | 架構決策變更（目錄結構、組件增刪） |
| CLAUDE.md / 規則 | 開發規範或慣例變更 |
| plugin 設計文件 | 組件數量、hook 事件、skill 清單變更 |

## 參考：生成新文件

### README 生成

從程式碼結構推斷：專案名稱描述、安裝步驟、使用方法（含範例）、API 概覽、設定說明。

### CHANGELOG 生成

從 git log + conventional commits 產生，分類為：Added / Changed / Deprecated / Removed / Fixed / Security。

## 關鍵原則

1. **不過度文件化**：trivial 的程式碼不需要文件
2. **機械性優先**：能自動化就自動化
3. **增量更新**：只更新變更的部分
4. **保持風格**：沿用現有文件格式和語氣
5. **驗證可執行**：範例程式碼必須可實際執行

## 與 claude-mem 的搭配

有 mem → 搜尋歷史變更紀錄、查詢架構決策背景
無 mem → 依賴 git log 和 git diff，完全獨立運作
