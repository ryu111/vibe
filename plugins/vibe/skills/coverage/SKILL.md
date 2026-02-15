---
name: coverage
description: 覆蓋率分析 — 執行測試並產出覆蓋率報告，標示未覆蓋的關鍵路徑。目標：整體 80%，關鍵路徑 100%。觸發詞：coverage、覆蓋率、測試覆蓋。
argument-hint: "[指定模組或留空分析整個專案]"
allowed-tools: Read, Bash, Grep, Glob
---

## 你的角色

你是覆蓋率分析的執行者。執行測試收集覆蓋率資料，標示未覆蓋的關鍵路徑。

## 工作流程

1. **偵測測試框架**：
   - Jest → `jest --coverage`
   - Vitest → `vitest run --coverage`
   - pytest → `pytest --cov`
   - go → `go test -cover`
2. **執行覆蓋率收集**：執行對應指令
3. **分析結果**：整體覆蓋率、各模組覆蓋率、標示低於 80% 的模組、標示關鍵路徑是否 100%
4. **呈現報告**：依照輸出格式呈現

---

## 參考：輸出格式

```
## 覆蓋率報告

- **整體**：85% ✅ (目標 80%)
- **關鍵路徑**：
  - auth: 100% ✅
  - payment: 72% ❌

### 低覆蓋模組
| 模組 | 覆蓋率 | 未覆蓋行 |
|------|:------:|---------|
```

## 參考：框架覆蓋率指令

| 框架 | 指令 | 輸出格式 |
|------|------|---------|
| Jest | `npx jest --coverage` | text / lcov / html |
| Vitest | `npx vitest run --coverage` | text / istanbul |
| pytest | `pytest --cov --cov-report=term-missing` | terminal + 未覆蓋行 |
| go test | `go test -cover -coverprofile=cover.out ./...` | terminal + profile |
| Bun | `bun test --coverage` | text |
| nyc (Mocha) | `npx nyc mocha` | text / lcov |

## 參考：覆蓋率目標

| 層級 | 目標 | 說明 |
|------|:----:|------|
| 整體 | 80% | 所有模組加權平均 |
| 關鍵路徑 | 100% | auth、payment、data mutation |
| UI 元件 | 60-70% | 渲染邏輯 + 互動 |
| 工具函式 | 90% | 純函式、helpers |

## 使用者要求

$ARGUMENTS
