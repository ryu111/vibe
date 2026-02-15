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

---

## 參考：支援語言工具表

| 語言 | Formatter | 設定檔偵測 |
|------|-----------|-----------|
| TypeScript/JavaScript | Prettier | `.prettierrc` / `prettier.config.*` |
| JSON/CSS/HTML/YAML | Prettier | 同上 |
| Python | Ruff format | `pyproject.toml [tool.ruff]` / `ruff.toml` |
| Go | gofmt | 內建，無需設定 |
| Rust | rustfmt | `rustfmt.toml` / `.rustfmt.toml` |
| SQL | sql-formatter | `.sql-formatter.json` |

## 參考：輸出格式

```
## 格式化結果

- **工具**：prettier
- **範圍**：src/（12 個檔案）
- **已格式化**：5 個檔案
- **未變更**：7 個檔案（已符合格式）
```

## 使用者要求

$ARGUMENTS
