---
name: qa
description: 行為測試 — 觸發 qa agent 啟動應用、呼叫 API、驗證 CLI 輸出，確認真實行為符合預期。觸發詞：qa、行為測試、smoke test、API 驗證。
argument-hint: "[描述要驗證的行為，如：API 端點回應 / CLI 指令輸出 / 服務健康檢查]"
allowed-tools: Read, Grep, Glob, Task, AskUserQuestion
---

## 你的角色

你是 QA 行為測試的入口點。委派給 qa agent 執行真實操作驗證行為。

## 工作流程

1. **理解目標**：從 `$ARGUMENTS` 解讀要驗證的行為
2. **委派 qa**：使用 Task 工具委派，傳入驗證目標和預期行為
3. **呈現報告**：摘要 PASS/FAIL 結果和失敗詳情
4. **建議修復**：失敗項目建議修復方向

## 委派規則

- 始終委派給 `qa` agent
- 傳入的 prompt 應包含：驗證目標 + 預期行為 + 服務啟動方式
- qa agent 回傳後，摘要 PASS/FAIL 結果和失敗詳情

## 後續行動

- 全部 PASS → 建議進入下一階段
- 有 CRITICAL → 建議回退 DEV 修復
- 有 WARNING → 列出建議改進項，視嚴重程度決策

---

## 參考：輸出格式

qa agent 回傳的報告結構：

```
# QA 行為測試報告

## 環境
- **服務**：{啟動指令}
- **健康檢查**：✅ / ❌

## 測試結果
| # | 操作 | 預期 | 實際 | 結果 |
|:-:|------|------|------|:----:|
| 1 | GET /api/users | 200 + JSON | 200 + [...] | ✅ |

## 三維驗證摘要（OpenSpec Verify）
| 維度 | 結果 | 說明 |
|------|:----:|------|
| 完整性 | ✅/❌ | N/M 個 spec scenarios 已覆蓋 |
| 正確性 | ✅/❌ | WHEN/THEN 驗證結果 |
| 一致性 | ✅/❌ | design 決策反映程度 |

## 問題清單
### CRITICAL / WARNING / SUGGESTION
```

## 參考：常見驗證場景

| 場景 | 操作方式 | 驗證重點 |
|------|---------|---------|
| API CRUD | curl / WebFetch | status code + 回應結構 |
| CLI 輸出 | Bash 執行指令 | stdout 比對 + exit code |
| 健康檢查 | GET /health | 200 + 服務狀態 |
| 認證流程 | 登入 → token → 存取 | token 有效性 + 權限 |
| 錯誤路徑 | 不合法輸入 | 正確 error code + 訊息 |
| 資料一致性 | CRUD 後查詢 | 寫入後讀取符合預期 |

## 參考：與 E2E 分工

| QA（此 agent） | E2E |
|:-------------:|:---:|
| 單一 API/CLI 正確性 | 跨步驟資料一致性 |
| 回應格式、status code | 多使用者互動場景 |
| 錯誤處理驗證 | 狀態依賴鏈驗證 |
| 單一操作正確性 | 複合流程完整性 |

## 使用者要求

$ARGUMENTS
