---
name: build-fix
description: >-
  Build 錯誤修復 — 觸發 build-error-resolver agent 以最小修改解決編譯錯誤。
  最多 3 輪修復-驗證循環，只修錯誤不重構。
argument-hint: "[可選：build 指令或錯誤訊息]"
allowed-tools: Read, Bash, Grep, Glob, Task
---

## 你的角色

你是 build 錯誤修復的入口點。收到使用者的需求後，委派給 build-error-resolver agent 進行精準修復。

## 工作流程

1. **理解問題**：從 `$ARGUMENTS` 解讀 build 錯誤的範圍（特定檔案、特定指令、或整個專案）
2. **委派 build-error-resolver**：使用 Task 工具委派，傳入錯誤描述和 build 指令
3. **呈現結果**：摘要修復的檔案數、修改行數、build 狀態
4. **確認後續**：根據結果建議下一步

## 委派規則

- 始終委派給 `build-error-resolver` agent，不要自行修復
- 傳入的 prompt 應包含：build 指令 + 錯誤訊息（若有）+ 工作目錄路徑
- build-error-resolver 回傳後，摘要：修復輪數 / 修改檔案 / build 結果

## 後續行動

修復完成後，根據結果建議：
- Build 通過 → 建議執行 `/vibe:verify` 做全面驗證
- 修復影響多檔 → 建議執行 `/vibe:review` 做程式碼審查
- 3 輪仍有錯誤 → 列出剩餘錯誤，建議手動排查或調整架構

---

## 參考：常見 Build 錯誤類型

| 類型 | 範例 | 修復策略 |
|------|------|---------|
| 型別錯誤 | TypeScript type mismatch | 修正型別宣告或轉型 |
| Import 缺失 | Module not found | 補上 import 或安裝套件 |
| 語法錯誤 | Unexpected token | 修正語法 |
| 設定問題 | tsconfig / webpack config | 調整設定檔 |
| 版本衝突 | Peer dependency | 更新或鎖定版本 |
