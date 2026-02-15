# 進階測試模式

> 本文件涵蓋 SKILL.md 未深入的進階測試技術和框架特定模式。

## Property-Based Testing（屬性測試）

用隨機生成的資料驗證程式的不變量，而非寫死特定案例。

### JavaScript（fast-check）

```typescript
import fc from 'fast-check';

// 驗證排序函式的不變量
test('排序後陣列有序', () => {
  fc.assert(
    fc.property(fc.array(fc.integer()), (arr) => {
      const sorted = mySort(arr);
      // 不變量 1：長度不變
      expect(sorted.length).toBe(arr.length);
      // 不變量 2：遞增排列
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]).toBeGreaterThanOrEqual(sorted[i - 1]);
      }
      // 不變量 3：元素相同（只是重新排列）
      expect(sorted.sort()).toEqual(arr.sort());
    })
  );
});

// 驗證序列化/反序列化的往返性
test('JSON 往返不變', () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    })
  );
});
```

### Python（hypothesis）

```python
from hypothesis import given, strategies as st

@given(st.lists(st.integers()))
def test_sort_idempotent(xs):
    """排序兩次和排序一次的結果相同"""
    assert sorted(sorted(xs)) == sorted(xs)

@given(st.dictionaries(st.text(), st.integers()))
def test_dict_roundtrip(d):
    """dict → JSON → dict 往返不變"""
    import json
    assert json.loads(json.dumps(d)) == d
```

## Snapshot Testing（快照測試）

### 元件快照

```typescript
// Jest
test('UserCard 渲染正確', () => {
  const { container } = render(
    <UserCard name="Alice" role="admin" />
  );
  expect(container).toMatchSnapshot();
});

// 內聯快照（更易讀）
test('格式化日期', () => {
  expect(formatDate('2024-01-15')).toMatchInlineSnapshot(
    `"2024 年 1 月 15 日"`
  );
});
```

### 何時用/不用快照

| ✅ 適合 | ❌ 不適合 |
|---------|----------|
| UI 元件渲染 | 頻繁變動的輸出 |
| 序列化格式 | 含時間戳/隨機值的輸出 |
| 錯誤訊息 | 大型資料結構（難以 review） |
| API 回應結構 | 外部依賴的回應 |

## Contract Testing（契約測試）

驗證服務間的 API 契約，避免整合問題。

### 消費者驅動契約（Pact）

```typescript
// 消費者端（前端）
const provider = new Pact({
  consumer: 'WebApp',
  provider: 'UserService',
});

describe('User API 契約', () => {
  it('取得使用者', async () => {
    // 定義預期的互動
    await provider.addInteraction({
      state: '使用者 1 存在',
      uponReceiving: '取得使用者 1 的請求',
      withRequest: {
        method: 'GET',
        path: '/api/users/1',
      },
      willRespondWith: {
        status: 200,
        body: {
          id: like(1),
          name: like('Alice'),
          email: like('alice@example.com'),
        },
      },
    });

    // 使用 mock 伺服器測試
    const user = await fetchUser(1);
    expect(user.name).toBeDefined();
  });
});
```

## Mocking 進階模式

### 按框架的 Mock 策略

#### Jest

```typescript
// 模組 mock
jest.mock('./db', () => ({
  query: jest.fn().mockResolvedValue([{ id: 1, name: 'Alice' }]),
}));

// Spy（不改變行為，只追蹤呼叫）
const spy = jest.spyOn(console, 'error').mockImplementation();
expect(spy).toHaveBeenCalledWith('找不到使用者');
spy.mockRestore();

// 時間 mock
jest.useFakeTimers();
jest.setSystemTime(new Date('2024-01-15'));
// ...測試
jest.useRealTimers();
```

#### Vitest

```typescript
import { vi } from 'vitest';

// 模組 mock
vi.mock('./db', () => ({
  query: vi.fn().mockResolvedValue([]),
}));

// 計時器
vi.useFakeTimers();
vi.advanceTimersByTime(5000);
vi.useRealTimers();
```

#### pytest

```python
from unittest.mock import patch, MagicMock

# 裝飾器方式
@patch('myapp.db.query')
def test_get_users(mock_query):
    mock_query.return_value = [{'id': 1, 'name': 'Alice'}]
    result = get_users()
    assert len(result) == 1

# Context manager 方式
def test_send_email():
    with patch('myapp.email.send') as mock_send:
        mock_send.return_value = True
        notify_user(1)
        mock_send.assert_called_once()
```

## 測試資料管理

### Factory Pattern

```typescript
// 使用 factory 建立測試資料
function createUser(overrides = {}) {
  return {
    id: faker.string.uuid(),
    name: faker.person.fullName(),
    email: faker.internet.email(),
    role: 'user',
    createdAt: new Date(),
    ...overrides,
  };
}

// 使用
const admin = createUser({ role: 'admin' });
const users = Array.from({ length: 10 }, () => createUser());
```

### Builder Pattern

```typescript
class UserBuilder {
  private data: Partial<User> = {};

  withName(name: string) { this.data.name = name; return this; }
  asAdmin() { this.data.role = 'admin'; return this; }
  verified() { this.data.verified = true; return this; }

  build(): User {
    return {
      id: faker.string.uuid(),
      name: 'Test User',
      role: 'user',
      verified: false,
      ...this.data,
    };
  }
}

const user = new UserBuilder().withName('Alice').asAdmin().verified().build();
```

## 效能測試

### 基準測試（Benchmark）

```typescript
// Vitest bench
import { bench, describe } from 'vitest';

describe('陣列搜尋', () => {
  const items = Array.from({ length: 10000 }, (_, i) => i);

  bench('Array.find', () => {
    items.find(x => x === 9999);
  });

  bench('Set.has', () => {
    new Set(items).has(9999);
  });

  bench('Binary Search', () => {
    binarySearch(items, 9999);
  });
});
```

### 負載測試指標

| 指標 | 健康閾值 | 工具 |
|------|---------|------|
| P50 延遲 | < 100ms | k6、Artillery |
| P99 延遲 | < 500ms | k6、Artillery |
| 錯誤率 | < 0.1% | k6、Artillery |
| 吞吐量 | 依 SLA | k6、Artillery |
| 記憶體用量 | 穩定（無洩漏） | Node --inspect、py-spy |

## 測試品質指標

| 指標 | 目標 | 說明 |
|------|:----:|------|
| 覆蓋率 | 80%+ | 整體行覆蓋率 |
| 變異分數 | 70%+ | Mutation testing 存活率 |
| 測試速度 | Unit < 100ms | 單一測試執行時間 |
| 測試隔離 | 100% | 每個測試可獨立執行 |
| 薄片率 | < 1% | Flaky test 比例 |
