# 通知系統架構設計

> 此為範例 design，展示 architect agent 的 OpenSpec 產出格式。

## 方案比較

| 面向 | A: 輪詢式 | B: WebSocket | C: SSE |
|------|----------|-------------|--------|
| 即時性 | 低（取決於輪詢間隔） | 高（雙向即時） | 高（單向即時） |
| 複雜度 | 低 | 中 | 低 |
| 瀏覽器支援 | 全部 | 全部 | 全部（IE 除外） |
| 伺服器負載 | 高（頻繁請求） | 低（持久連線） | 低（持久連線） |
| 雙向通訊 | 否 | 是 | 否 |

## 決策：方案 B — WebSocket

**理由**：需要雙向通訊（已讀回報、通知偏好即時生效），且專案已有 WebSocket 基礎設施。

## 架構概覽

```
Client (Browser)
  ↕ WebSocket
NotificationChannel
  ↕
NotificationService
  ├── InAppAdapter    → DB 儲存 + WS 推播
  ├── EmailAdapter    → SMTP 佇列
  └── WebhookAdapter  → HTTP POST + retry
```

## 關鍵決策

1. **通知儲存**：MongoDB collection `notifications`，TTL index 30 天自動清理
2. **佇列機制**：使用 in-memory queue（Bull），失敗重試 3 次 + exponential backoff
3. **認證**：WebSocket 連線使用 JWT token 驗證，與 REST API 共用 auth middleware
4. **批次處理**：email 通知合併（5 分鐘視窗內同類通知合併為 digest）
