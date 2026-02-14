# 通知系統實作任務

> 此為範例 tasks，展示 architect agent 的 OpenSpec 任務清單格式。
> developer agent 會逐一打勾追蹤進度。

## Phase 1：通知服務核心

- [ ] 建立 `Notification` model（`src/models/notification.ts`）
  - id, userId, type, title, body, read, createdAt
  - TTL index: 30 天自動清理
- [ ] 建立 `NotificationService`（`src/services/notification/service.ts`）
  - create(), findByUser(), markAsRead()
- [ ] 撰寫 NotificationService 單元測試
  - 建立通知、分頁查詢、標記已讀

## Phase 2：API 路由 + WebSocket 推播

- [ ] 建立通知 API 路由（`src/routes/notifications.ts`）
  - GET /api/notifications（分頁查詢）
  - PATCH /api/notifications/:id/read（標記已讀）
  - POST /api/notifications（內部使用，需 admin 權限）
- [ ] 建立 WebSocket NotificationChannel（`src/websocket/channels.ts`）
  - JWT 認證 handshake
  - 即時推播通知到目標使用者
  - 已讀狀態即時同步
- [ ] 撰寫 API 路由整合測試

## Phase 3：多管道整合 + 使用者偏好

- [ ] 建立 EmailAdapter（`src/services/notification/adapters/email.ts`）
  - SMTP 配置
  - 5 分鐘 digest 合併視窗
- [ ] 建立 WebhookAdapter（`src/services/notification/adapters/webhook.ts`）
  - HMAC-SHA256 簽名
  - 重試機制（1s, 4s, 16s）
- [ ] 擴展 User model 加入 notificationPreferences 欄位
  - migration script + rollback script
- [ ] 建立通知偏好 API（`PATCH /api/users/me/notification-preferences`）
- [ ] 撰寫 E2E 測試（完整通知流程）
