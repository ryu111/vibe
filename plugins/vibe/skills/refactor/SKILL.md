---
name: refactor
description: >-
  重構模式 — 安全重構原則、常見重構手法（Extract/Inline/Move/Rename）、
  影響範圍分析、向後相容策略、重構時機判斷。
  觸發詞：refactor、重構、重整、restructure。
---

## Quick Reference

| 主題 | 指引 |
|------|------|
| 核心原則 | 保持行為不變，先加測試再動手 |
| 步驟大小 | 每次只做一件事，頻繁 commit |
| 影響分析 | 依賴圖 + 呼叫鏈 + grep 引用 |
| 向後相容 | Adapter → Deprecation → 移除（三階段） |
| 重構時機 | 三次法則 / 變更前清理 / Code Review 回饋 |
| 不該重構 | deadline 壓力 / 無測試覆蓋 / 理解不足 |

## Patterns

### Pattern 1: Extract Function/Module

**何時使用**：函式超過 30 行，或一段程式碼需要解釋才能理解其意圖；模組超過 400 行或承擔多個職責。

**❌ BAD**：
```javascript
async function processCheckout(cart, userId) {
  // 計算總額
  let total = 0;
  for (const item of cart.items) {
    const price = item.price * item.quantity;
    const discount = item.quantity > 10 ? price * 0.1 : 0;
    total += price - discount;
  }
  // 驗證庫存
  for (const item of cart.items) {
    const stock = await db.inventory.findOne({ productId: item.id });
    if (!stock || stock.available < item.quantity) {
      throw new Error(`Product ${item.id} out of stock`);
    }
  }
  // 建立訂單
  const order = await db.orders.create({ userId, items: cart.items, total });
  await mailer.send({ to: userId, template: 'order-confirmed', data: { order } });
  return order;
}
```

**✅ GOOD**：
```javascript
async function processCheckout(cart, userId) {
  const total = calculateCartTotal(cart.items);
  await validateCartInventory(cart.items);
  const order = await createOrder({ userId, items: cart.items, total });
  await sendOrderConfirmation(userId, order);
  return order;
}

function calculateCartTotal(items) {
  return items.reduce((sum, item) => {
    const price = item.price * item.quantity;
    const discount = item.quantity > 10 ? price * 0.1 : 0;
    return sum + price - discount;
  }, 0);
}

async function validateCartInventory(items) {
  for (const item of items) {
    const stock = await db.inventory.findOne({ productId: item.id });
    if (!stock || stock.available < item.quantity) {
      throw new Error(`Product ${item.id} out of stock`);
    }
  }
}
```

**說明**：每個被抽取的函式只做一件事，主流程變成可讀的高階描述。日後變更折扣邏輯或庫存驗證時，修改範圍清晰不互相影響。

---

### Pattern 2: Inline Unnecessary Abstraction

**何時使用**：抽象層只有一行、與呼叫點相距不遠，或抽象後反而難以追蹤邏輯。過度抽象讓程式碼難以「跟進跳出」。

**❌ BAD**：
```javascript
// 只包一層 filter 的 helper
function getActiveUsers(users) {
  return users.filter(isUserActive);
}

function isUserActive(user) {
  return user.active === true;
}

// 呼叫端：三層間接
const active = getActiveUsers(users);
```

**✅ GOOD**：
```javascript
// 直接表達意圖，無需跳轉
const activeUsers = users.filter(u => u.active);
```

**說明**：若一個函式只在一處使用且一眼就能理解，inline 回去讓程式碼更直接。重構不只是拆，也要適時合。

---

### Pattern 3: Replace Conditional with Strategy

**何時使用**：if/switch 根據「類型」選擇不同行為，且每個分支都在成長；新增類型需要修改核心函式。

**❌ BAD**：
```javascript
function calculateShipping(order) {
  if (order.type === 'standard') {
    return order.weight * 1.5;
  } else if (order.type === 'express') {
    return order.weight * 3.0 + 10;
  } else if (order.type === 'overnight') {
    return order.weight * 5.0 + 25;
  } else if (order.type === 'international') {
    return order.weight * 8.0 + 50 + order.insuranceFee;
  }
  throw new Error(`Unknown shipping type: ${order.type}`);
}
```

**✅ GOOD**：
```javascript
const SHIPPING_STRATEGIES = {
  standard:      order => order.weight * 1.5,
  express:       order => order.weight * 3.0 + 10,
  overnight:     order => order.weight * 5.0 + 25,
  international: order => order.weight * 8.0 + 50 + order.insuranceFee,
};

function calculateShipping(order) {
  const strategy = SHIPPING_STRATEGIES[order.type];
  if (!strategy) throw new Error(`Unknown shipping type: ${order.type}`);
  return strategy(order);
}
```

**說明**：新增運送類型只需在 `SHIPPING_STRATEGIES` 加一行，核心函式不需修改（Open/Closed Principle）。每個策略都可獨立測試。

---

### Pattern 4: Introduce Parameter Object

**何時使用**：函式參數超過 3 個，或多個函式傳遞相同的一組參數。

**❌ BAD**：
```javascript
function createReport(startDate, endDate, userId, department, format, includeSubdepts) {
  // ...
}

function exportReport(startDate, endDate, userId, department, format, includeSubdepts, destination) {
  // ...
}

// 呼叫端難以辨識哪個是哪個
createReport('2024-01-01', '2024-12-31', 42, 'engineering', 'pdf', true);
```

**✅ GOOD**：
```javascript
/**
 * @typedef {Object} ReportOptions
 * @property {string} startDate
 * @property {string} endDate
 * @property {number} userId
 * @property {string} department
 * @property {'pdf'|'csv'|'xlsx'} format
 * @property {boolean} includeSubdepts
 */

function createReport(options) {
  const { startDate, endDate, userId, department, format, includeSubdepts } = options;
  // ...
}

function exportReport(options, destination) {
  // options 與 createReport 共用相同結構
}

// 呼叫端自我說明
createReport({
  startDate: '2024-01-01',
  endDate: '2024-12-31',
  userId: 42,
  department: 'engineering',
  format: 'pdf',
  includeSubdepts: true,
});
```

**說明**：Parameter Object 讓呼叫端自我說明；新增參數時不需修改所有呼叫點的位置排列；可用 TypeScript type/JSDoc 提供型別提示。

---

### Pattern 5: Move to Colocation

**何時使用**：相關檔案分散在不同目錄，修改一個功能需要在 3 個以上的目錄切換；或測試檔距離被測試的程式碼很遠。

**❌ BAD**：
```
src/
  components/UserCard.tsx
  styles/UserCard.css
  tests/UserCard.test.tsx
  hooks/useUserCard.ts
  types/UserCard.types.ts
```

**✅ GOOD**：
```
src/features/user-card/
  UserCard.tsx          # 元件
  UserCard.css          # 樣式（collocated）
  UserCard.test.tsx     # 測試（collocated）
  useUserCard.ts        # hook（collocated）
  types.ts              # 型別（collocated）
  index.ts              # 公開介面
```

**說明**：Colocation 原則：把一起變更的東西放在一起。刪除功能時只需刪一個目錄；新人上手時能立刻找到所有相關檔案。`index.ts` 控制公開介面，內部可自由重組。

---

### Pattern 6: Strangler Fig Pattern

**何時使用**：需要替換大型系統或模組，但無法一次全部重寫；需要保持服務持續運作的漸進式遷移。

**❌ BAD**：
```javascript
// 大爆炸重寫：一次性替換整個系統
// 風險：數週後上線，全部 bug 一次爆發
const newPaymentSystem = new CompletelyNewPaymentSystem();
// 停用舊系統，切換到全新系統
```

**✅ GOOD**：
```javascript
// 第一步：建立 Facade，路由流量
class PaymentFacade {
  constructor(legacySystem, newSystem, featureFlags) {
    this.legacy = legacySystem;
    this.new = newSystem;
    this.flags = featureFlags;
  }

  async processPayment(payment) {
    // 逐步遷移：先遷移「信用卡」類型
    if (this.flags.isEnabled('new-credit-card') && payment.type === 'credit-card') {
      return this.new.processPayment(payment);
    }
    return this.legacy.processPayment(payment);
  }
}

// 第二步：驗證新系統正確後，擴大 flag 覆蓋範圍
// 第三步：100% 流量到新系統後，移除 Facade 和舊系統
```

**說明**：Strangler Fig 讓你逐步「勒死」舊系統。任何時間點都可回滾，風險低；每個遷移批次都能獨立驗證；新舊系統並存期間業務不中斷。詳見 `references/safe-migration.md`。

---

### Pattern 7: Rename for Clarity

**何時使用**：名稱不表達意圖（`data`、`temp`、`helper`、`process`）；名稱誤導（函式名是 `getUser` 但實際上也會修改資料）；業務術語改變導致程式碼用語過時。

**❌ BAD**：
```javascript
const d = await getData(u.id);
function process(input) {
  const temp = transform(input);
  return helper(temp);
}
class Manager {
  handle(x) { /* ... */ }
}
```

**✅ GOOD**：
```javascript
const orderHistory = await fetchOrderHistory(customerId);

function normalizeShippingAddress(rawAddress) {
  const geocoded = geocodeAddress(rawAddress);
  return formatForDisplay(geocoded);
}

class PaymentProcessor {
  chargeCustomer(paymentDetails) { /* ... */ }
}
```

**說明**：好名稱是最好的文檔。重命名前用 `grep -r` 或 IDE 全域搜尋找出所有引用點，確認影響範圍。TypeScript 用 F2 重命名可自動處理引用；純 JS 則需手動或 codemod。

---

## 重構時機判斷

**三次法則（Rule of Three）**
- 第一次：直接寫
- 第二次：忍耐重複
- 第三次出現相同邏輯：提取為共用函式/模組

**變更前清理（Campsite Rule）**
修改某個模組前，先將它整理到易於修改的狀態再開始真正的改動。這讓 code review 容易區分「重構 commit」和「功能 commit」。

**Code Review 回饋觸發**
如果 reviewer 需要花超過 5 分鐘理解某段程式碼，那段程式碼就值得重構。

**不該重構的情況**
- deadline 在即，沒有時間做安全網（測試）
- 完全不理解現有程式碼的目的
- 沒有任何測試覆蓋作為安全網
- 即將被刪除的程式碼

---

## 影響範圍分析

重構前必須完成影響範圍評估，避免意外破壞呼叫端：

```bash
# 1. 找出所有引用點
grep -r "functionName\|ClassName\|moduleAlias" src/ --include="*.js" --include="*.ts"

# 2. 找出所有 import
grep -r "from.*module-name\|require.*module-name" src/

# 3. 確認是否有動態引用（eval、require(variable)）
grep -r "require(" src/ | grep -v "require('" | grep -v 'require("'
```

評估維度：
| 維度 | 問題 |
|------|------|
| 廣度 | 有多少個呼叫點？跨幾個模組？ |
| 深度 | 引用者是否還被其他模組引用？ |
| 動態性 | 是否有 dynamic import 或 reflection？ |
| 外部性 | 是否有公開 API（npm package、REST API）？ |
| 測試覆蓋 | 現有測試能否偵測到破壞？ |

---

## Checklist

- [ ] 是否有測試覆蓋作為安全網？沒有則先補測試。
- [ ] 已執行影響範圍分析（grep 引用、確認 import 路徑）？
- [ ] 重構 commit 與功能 commit 是否分開？（便於 review 和 revert）
- [ ] 每個步驟後都確認測試仍然通過？
- [ ] 是否評估向後相容需求？（公開 API、外部依賴方）
- [ ] 如需移除舊介面，是否走 Adapter → Deprecation → 移除三階段？
- [ ] 重命名是否用工具輔助（IDE rename 或 codemod）而非手動搜尋替換？
- [ ] 大型重構是否使用 Strangler Fig 漸進遷移而非大爆炸重寫？

---

## 常見陷阱

1. **先重構後加測試**：沒有測試的重構等於裸奔。先補測試（即使是整合測試），確認行為後再動手。

2. **一次做太多**：在同一個 commit 中同時重命名 + 移動 + 修改邏輯，讓 code review 無法判斷哪裡改了行為。拆成多個小 commit：「只重命名」、「只移動」、「只修改邏輯」。

3. **重構到「完美」**：完美是交付的敵人。重構到「夠清楚、夠可維護」就停手，剩下的留給下次。

4. **忽略外部契約**：公開的函式/類別/API 有外部使用者，不能直接重命名或改簽名。必須走 deprecation 流程（見 `references/safe-migration.md`）。

5. **重構與功能混搭**：在修改功能的過程中順便重構，讓 git diff 變得難以審查。保持「重構 PR」和「功能 PR」分開。

6. **假設重構不會改行為**：Inline 某個函式時可能漏掉 null check；Move 時可能改變 this binding。每個步驟後都要跑測試。

---

## 深度參考

需要向後相容策略、漸進式 API 遷移、Breaking Change 評估時，讀取 `references/safe-migration.md`，涵蓋：
- Adapter-Deprecation-Remove 三階段完整流程
- 漸進式 API 遷移策略
- Breaking Change 評估矩陣
- Deprecation 標記規範（JSDoc / TypeScript）
- 大規模跨檔案重命名策略
- 資料庫 Schema 遷移與重構
