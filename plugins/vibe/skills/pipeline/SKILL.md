---
name: pipeline
description: Pipeline 模板路由 — 列出 10 種工作流模板（full/standard/quick-dev/fix/test-first/ui-only/review-only/docs-only/security/none），說明適用場景和 [pipeline:xxx] 語法。
argument-hint: "[可選：pipeline 模板名稱，如 full]"
---

# Pipeline 模板路由

你是 Vibe Pipeline 的路由專家，協助使用者根據任務類型選擇最適合的工作流模板。

## Pipeline 模板目錄（10 種）

### 1. `full`（完整開發）
**階段**：PLAN → ARCH → DESIGN → DEV → REVIEW → TEST → QA → E2E → DOCS（9 階段）
**適用場景**：新功能（含 UI）、全棧功能、使用者介面開發
**強制執行**：是（enforced）
**說明**：包含視覺設計階段和完整品質守衛，適合需要 UI/UX 設計的功能。

### 2. `standard`（標準開發）
**階段**：PLAN → ARCH → DEV → REVIEW → TEST → DOCS（6 階段）
**適用場景**：新功能（無 UI）、大重構、API 開發、後端邏輯
**強制執行**：是（enforced）
**說明**：跳過 DESIGN/QA/E2E，專注於程式碼品質和測試覆蓋。

### 3. `quick-dev`（快速開發）
**階段**：DEV → REVIEW → TEST（3 階段）
**適用場景**：bugfix + 補測試、小改動、優化
**強制執行**：是（enforced）
**說明**：跳過規劃和架構，直接進入開發 + 審查 + 測試閉環。

### 4. `fix`（快速修復）
**階段**：DEV（1 階段）
**適用場景**：hotfix、config 調整、一行修改
**強制執行**：否（non-enforced）
**說明**：最小流程，適合緊急修復或配置調整。

### 5. `test-first`（TDD 開發）
**階段**：TEST → DEV → TEST（3 階段）
**適用場景**：TDD 工作流、測試驅動開發
**強制執行**：是（enforced）
**說明**：先寫測試 → 實作 → 再補充測試，確保測試覆蓋。

### 6. `ui-only`（UI 調整）
**階段**：DESIGN → DEV → QA（3 階段）
**適用場景**：純 UI/樣式調整、視覺優化
**強制執行**：是（enforced）
**說明**：跳過規劃和程式碼審查，專注於設計和行為驗證。

### 7. `review-only`（程式碼審查）
**階段**：REVIEW（1 階段）
**適用場景**：程式碼審查、第三方 PR 檢視
**強制執行**：否（non-enforced）
**說明**：僅執行程式碼審查，不涉及開發。

### 8. `docs-only`（文件更新）
**階段**：DOCS（1 階段）
**適用場景**：純文件更新、README 維護
**強制執行**：否（non-enforced）
**說明**：僅執行文件整理，不涉及程式碼變更。

### 9. `security`（安全修復）
**階段**：DEV → REVIEW → TEST（3 階段）
**適用場景**：安全修復、漏洞修補
**強制執行**：是（enforced）
**說明**：與 `quick-dev` 相同的階段，但 REVIEW 階段會包含安全審查。

### 10. `none`（無 Pipeline）
**階段**：無（0 階段）
**適用場景**：問答、研究、trivial 操作
**強制執行**：否（non-enforced）
**說明**：不觸發 Pipeline，適合純探索性任務。

## 顯式覆寫語法

使用者可以在 prompt 中使用 `[pipeline:xxx]` 語法來顯式指定 pipeline 模板，例如：

```
實作登入功能 [pipeline:full]
修復資料庫連線錯誤 [pipeline:quick-dev]
更新 README 安裝步驟 [pipeline:docs-only]
```

**合法的 pipeline ID**：
- `full` / `standard` / `quick-dev` / `fix` / `test-first` / `ui-only` / `review-only` / `docs-only` / `security` / `none`

**大小寫不敏感**：`[pipeline:Full]` 和 `[pipeline:FULL]` 都會解析為 `full`。

## 語意匹配建議

當使用者描述任務時，根據以下關鍵詞提供建議：

| 關鍵詞 | 建議 Pipeline | 理由 |
|--------|--------------|------|
| 新功能、UI、前端、視覺 | `full` | 需要設計階段 |
| API、後端、邏輯、重構 | `standard` | 不需要 UI 設計 |
| bug、修復、優化 | `quick-dev` | 跳過規劃直接修復 |
| 緊急、hotfix、config | `fix` | 最小流程 |
| TDD、測試驅動 | `test-first` | TDD 工作流 |
| 樣式、CSS、顏色 | `ui-only` | 純 UI 調整 |
| 審查、PR、檢視 | `review-only` | 僅審查 |
| 文件、README、註解 | `docs-only` | 僅文件 |
| 安全、漏洞、CVE | `security` | 安全審查 |
| 問答、研究、試試看 | `none` | 不觸發 Pipeline |

## 升級路徑

Pipeline 可以根據任務複雜度自動升級：

```
fix → quick-dev → standard → full
```

**升級觸發條件**：
- 發現需要設計變更 → 升級到 `full`
- 發現需要架構調整 → 升級到 `standard`
- 發現需要測試覆蓋 → 升級到 `quick-dev`

## 使用範例

### 範例 1：自動選擇
```
使用者：實作使用者登入功能，含 UI
分類結果：full（包含 DESIGN 階段）
```

### 範例 2：顯式覆寫
```
使用者：修復資料庫連線池洩漏 [pipeline:security]
分類結果：security（強制安全審查）
```

### 範例 3：升級路徑
```
使用者：修改按鈕顏色
初始分類：fix
發現：需要設計系統一致性 → 升級到 ui-only
```

## 決策原則

1. **預設保守**：不確定時選擇較完整的 pipeline（`standard` > `quick-dev` > `fix`）
2. **尊重顯式指令**：`[pipeline:xxx]` 語法優先於自動分類
3. **允許降級**：使用者可以用 `/cancel` 退出 Pipeline 改為 Manual 模式
4. **透明溝通**：在分類結果中說明選擇理由和階段安排

## 常見問題

**Q: `quick-dev` 和 `security` 的階段相同，差異在哪？**
A: `security` 的 REVIEW 階段會包含安全審查（security-reviewer agent），而 `quick-dev` 只做程式碼品質審查。

**Q: 為什麼 `test-first` 有兩個 TEST 階段？**
A: 這是 TDD 工作流的特殊設計 — 先寫測試（第一個 TEST）→ 實作（DEV）→ 補充測試（第二個 TEST）。

**Q: 如何跳過 Pipeline？**
A: 使用 `[pipeline:none]` 或 `/cancel` 指令退出 Pipeline 模式。

## Main Agent 路由器模式

Pipeline 架構允許 Main Agent 使用較輕量的模型（如 Sonnet）作為路由器：

**推薦配置**：
```bash
# 直接用 --model 參數
claude --model sonnet --plugin-dir ~/projects/vibe/plugins/vibe

# 或建立 alias
alias vc-sonnet='claude --model sonnet --plugin-dir ~/projects/vibe/plugins/vibe --plugin-dir ~/projects/vibe/plugins/forge'
```

**安全保障**：
- **pipeline-guard** 硬阻擋 Main Agent 直接寫碼（exit 2）
- **品質 sub-agents**（code-reviewer/tester）使用各自的指定模型，不受 Main Agent 模型影響
- **三層分類器** Layer 3 使用獨立模型（預設 Sonnet），與 Main Agent 模型無關

**成本效益**：
- Sonnet 速度更快、成本更低
- Main Agent 只負責路由和委派，不需要 Opus 的深度推理
- 所有實際工作由特化 sub-agents 完成

## Layer 3 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `VIBE_CLASSIFIER_MODEL` | `claude-sonnet-4-20250514` | Layer 3 LLM 分類模型 |
| `VIBE_CLASSIFIER_THRESHOLD` | `0.7` | Layer 2→3 降級閾值（設 `0` 完全停用 Layer 3） |

**閾值行為**：
- `0` — Layer 3 永不觸發（所有分類由 regex 決定）
- `0.7`（預設）— 只有低信心度分類（如弱探索詞）觸發 LLM
- `1.0` — 幾乎所有分類都觸發 LLM（除了顯式 `[pipeline:xxx]`）

**Session 快取**：同一 session 內 Layer 3 結果會快取到 pipeline state，避免重複 API 呼叫。Pipeline 完成後自動清除。

## 參數說明

- 如果提供參數（如 `/vibe:pipeline full`），則顯示該 pipeline 的詳細資訊
- 如果沒有參數，則顯示完整的 10 種模板目錄
