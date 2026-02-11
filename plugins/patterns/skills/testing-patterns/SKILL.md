---
name: testing-patterns
description: >-
  測試模式 — unit/integration/e2e 測試策略、
  mocking、fixtures、測試金字塔、覆蓋率目標。
---

## Quick Reference

| 主題 | 建議 |
|------|------|
| **測試金字塔比例** | Unit 70% / Integration 20% / E2E 10% |
| **命名規範** | `should [expected behavior] when [condition]` |
| **覆蓋率目標** | 一般 80%，關鍵路徑 100%，UI 可 60-70% |
| **測試隔離** | 每個測試獨立運作，不依賴執行順序 |
| **Mock 策略** | 外部依賴 mock，業務邏輯不 mock |
| **測試結構** | Arrange（準備）→ Act（執行）→ Assert（驗證） |
| **執行速度** | Unit < 100ms，Integration < 1s，E2E < 30s |

## Patterns

### Pattern 1: 測試命名與結構

**何時使用**

所有測試案例，特別是團隊協作專案。

**❌ BAD**

```javascript
describe('UserService', () => {
  it('test1', () => {
    const user = new User({ age: 15 });
    expect(user.canVote()).toBe(false);
  });

  it('works', () => {
    const user = new User({ age: 18 });
    expect(user.canVote()).toBe(true);
  });
});
```

**✅ GOOD**

```javascript
describe('UserService', () => {
  describe('canVote', () => {
    it('should return false when user is under 18', () => {
      const user = new User({ age: 15 });
      expect(user.canVote()).toBe(false);
    });

    it('should return true when user is 18 or older', () => {
      const user = new User({ age: 18 });
      expect(user.canVote()).toBe(true);
    });
  });
});
```

**說明**

良好的測試命名即文件。使用 `describe` 建立階層（類別 → 方法），`it` 描述具體行為和條件。失敗時可立即定位問題，無需閱讀測試程式碼。

### Pattern 2: Arrange-Act-Assert (AAA)

**何時使用**

所有測試案例，保持結構一致性。

**❌ BAD**

```javascript
it('should calculate total price', () => {
  const cart = new ShoppingCart();
  cart.addItem({ price: 100, quantity: 2 });
  expect(cart.total()).toBe(200);
  cart.addItem({ price: 50, quantity: 1 });
  expect(cart.total()).toBe(250);
});
```

**✅ GOOD**

```javascript
it('should calculate total price when multiple items added', () => {
  // Arrange
  const cart = new ShoppingCart();
  cart.addItem({ price: 100, quantity: 2 });
  cart.addItem({ price: 50, quantity: 1 });

  // Act
  const total = cart.total();

  // Assert
  expect(total).toBe(250);
});
```

**說明**

AAA 模式讓測試邏輯清晰。Arrange 準備測試資料，Act 執行被測試的行為（只有一個），Assert 驗證結果。避免多次 Act-Assert 交錯，每個測試只驗證一個行為。

### Pattern 3: Test Data Builder

**何時使用**

測試需要複雜物件，且不同測試只需變更部分屬性。

**❌ BAD**

```javascript
it('should validate email format', () => {
  const user = {
    id: 1,
    name: 'Test User',
    email: 'invalid-email',
    age: 25,
    address: { street: '123 St', city: 'NYC' },
    preferences: { theme: 'dark' }
  };

  expect(validateUser(user)).toHaveError('email');
});

it('should require name', () => {
  const user = {
    id: 2,
    name: '',
    email: 'test@example.com',
    age: 25,
    address: { street: '123 St', city: 'NYC' },
    preferences: { theme: 'dark' }
  };

  expect(validateUser(user)).toHaveError('name');
});
```

**✅ GOOD**

```javascript
class UserBuilder {
  constructor() {
    this.user = {
      id: 1,
      name: 'Test User',
      email: 'test@example.com',
      age: 25,
      address: { street: '123 St', city: 'NYC' },
      preferences: { theme: 'dark' }
    };
  }

  withEmail(email) {
    this.user.email = email;
    return this;
  }

  withName(name) {
    this.user.name = name;
    return this;
  }

  build() {
    return this.user;
  }
}

it('should validate email format', () => {
  const user = new UserBuilder()
    .withEmail('invalid-email')
    .build();

  expect(validateUser(user)).toHaveError('email');
});

it('should require name', () => {
  const user = new UserBuilder()
    .withName('')
    .build();

  expect(validateUser(user)).toHaveError('name');
});
```

**說明**

Builder Pattern 減少重複程式碼，提升可讀性。只需設定測試關心的屬性，其他使用合理預設值。修改預設值時只需改一處。

### Pattern 4: Mock 策略

**何時使用**

測試涉及外部依賴（API、資料庫、檔案系統），但需要 mock 外部依賴而非業務邏輯。

**❌ BAD**

```javascript
// 過度 mocking 業務邏輯
it('should process order', () => {
  const orderService = {
    calculateTotal: jest.fn().mockReturnValue(100),
    applyDiscount: jest.fn().mockReturnValue(90),
    validateStock: jest.fn().mockReturnValue(true)
  };

  const result = processOrder(orderService);

  expect(result).toBe(90);
  // 測試什麼都沒驗證，只是驗證 mock 本身
});
```

**✅ GOOD**

```javascript
// 只 mock 外部依賴
it('should process order when stock is available', () => {
  // Arrange - mock 外部依賴
  const paymentGateway = {
    charge: jest.fn().mockResolvedValue({ success: true })
  };
  const inventoryAPI = {
    checkStock: jest.fn().mockResolvedValue(true)
  };

  const orderService = new OrderService(paymentGateway, inventoryAPI);
  const order = { items: [{ id: 1, price: 100, quantity: 1 }] };

  // Act - 真實執行業務邏輯
  const result = orderService.process(order);

  // Assert
  expect(result.total).toBe(100);
  expect(paymentGateway.charge).toHaveBeenCalledWith(100);
  expect(inventoryAPI.checkStock).toHaveBeenCalled();
});
```

**說明**

只 mock 你無法控制的外部依賴（第三方 API、資料庫、時間）。業務邏輯應真實執行，否則測試失去意義。過度 mocking 會讓測試變成「測試 mock 的回傳值」而非真實行為。

### Pattern 5: Test Isolation

**何時使用**

所有測試，特別是涉及共享狀態（資料庫、全域變數）的測試。

**❌ BAD**

```javascript
let user;

beforeAll(() => {
  user = { name: 'Test', balance: 100 };
});

it('should deduct balance', () => {
  deduct(user, 30);
  expect(user.balance).toBe(70);
});

it('should add balance', () => {
  add(user, 50);
  expect(user.balance).toBe(150); // ❌ 依賴前一個測試的狀態
});
```

**✅ GOOD**

```javascript
beforeEach(() => {
  // 每個測試都有乾淨的初始狀態
  user = { name: 'Test', balance: 100 };
});

afterEach(() => {
  // 清理副作用
  user = null;
});

it('should deduct balance', () => {
  deduct(user, 30);
  expect(user.balance).toBe(70);
});

it('should add balance', () => {
  add(user, 50);
  expect(user.balance).toBe(150); // ✅ 獨立運作
});
```

**說明**

每個測試必須獨立執行，不依賴其他測試的執行順序或結果。使用 `beforeEach` 確保每次都是乾淨狀態，`afterEach` 清理副作用。測試應該可以單獨執行、平行執行、任意順序執行。

### Pattern 6: 覆蓋率目標設定

**何時使用**

設定 CI/CD 門檻、程式碼審查標準。

**❌ BAD**

```javascript
// jest.config.js
module.exports = {
  coverageThreshold: {
    global: {
      statements: 100, // 過度追求 100% 會浪費時間
      branches: 100,
      functions: 100,
      lines: 100
    }
  }
};
```

**✅ GOOD**

```javascript
// jest.config.js
module.exports = {
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 75,
      functions: 80,
      lines: 80
    },
    // 關鍵路徑要求更高
    './src/core/payment/*.js': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    },
    // UI 元件可適度降低
    './src/components/**/*.tsx': {
      statements: 60,
      branches: 60,
      functions: 60,
      lines: 60
    }
  }
};
```

**說明**

不同模組需要不同覆蓋率標準。關鍵業務邏輯（支付、安全、資料完整性）要求 100%，一般業務邏輯 80%，UI 元件可降至 60-70%。追求 100% 全域覆蓋率會產生無意義的測試（如 getter/setter、簡單的 render）。

### Pattern 7: Page Object Model (E2E)

**何時使用**

E2E 測試，避免重複的 selector 和操作邏輯。

**❌ BAD**

```javascript
test('user can login', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#username', 'test@example.com');
  await page.fill('#password', 'password123');
  await page.click('button[type="submit"]');
  await expect(page.locator('.welcome-message')).toBeVisible();
});

test('user can logout', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#username', 'test@example.com');
  await page.fill('#password', 'password123');
  await page.click('button[type="submit"]');
  await page.click('#logout-button');
  await expect(page.locator('#username')).toBeVisible();
});
```

**✅ GOOD**

```javascript
class LoginPage {
  constructor(page) {
    this.page = page;
    this.usernameInput = '#username';
    this.passwordInput = '#password';
    this.submitButton = 'button[type="submit"]';
  }

  async goto() {
    await this.page.goto('/login');
  }

  async login(username, password) {
    await this.page.fill(this.usernameInput, username);
    await this.page.fill(this.passwordInput, password);
    await this.page.click(this.submitButton);
  }
}

class DashboardPage {
  constructor(page) {
    this.page = page;
    this.welcomeMessage = '.welcome-message';
    this.logoutButton = '#logout-button';
  }

  async logout() {
    await this.page.click(this.logoutButton);
  }
}

test('user can login', async ({ page }) => {
  const loginPage = new LoginPage(page);
  const dashboardPage = new DashboardPage(page);

  await loginPage.goto();
  await loginPage.login('test@example.com', 'password123');
  await expect(page.locator(dashboardPage.welcomeMessage)).toBeVisible();
});

test('user can logout', async ({ page }) => {
  const loginPage = new LoginPage(page);
  const dashboardPage = new DashboardPage(page);

  await loginPage.goto();
  await loginPage.login('test@example.com', 'password123');
  await dashboardPage.logout();
  await expect(page.locator(loginPage.usernameInput)).toBeVisible();
});
```

**說明**

Page Object 封裝頁面結構和操作，selector 變更時只需修改一處。測試程式碼更易讀，表達使用者行為而非技術細節。

## Checklist

- [ ] **測試金字塔平衡**：Unit 70% / Integration 20% / E2E 10%，避免過度依賴 E2E
- [ ] **命名清晰**：使用 `should [behavior] when [condition]` 格式，失敗時可快速定位
- [ ] **獨立性**：每個測試可單獨執行，不依賴其他測試的執行順序或狀態
- [ ] **AAA 結構**：Arrange-Act-Assert 分離清楚，每個測試只驗證一個行為
- [ ] **Mock 適度**：只 mock 外部依賴（API、DB），業務邏輯真實執行
- [ ] **快速執行**：Unit 測試 < 100ms，Integration < 1s，E2E < 30s
- [ ] **覆蓋率合理**：關鍵路徑 100%，一般業務 80%，UI 60-70%，不盲目追求 100%
- [ ] **資料隔離**：使用 Builder/Factory 建立測試資料，避免硬編碼重複
- [ ] **錯誤訊息**：Assert 失敗時能清楚說明期望值與實際值的差異
- [ ] **E2E 穩定性**：使用 Page Object、retry 機制、等待策略，避免 flaky tests

## 常見陷阱

### 1. 測試實作細節而非行為

```javascript
// ❌ 測試內部狀態
it('should set isLoading to true', () => {
  component.fetchData();
  expect(component.isLoading).toBe(true);
});

// ✅ 測試使用者可見的行為
it('should show loading spinner when fetching data', () => {
  component.fetchData();
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
});
```

測試應該關注「使用者看到什麼」而非「內部變數是什麼」。重構時不應破壞測試。

### 2. 過度使用 snapshot 測試

Snapshot 很方便但容易變成「無意識接受所有變更」。應該只在真正需要驗證完整輸出結構時使用（如 API response schema），UI 元件優先用語意化的 assertion。

### 3. 測試之間共享狀態

使用全域變數、class property、資料庫記錄而沒有在 `beforeEach`/`afterEach` 清理，導致測試順序影響結果，產生 flaky tests。

### 4. 忽略非同步操作

```javascript
// ❌ 沒有 await
it('should fetch user data', () => {
  fetchUser(1);
  expect(user).toBeDefined(); // user 還沒回來
});

// ✅ 正確處理 async
it('should fetch user data', async () => {
  const user = await fetchUser(1);
  expect(user).toBeDefined();
});
```

### 5. E2E 測試過度依賴固定資料

E2E 測試依賴「資料庫必須有 user ID=123」會導致環境差異失敗。應該在測試開始時建立所需資料，結束時清理，或使用動態查詢而非硬編碼 ID。
