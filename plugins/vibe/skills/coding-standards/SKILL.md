---
name: coding-standards
description: >-
  通用編碼標準 — 命名規範、檔案組織、錯誤處理、不可變性原則。
  適用於所有語言和框架。
---

## Quick Reference

| 元素 | 規範 | 範例 |
|------|------|------|
| 變數/函式 | camelCase | `getUserById`, `isActive` |
| 類別/型別 | PascalCase | `UserService`, `ApiResponse` |
| 常數 | UPPER_SNAKE | `MAX_RETRY_COUNT`, `API_BASE_URL` |
| 檔案 | kebab-case | `user-service.ts`, `api-handler.py` |
| 目錄 | kebab-case | `user-management/`, `api-routes/` |
| Boolean | is/has/can/should 前綴 | `isActive`, `hasPermission`, `canDelete` |
| 事件處理 | handle/on 前綴 | `handleClick`, `onSubmit` |
| 工廠函式 | create 前綴 | `createUser`, `createConnection` |

| 檔案長度 | 建議 |
|----------|------|
| 理想 | 200-400 行 |
| 上限 | 800 行 |
| 超過上限 | 拆分成更小的模組 |

## Patterns

### Pattern 1: Early Return

**何時使用**：函式有多層巢狀條件判斷時。

**❌ BAD**：
```javascript
function processOrder(order) {
  if (order) {
    if (order.items.length > 0) {
      if (order.status === 'pending') {
        // 真正的邏輯在三層巢狀裡
        return calculateTotal(order);
      } else {
        return null;
      }
    } else {
      return null;
    }
  } else {
    return null;
  }
}
```

**✅ GOOD**：
```javascript
function processOrder(order) {
  if (!order) return null;
  if (order.items.length === 0) return null;
  if (order.status !== 'pending') return null;

  return calculateTotal(order);
}
```

**說明**：Guard clauses 消除巢狀、讓主邏輯一目了然。每個 return 都是一個明確的退出條件。

---

### Pattern 2: 不可變性

**何時使用**：操作物件或陣列時，避免修改原始資料。

**❌ BAD**：
```javascript
function addItem(cart, item) {
  cart.items.push(item);  // 修改原物件
  cart.total += item.price;
  return cart;
}
```

**✅ GOOD**：
```javascript
function addItem(cart, item) {
  return {
    ...cart,
    items: [...cart.items, item],
    total: cart.total + item.price,
  };
}
```

**說明**：不可變更新避免了副作用、讓資料流可追蹤、是 React/Redux 等框架的基礎要求。

---

### Pattern 3: 具型錯誤處理

**何時使用**：catch 區塊需要區分不同類型的錯誤。

**❌ BAD**：
```javascript
try {
  const user = await fetchUser(id);
  await sendEmail(user.email);
} catch (e) {
  console.log(e);  // 吞掉錯誤、無法區分來源
}
```

**✅ GOOD**：
```javascript
try {
  const user = await fetchUser(id);
  await sendEmail(user.email);
} catch (error) {
  if (error instanceof NotFoundError) {
    return { status: 404, message: `User ${id} not found` };
  }
  if (error instanceof EmailServiceError) {
    logger.warn('Email delivery failed', { userId: id, error });
    return { status: 200, message: 'User found, email pending' };
  }
  logger.error('Unexpected error', { error, context: { userId: id } });
  throw error;  // 未知錯誤往上拋
}
```

**說明**：區分錯誤類型 → 不同的回應策略。未知錯誤永遠往上拋，不要吞掉。

---

### Pattern 4: 函式單一職責

**何時使用**：函式同時做多件事、難以命名或測試時。

**❌ BAD**：
```javascript
async function handleRegistration(data) {
  // 驗證
  if (!data.email || !data.password) throw new Error('Missing fields');
  if (data.password.length < 8) throw new Error('Password too short');
  // 建立使用者
  const hash = await bcrypt.hash(data.password, 10);
  const user = await db.users.create({ email: data.email, password: hash });
  // 發送歡迎信
  await mailer.send({ to: data.email, template: 'welcome', data: { name: user.name } });
  // 記錄分析
  await analytics.track('user_registered', { userId: user.id });
  return user;
}
```

**✅ GOOD**：
```javascript
async function handleRegistration(data) {
  validateRegistrationData(data);
  const user = await createUser(data);
  await sendWelcomeEmail(user);
  await trackRegistration(user);
  return user;
}
```

**說明**：每個函式做一件事。主函式變成高階流程描述，每一步都可以獨立測試、獨立修改。

---

### Pattern 5: 避免魔術值

**何時使用**：程式碼中出現硬編碼的數字或字串。

**❌ BAD**：
```javascript
if (retries > 3) throw new Error('Failed');
if (user.role === 'admin') { ... }
setTimeout(callback, 30000);
if (file.size > 5242880) throw new Error('Too large');
```

**✅ GOOD**：
```javascript
const MAX_RETRIES = 3;
const ROLES = { ADMIN: 'admin', USER: 'user' } as const;
const TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

if (retries > MAX_RETRIES) throw new Error('Failed');
if (user.role === ROLES.ADMIN) { ... }
setTimeout(callback, TIMEOUT_MS);
if (file.size > MAX_FILE_SIZE) throw new Error('Too large');
```

**說明**：常數有名字 → 意圖清晰、修改集中、搜尋方便。數字分隔符（`_`）提升可讀性。

---

### Pattern 6: 避免深層巢狀物件存取

**何時使用**：多層 `?.` 鏈或反覆存取深層屬性。

**❌ BAD**：
```javascript
const street = user?.address?.shipping?.street;
const city = user?.address?.shipping?.city;
const zip = user?.address?.shipping?.zip;
const country = user?.address?.shipping?.country;
```

**✅ GOOD**：
```javascript
const shippingAddress = user?.address?.shipping;
if (!shippingAddress) throw new Error('Missing shipping address');

const { street, city, zip, country } = shippingAddress;
```

**說明**：解構一次，後續存取都是平坦的。同時也明確處理了 null/undefined 的情況。

## Checklist

- [ ] 命名是否遵循語言慣例（camelCase/snake_case/PascalCase）？
- [ ] 函式長度是否在 30 行以內？超過則考慮拆分。
- [ ] 是否有魔術數字或魔術字串？抽取為具名常數。
- [ ] 是否有超過 2 層的巢狀？使用 Early Return 消除。
- [ ] 錯誤處理是否區分不同類型？未知錯誤是否往上拋？
- [ ] 是否修改了傳入的參數？改用不可變更新。
- [ ] 函式名稱能否準確描述它做的事？如果需要 "and" 則應拆分。

## 常見陷阱

1. **過度抽象**：三行重複的程式碼不需要抽成 helper。等到出現第三次重複再抽。
2. **命名不一致**：同一概念在不同檔案用不同名稱（`user`/`account`/`member`），統一術語。
3. **吞掉錯誤**：`catch (e) { return null }` 會隱藏 bug，至少要 log。
4. **Index 檔案膨脹**：`index.ts` 只做 re-export，不放邏輯。
5. **注釋取代可讀性**：與其寫 `// 計算折扣後的價格`，不如命名為 `calculateDiscountedPrice()`。

---

## 深度參考

需要各語言具體慣例時，讀取 `references/language-conventions.md`，涵蓋：
- TypeScript / JavaScript 命名、Import 排序、目錄結構
- Python 命名、Import 排序（isort）、目錄結構
- Go 命名、Import 排序、目錄結構
- Rust 命名慣例
- 通用原則（註解慣例、TODO 標籤、Git Commit Message 格式）
