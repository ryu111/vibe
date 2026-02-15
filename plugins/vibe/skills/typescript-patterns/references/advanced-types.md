# TypeScript 進階型別模式

> 本文件涵蓋 SKILL.md 未深入的進階型別技巧，適用於需要高度型別安全的場景。

## 條件型別與 infer

### 基本 infer 模式

```typescript
// 提取函式回傳型別
type ReturnOf<T> = T extends (...args: any[]) => infer R ? R : never;

// 提取 Promise 內部型別（遞迴解包）
type Awaited<T> = T extends Promise<infer U> ? Awaited<U> : T;

// 提取陣列元素型別
type ElementOf<T> = T extends (infer E)[] ? E : never;
```

### 字串模板推斷

```typescript
// 從路徑提取參數（如 '/users/:id/posts/:postId'）
type ExtractParams<T extends string> =
  T extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParams<Rest>
    : T extends `${string}:${infer Param}`
      ? Param
      : never;

type Params = ExtractParams<'/users/:id/posts/:postId'>;
// => 'id' | 'postId'
```

### 從檔名提取副檔名

```typescript
type FileExt<T extends string> =
  T extends `${string}.${infer Ext}` ? Ext : never;

type Ext = FileExt<'app.config.ts'>; // => 'config.ts'
// 需遞迴取最後一段：
type LastExt<T extends string> =
  T extends `${infer _}.${infer Rest}`
    ? Rest extends `${string}.${string}` ? LastExt<Rest> : Rest
    : never;
```

## 模板字面值型別

### 型別安全的事件名稱

```typescript
type EventName<T extends string> = `on${Capitalize<T>}`;
type ClickEvent = EventName<'click'>; // => 'onClick'

// 組合事件系統
type DOMEvents = 'click' | 'focus' | 'blur' | 'change';
type EventHandlers = { [K in DOMEvents as EventName<K>]: () => void };
// => { onClick, onFocus, onBlur, onChange }
```

### 型別安全的 CSS 屬性

```typescript
type CSSUnit = 'px' | 'rem' | 'em' | '%' | 'vh' | 'vw';
type CSSValue = `${number}${CSSUnit}` | 'auto' | '0';

function setWidth(value: CSSValue) { /* ... */ }
setWidth('16px');  // ✅
setWidth('2rem');  // ✅
setWidth('100');   // ❌ 缺少單位
```

## Mapped Types 進階

### Key Remapping（as 子句）

```typescript
// 將所有方法轉為 async 版本
type AsyncMethods<T> = {
  [K in keyof T as K extends string ? `${K}Async` : never]:
    T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<R>
      : never;
};

interface UserService {
  getUser(id: string): User;
  deleteUser(id: string): void;
}

type AsyncUserService = AsyncMethods<UserService>;
// => { getUserAsync(id: string): Promise<User>; deleteUserAsync(id: string): Promise<void> }
```

### 過濾特定型別的鍵

```typescript
// 只保留值為函式的鍵
type MethodKeys<T> = {
  [K in keyof T]: T[K] extends Function ? K : never;
}[keyof T];

// 只保留值為字串的鍵
type StringKeys<T> = {
  [K in keyof T]: T[K] extends string ? K : never;
}[keyof T];
```

## Branded Types（標記型別）

避免原始型別混用，強制語意區分：

```typescript
type Brand<T, B extends string> = T & { readonly __brand: B };

type UserId = Brand<string, 'UserId'>;
type OrderId = Brand<string, 'OrderId'>;

function getUser(id: UserId): User { /* ... */ }

const userId = 'u-123' as UserId;
const orderId = 'o-456' as OrderId;

getUser(userId);   // ✅
getUser(orderId);  // ❌ 型別不相容
getUser('u-789');  // ❌ 未標記的字串
```

## Const Assertions 與窄化

```typescript
// as const 讓值成為字面值型別
const ROUTES = {
  HOME: '/',
  ABOUT: '/about',
  CONTACT: '/contact',
} as const;

// typeof + keyof 取得聯合型別
type Route = typeof ROUTES[keyof typeof ROUTES];
// => '/' | '/about' | '/contact'

// satisfies 同時保留推斷和驗證
const config = {
  port: 3000,
  host: 'localhost',
} satisfies Record<string, string | number>;
// config.port 的型別是 number（非 string | number）
```

## 遞迴型別

```typescript
// 深層 Readonly
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

// 深層 Partial
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// 扁平化巢狀物件的鍵（用點號連接）
type FlattenKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends object
    ? FlattenKeys<T[K], `${Prefix}${K}.`>
    : `${Prefix}${K}`;
}[keyof T & string];
```

## TypeScript 5.x 重點特性

| 版本 | 特性 | 用途 |
|------|------|------|
| 5.0 | `const` 型別參數 | 泛型函式自動推斷字面值 |
| 5.0 | Decorators（Stage 3） | 類別裝飾器標準化 |
| 5.1 | 隱式回傳 undefined | `(): undefined` 不需 return |
| 5.2 | `using` 宣告 | 資源自動釋放（Disposable） |
| 5.3 | `Import Attributes` | `import ... with { type: 'json' }` |
| 5.4 | `NoInfer<T>` | 阻止型別推斷擴散 |
| 5.5 | 推斷型別謂詞 | `filter(Boolean)` 自動窄化 |
