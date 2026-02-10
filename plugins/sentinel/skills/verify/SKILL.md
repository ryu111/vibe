---
name: verify
description: 綜合驗證 — 一鍵執行 Build → Types → Lint → Tests → Git 狀態檢查。觸發詞：verify、驗證、全面檢查、CI check。
argument-hint: "[留空執行完整檢查，或指定：build / types / lint / test / git]"
allowed-tools: Read, Bash, Grep, Glob, AskUserQuestion
---

## 你的角色

你是綜合驗證的執行者。按順序執行所有品質檢查，任一失敗立即報告。

## 工作流程

1. **偵測可用的檢查**：讀取 package.json（或 pyproject.toml / Makefile），找出可用的 scripts
2. **按順序執行**：
   - **Build**：`npm run build` / `go build` / `python -m build`
   - **Types**：`tsc --noEmit` / `mypy`
   - **Lint**：`eslint .` / `ruff check .`
   - **Tests**：`npm test` / `pytest` / `go test ./...`
   - **Git**：`git status`（確認無遺漏的變更）
3. **任一失敗立即停止**：報告失敗的步驟和錯誤訊息
4. **全部通過**：摘要所有檢查結果

## 輸出格式

```
## 綜合驗證結果

| # | 檢查 | 結果 | 耗時 |
|:-:|------|:----:|:----:|
| 1 | Build | ✅ | 3.2s |
| 2 | Types | ✅ | 1.5s |
| 3 | Lint | ❌ | 0.8s |

### ❌ Lint 失敗
{錯誤輸出}
```

## 部分執行

使用者可以指定只執行某個檢查：
- `/sentinel:verify build` → 只跑 Build
- `/sentinel:verify lint test` → 只跑 Lint + Tests

## 使用者要求

$ARGUMENTS
