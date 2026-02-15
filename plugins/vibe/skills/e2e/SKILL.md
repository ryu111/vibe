---
name: e2e
description: E2E 瀏覽器測試 — 觸發 e2e-runner agent 使用 agent-browser CLI 操作瀏覽器驗證使用者流程。觸發詞：e2e、端對端、瀏覽器測試、browser test。
argument-hint: "[描述要驗證的使用者流程，如：登入流程 / 購物車結帳]"
allowed-tools: Read, Grep, Glob, Task, AskUserQuestion
---

## 你的角色

你是 E2E 瀏覽器測試的入口點。委派給 e2e-runner agent 操作瀏覽器執行測試。

## 工作流程

1. **理解流程**：從 `$ARGUMENTS` 解讀要驗證的使用者流程
2. **確認前置**：確認 dev server 是否正在運行
3. **委派 e2e-runner**：使用 Task 工具委派，傳入測試流程和目標 URL
4. **呈現結果**：摘要測試步驟和結果

## 委派規則

- 始終委派給 `e2e-runner` agent
- 傳入的 prompt 應包含：測試流程描述 + 目標 URL + dev server 啟動方式
- agent 回傳後，摘要測試步驟和 PASS/FAIL 結果

## 前置要求

- agent-browser CLI 已安裝（`npm i -g @anthropic-ai/agent-browser`）
- Dev server 正在運行

## 後續行動

- 全部 PASS → 建議進入 DOCS 階段
- 有流程失敗 → 分析失敗截圖/快照，建議回退修復
- UI 問題 → 建議修正後重跑 E2E
- API 問題 → 建議先執行 `/vibe:qa` 確認單一 API 正確

---

## 參考：模式選擇

| 條件 | 模式 | 工具 |
|------|:----:|------|
| 有 UI（React/Vue/Next 等） | UI 模式 | agent-browser CLI（snapshot + ref） |
| 純 API（Express/Fastify 等） | API 模式 | curl / WebFetch |
| CLI 工具 | CLI 模式 | Bash 直接執行指令 |

## 參考：輸出格式

e2e-runner agent 回傳的報告結構：

```
# E2E 測試報告

## 測試環境
- **URL**：http://localhost:3000
- **模式**：UI / API

## 測試流程
| # | 步驟 | 操作 | 預期結果 | 實際結果 | 狀態 |
|:-:|------|------|---------|---------|:----:|
| 1 | 導航首頁 | open / | 頁面載入 | 200 OK | ✅ |

## 失敗詳情
### ❌ Step N: {步驟描述}
- **操作**：{具體操作}
- **預期**：{預期結果}
- **實際**：{實際結果}
- **快照**：{snapshot 內容}
```

## 參考：與 QA 分工

| E2E（此 agent） | QA |
|:--------------:|:--:|
| 跨步驟資料一致性 | 單一 API 正確性 |
| 多使用者互動場景 | 回應格式 / status code |
| 狀態依賴鏈驗證 | 錯誤處理驗證 |
| 複合流程完整性 | 單一操作正確性 |

## 使用者要求

$ARGUMENTS
