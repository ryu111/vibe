---
name: typescript-patterns
description: >-
  TypeScript 進階模式 — Utility types、Generic constraints、
  Discriminated unions、Type guards、Strict mode 最佳實踐。
---

## Quick Reference

| 場景 | 推薦做法 |
|------|----------|
| 需要部分欄位 | `Partial<T>`、`Pick<T, K>` |
| 排除特定欄位 | `Omit<T, K>` |
| 動態鍵值對 | `Record<K, V>` |
| 聯合型別窄化 | Discriminated Union + `switch` exhaustive check |
| 防止型別混用 | Branded Types（`& { __brand: 'TypeName' }`） |
| Runtime 驗證 | Zod schema + `z.infer<typeof schema>` |
| 泛型約束 | `<T extends Constraint>` |
| 型別斷言 | 用 `is`/`asserts` type guard，不用 `as` |
| 可選鏈處理 | 啟用 `strictNullChecks`，明確處理 `undefined` |
| 字串聯合 | `type Status = 'pending' \| 'success' \| 'error'` |

## Patterns

### Pattern 1: Discriminated Union + Exhaustive Check

**何時使用**

需要處理多種互斥狀態，且要在編譯期保證所有 case 都被處理。

**❌ BAD**

```typescript
type Response =
  | { success: true; data: string }
  | { success: false; error: string };

function handle(res: Response) {
  if (res.success) {
    console.log(res.data);
  }
  // 忘記處理 error case，編譯器不會報錯
}
```

**✅ GOOD**

```typescript
type Response =
  | { type: 'success'; data: string }
  | { type: 'error'; error: string }
  | { type: 'loading' };

function handle(res: Response): string {
  switch (res.type) {
    case 'success': return res.data;
    case 'error': return `Error: ${res.error}`;
    case 'loading': return 'Loading...';
    default: {
      const _exhaustive: never = res;
      throw new Error(`Unhandled case: ${_exhaustive}`);
    }
  }
}
```

**說明**

使用 `type` 欄位作為 discriminant，搭配 `never` 型別做窮舉檢查。新增狀態時，編譯器會在 `default` 分支報錯。

---

### Pattern 2: Branded Types（防止型別混用）

**何時使用**

需要區分結構相同但語意不同的型別（如 UserId vs ProductId）。

**❌ BAD**

```typescript
type UserId = string;
type ProductId = string;

function getUser(id: UserId) { /* ... */ }
const productId: ProductId = 'prod-123';
getUser(productId); // 編譯通過但語意錯誤
```

**✅ GOOD**

```typescript
type UserId = string & { __brand: 'UserId' };
type ProductId = string & { __brand: 'ProductId' };

function createUserId(id: string): UserId {
  return id as UserId;
}

function getUser(id: UserId) { /* ... */ }
const productId = 'prod-123' as ProductId;
// getUser(productId); // 編譯錯誤！
```

**說明**

使用 intersection type 添加不可見標記，防止不同語意的 string 互相賦值。需要顯式轉換才能建立 branded type。

---

### Pattern 3: 型別守衛（Type Guards）

**何時使用**

需要在執行期檢查型別並窄化聯合型別。

**❌ BAD**

```typescript
type User = { name: string; role: string };

function isAdmin(user: User) {
  return user.role === 'admin';
}

function process(user: User | null) {
  if (user && isAdmin(user)) {
    // TypeScript 不知道 user 一定存在
    console.log(user.name.toUpperCase());
  }
}
```

**✅ GOOD**

```typescript
type User = { name: string; role: string };

function isAdmin(user: User): user is User & { role: 'admin' } {
  return user.role === 'admin';
}

function assertUser(value: unknown): asserts value is User {
  if (!value || typeof value !== 'object' || !('name' in value)) {
    throw new Error('Invalid user');
  }
}

function process(user: User | null) {
  if (user && isAdmin(user)) {
    console.log(user.name.toUpperCase()); // user.role 型別窄化為 'admin'
  }
}
```

**說明**

`is` 用於布林返回的型別守衛；`asserts` 用於拋錯的斷言函式。兩者都能讓 TypeScript 理解型別窄化。

---

### Pattern 4: Generic Constraints

**何時使用**

需要對泛型參數施加約束，確保具備特定屬性或方法。

**❌ BAD**

```typescript
function getProperty<T>(obj: T, key: string) {
  return obj[key]; // Error: Element implicitly has 'any' type
}
```

**✅ GOOD**

```typescript
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

// 或使用多重約束
function merge<T extends object, U extends object>(a: T, b: U): T & U {
  return { ...a, ...b };
}

// 有預設型別的泛型
type ApiResponse<T = unknown> = {
  data: T;
  status: number;
};
```

**說明**

使用 `extends` 約束泛型範圍，`keyof` 確保鍵存在，多重約束用 `&` 組合。提供預設型別提高易用性。

---

### Pattern 5: Zod Schema + 型別推導

**何時使用**

需要在執行期驗證外部資料（API、表單），並自動生成 TypeScript 型別。

**❌ BAD**

```typescript
type User = {
  id: string;
  email: string;
  age: number;
};

function parseUser(data: unknown): User {
  // 手動驗證，容易遺漏欄位
  if (typeof data === 'object' && data !== null && 'id' in data) {
    return data as User;
  }
  throw new Error('Invalid user');
}
```

**✅ GOOD**

```typescript
import { z } from 'zod';

const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  age: z.number().int().positive(),
  role: z.enum(['user', 'admin']).default('user'),
});

type User = z.infer<typeof UserSchema>;

function parseUser(data: unknown): User {
  return UserSchema.parse(data); // 自動驗證 + 拋錯
}

// 部分驗證
const PartialUserSchema = UserSchema.partial();
type PartialUser = z.infer<typeof PartialUserSchema>;
```

**說明**

Schema 即是驗證器也是型別來源（Single Source of Truth）。Zod 提供豐富的 validator（email、uuid、min、max）和 transformer（default、transform）。

---

### Pattern 6: Utility Types 組合

**何時使用**

需要從現有型別派生新型別，減少重複定義。

**❌ BAD**

```typescript
type User = {
  id: string;
  name: string;
  email: string;
  password: string;
};

type UserPublic = {
  id: string;
  name: string;
  email: string;
}; // 重複定義

type UserUpdate = {
  name?: string;
  email?: string;
}; // 容易遺漏欄位
```

**✅ GOOD**

```typescript
type User = {
  id: string;
  name: string;
  email: string;
  password: string;
  createdAt: Date;
};

type UserPublic = Omit<User, 'password'>;
type UserUpdate = Partial<Pick<User, 'name' | 'email'>>;
type UserCreate = Omit<User, 'id' | 'createdAt'>;

// 進階組合
type ReadonlyUser = Readonly<User>;
type RequiredUser = Required<Partial<User>>;

// 映射型別
type UserRecord = Record<User['id'], User>;
type UserStatus = Record<'pending' | 'active' | 'banned', User[]>;
```

**說明**

`Omit` 排除欄位、`Pick` 選取欄位、`Partial` 全部可選、`Required` 全部必填、`Readonly` 唯讀、`Record` 建立鍵值對映射。組合使用避免重複。

---

### Pattern 7: Conditional Types + 型別推導

**何時使用**

需要根據條件動態決定型別，或從複雜型別中提取部分。

**❌ BAD**

```typescript
function wrapInArray(value: string | number) {
  return [value]; // 返回型別是 (string | number)[]
}
```

**✅ GOOD**

```typescript
type Wrap<T> = T extends any[] ? T : T[];

function wrapInArray<T>(value: T): Wrap<T> {
  return (Array.isArray(value) ? value : [value]) as Wrap<T>;
}

// 提取 Promise 內部型別
type Awaited<T> = T extends Promise<infer U> ? U : T;

// 提取函式返回型別
type ReturnType<T> = T extends (...args: any[]) => infer R ? R : never;

// 提取陣列元素型別
type ElementType<T> = T extends (infer U)[] ? U : never;

type User = { id: string; name: string };
type Users = User[];
type SingleUser = ElementType<Users>; // User
```

**說明**

使用 `extends` + `infer` 做條件型別推導。`infer` 宣告型別變數，用於提取泛型內部型別。

---

## Checklist

審查 TypeScript 程式碼時，確認以下事項：

- [ ] 啟用 `strictNullChecks`、`strictFunctionTypes`、`noImplicitAny`
- [ ] 聯合型別使用 discriminant 欄位（`type`、`kind`、`status`）
- [ ] 型別守衛使用 `is`/`asserts`，避免 `as` 強制轉型
- [ ] 泛型函式有適當的 `extends` 約束
- [ ] 外部資料（API、表單）使用 Zod/Valibot 驗證
- [ ] 避免 `any`，改用 `unknown` + 型別守衛
- [ ] 複雜型別使用 Utility Types 派生，不重複定義
- [ ] 列舉值使用 string union（`'a' | 'b'`）而非 enum
- [ ] 函式返回型別明確標註（避免隱式 any）
- [ ] 使用 `readonly` 保護不應變動的資料

---

## 常見陷阱

### 1. `enum` 的執行期開銷

TypeScript `enum` 會產生執行期程式碼（雙向映射），且無法做 tree-shaking。

```typescript
// ❌ 會生成額外 JS 程式碼
enum Status { Pending, Active, Banned }

// ✅ 零執行期開銷
type Status = 'pending' | 'active' | 'banned';
const Status = {
  Pending: 'pending',
  Active: 'active',
  Banned: 'banned',
} as const;
```

---

### 2. `as` 強制轉型掩蓋型別錯誤

```typescript
// ❌ 繞過編譯器檢查
const user = JSON.parse(data) as User;

// ✅ 執行期驗證
const user = UserSchema.parse(JSON.parse(data));
```

---

### 3. 可選屬性 vs undefined union

```typescript
type User = {
  name?: string; // string | undefined
};

type UserExplicit = {
  name: string | undefined; // 必須明確傳入 undefined
};

const u1: User = {}; // OK
const u2: UserExplicit = {}; // Error: Property 'name' is missing
```

啟用 `exactOptionalPropertyTypes` 可區分兩者。

---

### 4. 忘記處理 null/undefined

```typescript
// ❌ 未啟用 strictNullChecks
function process(user: User) {
  console.log(user.name.toUpperCase()); // runtime error if user.name is undefined
}

// ✅ 明確處理
function process(user: User) {
  console.log(user.name?.toUpperCase() ?? 'UNKNOWN');
}
```

---

### 5. Utility Types 的順序問題

```typescript
type User = { id: string; name: string; email: string };

// ❌ Partial 套用在 Pick 之後，email 仍是可選
type BadUpdate = Partial<Pick<User, 'name'>> & { email: string };

// ✅ 先 Omit 再 Partial
type GoodUpdate = Partial<Omit<User, 'id'>>;
```

---

### 6. 泛型預設值的陷阱

```typescript
// ❌ 預設值會讓推導失效
function identity<T = string>(value: T): T {
  return value;
}
const num = identity(42); // T 推導為 42 literal type，但可能預期是 number

// ✅ 明確標註或移除預設值
const num = identity<number>(42);
```

---

### 7. Interface vs Type 的合併行為

```typescript
// Interface 可多次宣告，自動合併（Declaration Merging）
interface User {
  name: string;
}
interface User {
  email: string; // 合併為 { name, email }
}

// Type 不能重複宣告
type User = { name: string };
// type User = { email: string }; // Error: Duplicate identifier

// ✅ 使用 Type + 交集
type UserBase = { name: string };
type UserWithEmail = UserBase & { email: string };
```

建議優先使用 `type`，除非需要 declaration merging（如擴展第三方庫的型別）。
