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

## 後續行動

- 覆蓋率達標 → 建議執行 `/vibe:review` 做程式碼審查
- 覆蓋率不足 → 建議補充測試，特別關注未覆蓋的關鍵路徑
- 發現 bug → 建議修復後重跑測試

---

## 參考：覆蓋率目標

| 層級 | 目標 | 範例模組 |
|------|:----:|---------|
| 整體 | 80% | 所有模組平均 |
| 關鍵路徑 | 100% | auth、payment、data mutation |
| UI 元件 | 60-70% | 渲染 + 互動 |
| 工具函式 | 90% | 純函式、helpers |

## 參考：輸出格式

tester agent 回傳摘要包含：

```
# 測試撰寫報告

## 摘要
- **新增測試**：N 個
- **覆蓋率**：X% → Y%
- **邊界案例**：N 個

## 測試清單
| # | 測試描述 | 類型 | 邊界案例 |
|:-:|---------|:----:|:--------:|
| 1 | 應正確處理空輸入 | 邊界 | ✅ |
| 2 | 應拒絕非法格式 | 錯誤路徑 | ✅ |

## 測試命名慣例
describe('{模組}', () => {
  it('應該 {預期} 當 {條件}', () => { ... });
});
```

## 參考：框架指令對照

| 框架 | 執行指令 | 覆蓋率指令 |
|------|---------|-----------|
| Jest | `npx jest` | `npx jest --coverage` |
| Vitest | `npx vitest run` | `npx vitest run --coverage` |
| Mocha | `npx mocha` | `npx nyc mocha` |
| pytest | `pytest` | `pytest --cov` |
| go test | `go test ./...` | `go test -cover ./...` |
| Bun | `bun test` | `bun test --coverage` |

## 參考：邊界案例清單

| 類型 | 測試案例 |
|------|---------|
| 空值 | null / undefined / 空字串 / 空陣列 |
| 邊界數值 | 0、-1、MAX_INT、NaN、Infinity |
| 型別錯誤 | 傳入非預期型別 |
| 並發 | 同時多次呼叫 |
| 編碼 | Unicode、emoji、特殊字元 |

## 使用者要求

$ARGUMENTS
