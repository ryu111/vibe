# 通知服務 Delta Spec

> 此為範例 delta spec，展示 architect agent 的 OpenSpec 規格產出格式。
> Delta spec 記錄**變更**（ADDED/MODIFIED/REMOVED），非完整規格。

## ADDED: NotificationService

### Requirement: 通知建立與儲存

通知服務必須能建立、儲存、查詢通知記錄。

#### Scenario: 建立新通知
- **WHEN** 呼叫 `NotificationService.create({ userId, type, title, body })`
- **THEN** 在 `notifications` collection 建立一筆記錄
- **AND** 記錄包含 `id`, `userId`, `type`, `title`, `body`, `read: false`, `createdAt`
- **AND** 回傳建立的通知物件

#### Scenario: 查詢使用者通知（分頁）
- **WHEN** 呼叫 `GET /api/notifications?page=1&limit=20`
- **THEN** 回傳該使用者的通知列表（依 createdAt 降序）
- **AND** 包含分頁資訊 `{ data, total, page, limit }`
- **AND** 只回傳呼叫者自己的通知（不可查看他人通知）

#### Scenario: 標記已讀
- **WHEN** 呼叫 `PATCH /api/notifications/:id/read`
- **THEN** 將該通知的 `read` 設為 `true`
- **AND** 透過 WebSocket 推播已讀狀態更新

### Requirement: WebSocket 即時推播

#### Scenario: 即時通知推播
- **WHEN** 建立新通知
- **THEN** 透過 WebSocket 將通知推播到目標使用者的所有已連線裝置
- **AND** 未連線的裝置在下次連線時透過 API 取得未讀通知

#### Scenario: WebSocket 認證
- **WHEN** 客戶端嘗試建立 WebSocket 連線
- **THEN** 必須在連線 handshake 中提供有效的 JWT token
- **AND** token 無效時拒絕連線並回傳 `4001 Unauthorized`

### Requirement: 多管道通知

#### Scenario: Email 通知
- **WHEN** 使用者的通知偏好包含 email
- **AND** 通知類型符合 email 發送條件
- **THEN** 通知加入 email 佇列
- **AND** 5 分鐘內的同類通知合併為 digest

#### Scenario: Webhook 通知
- **WHEN** 使用者配置了 webhook URL
- **THEN** 以 `POST` 方式將通知 payload 發送到 webhook URL
- **AND** 包含 HMAC-SHA256 簽名在 `X-Webhook-Signature` header
- **AND** 失敗時重試 3 次（exponential backoff: 1s, 4s, 16s）

## MODIFIED: User Model

### Requirement: 通知偏好

#### Scenario: 預設通知偏好
- **WHEN** 建立新使用者
- **THEN** `notificationPreferences` 預設為 `{ inApp: true, email: false, webhook: null, quietHours: null }`

#### Scenario: 更新通知偏好
- **WHEN** 呼叫 `PATCH /api/users/me/notification-preferences`
- **THEN** 更新使用者的通知偏好
- **AND** 變更立即生效（不需重新登入）
