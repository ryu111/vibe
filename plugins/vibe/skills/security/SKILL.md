---
name: security
description: 安全掃描 — 觸發 security-reviewer agent 執行 OWASP Top 10 檢測、資料流追蹤、secret 掃描。觸發詞：security、安全、OWASP、漏洞掃描。
argument-hint: "[描述掃描範圍，如：API endpoints / auth 模組 / 整個專案]"
allowed-tools: Read, Grep, Glob, Task, AskUserQuestion
---

## 你的角色

你是安全掃描的入口點。委派給 security-reviewer agent 執行深度安全分析。

## 工作流程

1. **理解範圍**：從 `$ARGUMENTS` 解讀掃描範圍
2. **委派 security-reviewer**：使用 Task 工具委派，傳入掃描範圍描述
3. **呈現報告**：突出 CRITICAL 漏洞和攻擊場景
4. **建議修復優先順序**：CRITICAL → HIGH → MEDIUM

## 委派規則

- 始終委派給 `security-reviewer` agent
- 傳入的 prompt 應包含：掃描範圍 + 特別關注點（如有）
- agent 回傳後，突出 CRITICAL 漏洞，摘要攻擊場景

## 後續行動

- 有 CRITICAL → 建議立即修復，提供修復優先順序
- 有 HIGH → 建議排入下一個 sprint
- 全部 MEDIUM/LOW → 建議列入技術債清單
- 如需更深入 → 建議執行 `/vibe:review` 做程式碼品質交叉驗證

---

## 參考：OWASP Top 10 速查

| 編號 | 名稱 | 常見漏洞 |
|:----:|------|---------|
| A01 | 存取控制失效 | IDOR、路徑遍歷、權限提升 |
| A02 | 加密機制失效 | 明文傳輸、弱雜湊、密鑰管理不當 |
| A03 | 注入攻擊 | SQL/NoSQL/OS/LDAP 注入 |
| A04 | 不安全設計 | 缺少速率限制、商業邏輯漏洞 |
| A05 | 安全設定缺陷 | 預設憑證、錯誤頁面洩漏、CORS 過寬 |
| A06 | 危險或過時元件 | 已知漏洞依賴、未修補版本 |
| A07 | 身份認證失效 | 弱密碼策略、session 管理不當 |
| A08 | 完整性失效 | 不安全反序列化、CI/CD 完整性 |
| A09 | 日誌監控失效 | 缺少稽核日誌、敏感資料入 log |
| A10 | SSRF | 內部網路存取、雲端 metadata 洩漏 |

## 參考：輸出格式

security-reviewer agent 回傳的報告結構：

```
# 安全審查報告

## 摘要
- **攻擊面**：N 個入口點
- **漏洞數**：N（CRITICAL: N, HIGH: N, MEDIUM: N）
- **風險等級**：高/中/低

## 漏洞清單
### 🔴 CRITICAL: {漏洞標題}
- **OWASP**：A03 — 注入攻擊
- **位置**：`path/to/file.ts:42`
- **攻擊場景**：步驟描述
- **影響**：資料洩漏 / 權限提升
- **修復建議**：具體修改方案

## Secret 掃描
- [ ] 無硬編碼密鑰
- [ ] .env 不在版本控制
- [ ] 無敏感資料日誌輸出
```

## 參考：常見掃描目標

| 目標 | 檢查重點 |
|------|---------|
| API endpoints | 認證、授權、輸入驗證、速率限制 |
| Auth 模組 | JWT 過期、密碼雜湊、session 管理 |
| 檔案上傳 | 類型限制、大小限制、路徑遍歷 |
| 環境設定 | .env 隔離、secret 管理、CORS 政策 |
| 依賴套件 | npm audit / pip-audit 已知漏洞 |
| 資料庫查詢 | 參數化查詢、ORM 注入防護 |

## 使用者要求

$ARGUMENTS
