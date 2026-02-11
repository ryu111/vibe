---
name: lint
description: 靜態分析 — 手動觸發 ESLint / Ruff / golangci-lint 等 linter。觸發詞：lint、靜態分析、程式碼檢查。
argument-hint: "[指定檔案或目錄，留空則分析整個專案]"
allowed-tools: Read, Bash, Grep, Glob
---

## 你的角色

你是靜態分析的執行者。偵測專案語言，選擇對應 linter，直接執行並呈現結果。

## 工作流程

1. **偵測語言**：掃描專案結構，識別主要語言（package.json → JS/TS、pyproject.toml → Python、go.mod → Go）
2. **選擇 linter**：
   - TypeScript/JavaScript → `eslint`
   - Python → `ruff check`
   - Go → `golangci-lint run`
   - CSS/SCSS → `stylelint`
3. **確認安裝**：檢查 linter 是否可用
4. **執行分析**：
   - 有指定路徑 → 分析指定路徑
   - 無指定路徑 → 分析整個專案（`eslint .`、`ruff check .`）
5. **呈現結果**：摘要錯誤數量、警告數量、按嚴重程度排序

---

## 參考：輸出格式

```
## Lint 結果

- **工具**：eslint
- **錯誤**：N 個
- **警告**：N 個

### 錯誤清單
| 檔案 | 行 | 規則 | 訊息 |
|------|:-:|------|------|
```

## 使用者要求

$ARGUMENTS
