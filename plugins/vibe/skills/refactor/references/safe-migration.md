# 安全遷移深度參考

涵蓋向後相容策略、漸進式 API 遷移、Breaking Change 評估，以及大規模重構的具體實施方式。

---

## Adapter-Deprecation-Remove 三階段

公開 API（npm package、REST endpoint、跨模組介面）的重構必須走三階段，不能直接刪除或改簽名。

### 第一階段：Adapter（新舊並存）

保留舊介面，在舊介面內部呼叫新介面，兩者同時可用：

```javascript
// 新介面（最終形態）
export function fetchUserById(userId, options = {}) {
  const { includeDeleted = false, fields = ['id', 'name', 'email'] } = options;
  return db.users.findOne({ id: userId, includeDeleted, fields });
}

// 舊介面（Adapter）—— 內部委派給新介面
/** @deprecated 請改用 fetchUserById(userId, options) */
export function getUser(id) {
  return fetchUserById(id);
}
```

**驗收條件**：所有現有測試和呼叫端不需修改即可通過。

### 第二階段：Deprecation（標記 + 通知）

在舊介面加上 deprecation 標記，讓呼叫端有時間遷移：

```javascript
// JSDoc deprecation（IDE 顯示刪除線警告）
/**
 * @deprecated since v2.1.0 — 請改用 {@link fetchUserById}
 * 將於 v3.0.0 移除。
 */
export function getUser(id) {
  // 在執行期發出警告（方便找到所有實際執行的呼叫點）
  console.warn(
    '[DEPRECATED] getUser() 將於 v3.0.0 移除，請改用 fetchUserById()。' +
    ` 呼叫位置：${new Error().stack?.split('\n')[2]?.trim()}`
  );
  return fetchUserById(id);
}
```

```typescript
// TypeScript deprecation
/** @deprecated Use fetchUserById instead. Will be removed in v3.0.0 */
export function getUser(id: string): Promise<User> {
  return fetchUserById(id);
}
```

**驗收條件**：
- changelog 記錄 deprecation 和遷移指引
- 若為 npm package，在 README 標注遷移說明
- 設定移除版本的里程碑（通常是下一個 major 版本）

### 第三階段：移除（清理）

確認所有呼叫端都已遷移後，在約定的版本移除舊介面：

```bash
# 確認無殘留引用（移除前必做）
grep -r "getUser(" src/ tests/ --include="*.js" --include="*.ts"
grep -r "getUser(" . --include="*.md"  # 文件中的範例

# 確認 deprecation warning 沒有被觸發（執行完整測試套件）
node --test 2>&1 | grep -i deprecated
```

**Breaking Change 說明**：移除時必須在 CHANGELOG.md 的 BREAKING CHANGES 區塊記錄，並更新 major 版號。

---

## 漸進式 API 遷移

當 API 簽名需要重大改變時，無法用 Adapter 直接包裝，需要更細緻的遷移策略。

### 策略一：版本化端點（REST API）

```javascript
// 舊版保留，新版並行
router.post('/api/v1/orders', handleOrderV1);  // 繼續服務舊客戶端
router.post('/api/v2/orders', handleOrderV2);  // 新客戶端使用

// v1 內部可以轉換後呼叫 v2 邏輯
async function handleOrderV1(req, res) {
  // 將 v1 payload 轉換為 v2 格式
  const v2Payload = migrateV1OrderToV2(req.body);
  return handleOrderV2({ ...req, body: v2Payload }, res);
}
```

### 策略二：Feature Flag 漸進切換

```javascript
class UserService {
  async getProfile(userId) {
    if (featureFlags.isEnabled('new-profile-service', { userId })) {
      // 新實作（逐步增加覆蓋率：1% → 10% → 50% → 100%）
      return this.newProfileService.fetch(userId);
    }
    // 舊實作
    return this.legacyProfileService.fetch(userId);
  }
}
```

**監控指標**：遷移過程中同時監控新舊路徑的錯誤率、延遲、業務指標，確保新路徑行為正確。

### 策略三：Shadow Mode 驗證

在切換前，用新實作「影子執行」，比較結果但不影響使用者：

```javascript
async function processPayment(payment) {
  // 使用舊系統（實際生效）
  const legacyResult = await legacyPayment.process(payment);

  // Shadow 執行新系統（不影響使用者，但記錄差異）
  newPayment.process(payment)
    .then(newResult => {
      if (!isResultEquivalent(legacyResult, newResult)) {
        logger.warn('Shadow divergence', {
          paymentId: payment.id,
          legacy: legacyResult,
          new: newResult,
        });
      }
    })
    .catch(err => logger.error('Shadow execution failed', { err }));

  return legacyResult;
}
```

---

## Breaking Change 評估矩陣

遷移前評估每個變更的風險等級：

| 變更類型 | 風險 | 策略 |
|---------|------|------|
| 函式重命名（內部） | 低 | 直接 IDE rename + 修改引用 |
| 函式重命名（公開 API） | 高 | Adapter → Deprecation → 移除 |
| 新增必填參數 | 高 | 先設定預設值（向後相容），再漸進移除預設 |
| 移除參數 | 中 | Deprecation 警告，至少一個 minor 版本寬限 |
| 改變回傳值結構 | 高 | 版本化 API 或 transformation adapter |
| 移除 export | 高 | Deprecation 至少一個 major 版本 |
| 移動檔案位置 | 中 | re-export 橋接 + Deprecation |
| 改變副作用行為 | 高 | 必須有測試覆蓋，詳細說明 changelog |
| 效能最佳化（無語意改變） | 低 | 有基準測試對比即可 |

**風險等級定義**：
- 低：只影響當前模組，可安全直接修改
- 中：影響少數已知呼叫端，可一次性更新
- 高：影響外部使用者或大量內部呼叫端，需三階段流程

---

## Deprecation 標記規範

### JSDoc 標準格式

```javascript
/**
 * 取得使用者資料。
 *
 * @deprecated since v2.1.0
 * 請改用 {@link UserService#fetchById}，支援更豐富的查詢選項。
 * 此函式將於 v3.0.0 移除。
 *
 * @example
 * // 舊用法（deprecated）
 * const user = await getUser(id);
 *
 * // 新用法
 * const user = await userService.fetchById(id, { fields: ['id', 'name'] });
 *
 * @param {string} id 使用者 ID
 * @returns {Promise<User>}
 */
export async function getUser(id) {
  console.warn(`[DEPRECATED] getUser() 已廢棄，請改用 UserService.fetchById()`);
  return userService.fetchById(id);
}
```

### TypeScript @deprecated

```typescript
/** @deprecated Use {@link UserService.fetchById} instead. Removal: v3.0.0 */
export async function getUser(id: string): Promise<User> {
  return userService.fetchById(id);
}
```

TypeScript 4.0+ 支援 `@deprecated` JSDoc tag，IDE 會顯示刪除線和 hover 警告。

### Node.js util.deprecate

```javascript
const { deprecate } = require('node:util');

const getUser = deprecate(
  async function getUser(id) {
    return userService.fetchById(id);
  },
  'getUser() is deprecated. Use UserService.fetchById() instead.',
  'DEP0001'  // 唯一 deprecation code，方便 --no-deprecation / --throw-deprecation
);
```

---

## 大規模跨檔案重命名策略

重命名涉及 10 個以上檔案時，手動搜尋替換風險高，應使用工具輔助。

### 步驟一：影響評估

```bash
# 計算影響範圍
grep -r "OldName\|oldFunction\|old-module" src/ --include="*.{js,ts,tsx,jsx}" -l | wc -l

# 列出所有引用位置（確認沒有動態引用）
grep -rn "OldName" src/ --include="*.{js,ts,tsx,jsx}"
```

### 步驟二：自動化 Codemod

對於大規模重命名，使用 jscodeshift 或 TypeScript compiler API：

```javascript
// codemod: rename-old-to-new.js（jscodeshift transform）
module.exports = function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  // 重命名所有 identifier
  root
    .find(j.Identifier, { name: 'OldFunctionName' })
    .replaceWith(path => j.identifier('newFunctionName'));

  // 更新 import 路徑
  root
    .find(j.ImportDeclaration)
    .filter(path => path.node.source.value.includes('old-module'))
    .replaceWith(path => {
      path.node.source.value = path.node.source.value.replace('old-module', 'new-module');
      return path.node;
    });

  return root.toSource();
};

// 執行：
// npx jscodeshift -t rename-old-to-new.js src/ --extensions=js,ts,tsx
```

### 步驟三：橋接期保持向後相容

移動模組位置時，在舊路徑保留 re-export 橋接：

```javascript
// src/utils/old-location.js（橋接檔案）
/**
 * @deprecated 此模組已移至 src/features/user/helpers.js
 * 此橋接將於 v3.0.0 移除。
 */
export * from '../features/user/helpers.js';
```

### 步驟四：分批 commit

```bash
# Commit 1：新增新位置（不刪舊的）
git commit -m "refactor: add new location for user helpers"

# Commit 2：更新所有引用到新位置
git commit -m "refactor: migrate all imports to new user helpers location"

# Commit 3（下一個 major 版本）：移除橋接和舊位置
git commit -m "feat!: remove deprecated old-location bridge (BREAKING)"
```

---

## 資料庫 Schema 遷移與重構

資料庫 Schema 的重構比程式碼更難回滾，需要特別謹慎。

### 原則：只加不刪（先）

```sql
-- Phase 1：新增新欄位（舊欄位保留）
ALTER TABLE users ADD COLUMN full_name VARCHAR(255);

-- 同步新舊欄位（application 層）
UPDATE users SET full_name = first_name || ' ' || last_name;
```

```javascript
// Application 同時寫入新舊欄位（雙寫期）
async function updateUser(userId, data) {
  return db.users.update({
    where: { id: userId },
    data: {
      // 舊欄位（保持相容）
      first_name: data.firstName,
      last_name: data.lastName,
      // 新欄位（新邏輯使用）
      full_name: `${data.firstName} ${data.lastName}`,
    },
  });
}
```

### 欄位重命名流程

```
Phase 1：新增 new_column，雙寫新舊欄位，讀取仍用 old_column
Phase 2：讀取改用 new_column（確認資料一致後）
Phase 3：停止寫入 old_column
Phase 4：migration 刪除 old_column（下一個版本）
```

### 索引重構

```sql
-- 先建新索引（不阻塞讀取）
CREATE INDEX CONCURRENTLY idx_users_email_new ON users(email, created_at);

-- 確認新索引正常後，刪除舊索引
DROP INDEX CONCURRENTLY idx_users_email;

-- 如需重命名（PostgreSQL）
ALTER INDEX idx_users_email_new RENAME TO idx_users_email;
```

### 不可回滾的操作（避免在無降級計畫時執行）

- DROP TABLE / DROP COLUMN
- TRUNCATE
- 改變欄位型別（有隱式轉換風險）
- 移除 UNIQUE constraint（資料可能已有重複）

**緊急降級計畫**：任何 Schema migration 都應準備對應的 DOWN migration，並在 staging 環境驗證 UP + DOWN + UP 流程。
