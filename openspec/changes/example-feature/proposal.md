# 範例功能：使用者通知系統

> 此為範例 change，展示 OpenSpec 在 vibe pipeline 中的完整工作流。
> 實際使用時，planner agent 會自動產生此檔案。

## 為什麼（Why）

目前系統缺少即時通知機制，使用者無法得知背景任務（如 CI/CD）完成狀態。
需要一個統一的通知系統，支援多管道（in-app、email、webhook）。

## 變更內容（What Changes）

- 新增通知服務模組（`src/services/notification/`）
- 新增通知 API endpoints（`POST /api/notifications`、`GET /api/notifications`）
- 新增 WebSocket 即時推播
- **BREAKING**：`User` model 新增 `notificationPreferences` 欄位

## 能力定義（Capabilities）

- [ ] Capability 1：發送 in-app 通知並即時推播到前端
- [ ] Capability 2：支援 email 通知（可配置 SMTP）
- [ ] Capability 3：支援 webhook 通知（可配置 URL + secret）
- [ ] Capability 4：使用者可自訂通知偏好（管道、頻率、靜音時段）

## 影響分析（Impact）

- **受影響檔案**：`src/services/`、`src/routes/`、`src/models/user.ts`、`src/websocket/`
- **受影響模組**：core（新增服務）、API（新增路由）、WebSocket（新增通道）
- **registry.js 變更**：否
- **hook 變更**：無

## 階段分解

### Phase 1：通知服務核心
- **產出**：`NotificationService` 類別 + `Notification` model
- **修改檔案**：`src/services/notification/service.ts`、`src/models/notification.ts`
- **依賴**：無
- **風險**：資料庫 migration 可能影響既有資料
- **驗收條件**：單元測試通過，可建立/查詢通知記錄

### Phase 2：API 路由 + WebSocket 推播
- **產出**：REST API + WebSocket 通道
- **修改檔案**：`src/routes/notifications.ts`、`src/websocket/channels.ts`
- **依賴**：Phase 1
- **風險**：WebSocket 連線管理（記憶體洩漏）
- **驗收條件**：API 測試通過，WebSocket 可接收即時通知

### Phase 3：多管道整合 + 使用者偏好
- **產出**：email/webhook adapter + 偏好設定 UI
- **修改檔案**：`src/services/notification/adapters/`、`src/models/user.ts`
- **依賴**：Phase 1, Phase 2
- **風險**：外部服務（SMTP）不可用時的降級策略
- **驗收條件**：E2E 測試通過，使用者可設定偏好並收到對應管道通知

## 風險摘要

| 風險 | 嚴重度 | 緩解方案 |
|------|:------:|---------|
| DB migration 破壞既有資料 | 高 | 使用 nullable 欄位 + 預設值 |
| WebSocket 記憶體洩漏 | 中 | 連線池 + 心跳機制 + 自動斷開 |
| SMTP 不可用 | 低 | 佇列重試 + 降級到 in-app |

## 回滾計畫

1. DB migration 有對應的 rollback script
2. 新增的路由可透過 feature flag 關閉
3. WebSocket 通道獨立於現有功能，可直接移除
