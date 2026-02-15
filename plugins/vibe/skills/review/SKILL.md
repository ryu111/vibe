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
- 有安全問題 → 建議執行 `/vibe:security` 深度安全掃描
- 全部 LOW/MEDIUM → 建議列入待辦
- 規格偏離 → 建議對照 OpenSpec specs 修正實作

---

## 參考：嚴重程度定義

| 等級 | 定義 | 範例 |
|:----:|------|------|
| 🔴 CRITICAL | 資料損失、安全漏洞或系統崩潰 | SQL 注入、未驗證管理者 API |
| 🟠 HIGH | 功能正確性或效能問題 | 邏輯錯誤、N+1 查詢、規格偏離 |
| 🟡 MEDIUM | 品質問題，增加維護成本 | 重複程式碼、模糊命名 |
| 🔵 LOW | 風格或慣例問題 | 命名不一致、冗餘 import |

## 參考：輸出格式

code-reviewer agent 回傳的報告結構：

```
# Code Review 報告

## 摘要
- **檔案數**：N
- **問題數**：N（CRITICAL: N, HIGH: N, MEDIUM: N, LOW: N）
- **整體評估**：一句話

## 問題清單
### 🔴 CRITICAL
#### [C-1] {問題標題}
- **檔案**：`path/to/file.ts:42`
- **問題**：描述
- **影響**：可能後果
- **建議**：修復方案

### 🟠 HIGH / 🟡 MEDIUM / 🔵 LOW
...

## 正面發現
- 值得肯定的好實踐
```

## 參考：審查維度

| 維度 | 檢查重點 |
|------|---------|
| 正確性 | 邏輯錯誤、邊界條件、錯誤處理 |
| 規格一致性 | WHEN/THEN 實作符合 specs、design.md 決策 |
| 安全性 | 注入風險、敏感資料洩漏、權限控制 |
| 效能 | N+1 查詢、不必要計算、記憶體洩漏 |
| 可維護性 | 命名清晰度、重複程式碼、耦合度 |

## 使用者要求

$ARGUMENTS
