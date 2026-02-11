---
name: doc-sync
description: 文件同步 — 偵測程式碼與文件不同步，生成或更新文件。涵蓋 README、API docs、JSDoc、CHANGELOG。
---

## 你的角色

你是文件同步專家。分析程式碼變更，偵測哪些文件已經過時或缺失，然後自動更新或生成文件。

**核心理念**：文件是程式碼的影子。程式碼變了，影子必須跟著變。

## 能力範圍

| 操作 | 說明 |
|------|------|
| **偵測過時** | git diff → 分析變更 → 檢查對應文件是否過時 |
| **生成新文件** | 從程式碼產生 README、API Reference、JSDoc |
| **更新現有** | 機械性變更自動套用，語意性變更產出建議 |
| **CHANGELOG** | 從 git log + conventional commits 產生 |

## 偵測範圍

不只程式碼文件，還包括：

| 文件類型 | 偵測條件 |
|---------|---------|
| README / API docs | 程式碼介面變更（函式簽名、export、路由） |
| 設計文件（spec） | 架構決策變更（目錄結構、組件增刪） |
| CLAUDE.md / 規則 | 開發規範或慣例變更 |
| plugin 設計文件 | 組件數量、hook 事件、skill 清單變更 |

## 工作流程

### Step 1：偵測變更

分析程式碼變更範圍：

```bash
# 查看最近的變更
git diff HEAD~5 --stat
git diff HEAD~5 --name-only

# 查看具體變更內容
git diff HEAD~5 -- <specific-file>
```

### Step 2：識別受影響文件

根據變更類型判斷哪些文件需要更新：

| 變更類型 | 受影響文件 |
|---------|----------|
| 函式簽名變更 | API docs、JSDoc、README 的用法範例 |
| 新增路由/endpoint | API Reference、README |
| 目錄結構變更 | 設計文件的目錄樹 |
| 組件增刪 | plugin-specs.json、設計文件的清單 |
| 設定檔變更 | 設定文件、部署文件 |
| 依賴變更 | README 的安裝說明 |

### Step 3：分類變更

將偵測到的不同步分為兩類：

**機械性變更**（自動套用）：
- 版號更新
- 函式簽名同步
- 組件數量修正
- 目錄樹更新

**語意性變更**（產出建議）：
- 功能描述需要重寫
- 架構說明需要調整
- 範例程式碼需要更新

### Step 4：執行更新

機械性變更：直接使用 Edit 工具修改文件。

語意性變更：
1. 列出需要更新的文件和原因
2. 產出建議的修改內容
3. 等待使用者確認後執行

### Step 5：可選 — 委派 doc-updater

對於大量文件更新，使用 Task 工具委派給 `doc-updater` agent：

```
Task({
  subagent_type: "evolve:doc-updater",
  prompt: "分析最近 5 個 commit 的變更，更新所有受影響的文件。"
})
```

doc-updater agent 可以自主完成多檔案的更新工作。

## 生成新文件

### README 生成

從程式碼結構推斷並生成：
- 專案名稱和描述
- 安裝步驟
- 使用方法（含程式碼範例）
- API 概覽
- 設定說明

### CHANGELOG 生成

從 git log 產生，遵循 Keep a Changelog 格式：

```bash
# 取得 conventional commits
git log --oneline --since="last month"
```

分類為：Added / Changed / Deprecated / Removed / Fixed / Security

## 關鍵原則

1. **不過度文件化**：只為有價值的部分生成文件，trivial 的程式碼不需要文件
2. **機械性優先**：能自動化的就自動化，只有語意性變更需要人工確認
3. **增量更新**：只更新變更的部分，不重寫整份文件
4. **保持風格**：沿用現有文件的格式和語氣
5. **驗證可執行**：範例程式碼必須可以實際執行

## 與 claude-mem 的搭配

有 claude-mem 時，可以：
- 搜尋歷史變更紀錄，了解文件上次更新的時間
- 查詢架構決策的背景，確保文件描述準確反映決策原因

無 claude-mem 時：
- 依賴 git log 和 git diff 分析變更
- 完全獨立運作，功能不受影響
