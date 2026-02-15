# React Server Components 實戰模式

> 本文件涵蓋 React 19 Server Components（RSC）的核心概念、模式和最佳實踐。

## 核心概念

### Server vs Client 元件

| 特性 | Server Component | Client Component |
|------|:----------------:|:----------------:|
| 渲染位置 | 僅伺服器 | 伺服器 + 客戶端 |
| JavaScript 傳送 | ❌ 不傳送 | ✅ 傳送到客戶端 |
| Hydration | ❌ 不需要 | ✅ 需要 |
| 直接存取後端 | ✅ 資料庫、檔案系統 | ❌ 需透過 API |
| 使用 hooks | ❌ | ✅ useState、useEffect |
| 事件處理 | ❌ | ✅ onClick 等 |

### 決策流程

```
元件需要互動（click/input/state）嗎？
├── 是 → Client Component（'use client'）
└── 否 → 元件需要存取後端資料嗎？
    ├── 是 → Server Component（預設）
    └── 否 → Server Component（預設，更小 bundle）
```

## 資料擷取模式

### Server Component 直接查詢

```tsx
// app/users/page.tsx（Server Component，預設）
import { db } from '@/lib/db';

export default async function UsersPage() {
  // 直接查詢資料庫，不需 API 層
  const users = await db.user.findMany();

  return (
    <ul>
      {users.map(user => <li key={user.id}>{user.name}</li>)}
    </ul>
  );
}
```

### 平行資料擷取

```tsx
export default async function Dashboard() {
  // 平行發起多個查詢
  const [users, orders, stats] = await Promise.all([
    getUsers(),
    getOrders(),
    getStats(),
  ]);

  return (
    <>
      <UserList users={users} />
      <OrderTable orders={orders} />
      <StatsPanel stats={stats} />
    </>
  );
}
```

### Streaming + Suspense

```tsx
import { Suspense } from 'react';

export default function Page() {
  return (
    <div>
      {/* 立即顯示 */}
      <Header />

      {/* 串流載入 — 顯示骨架屏直到資料就緒 */}
      <Suspense fallback={<TableSkeleton />}>
        <SlowDataTable />
      </Suspense>

      {/* 低優先級內容 */}
      <Suspense fallback={<Spinner />}>
        <Recommendations />
      </Suspense>
    </div>
  );
}
```

## Server Actions

### 基本用法

```tsx
// app/actions.ts
'use server';

import { revalidatePath } from 'next/cache';

export async function createUser(formData: FormData) {
  const name = formData.get('name') as string;

  await db.user.create({ data: { name } });
  revalidatePath('/users');
}
```

### 搭配表單

```tsx
// Client Component
'use client';

import { createUser } from './actions';
import { useActionState } from 'react';

export function UserForm() {
  const [state, action, pending] = useActionState(createUser, null);

  return (
    <form action={action}>
      <input name="name" required />
      <button disabled={pending}>
        {pending ? '建立中...' : '建立'}
      </button>
    </form>
  );
}
```

### 樂觀更新

```tsx
'use client';

import { useOptimistic } from 'react';

export function TodoList({ todos }: { todos: Todo[] }) {
  const [optimisticTodos, addOptimistic] = useOptimistic(
    todos,
    (state, newTodo: Todo) => [...state, newTodo]
  );

  async function addTodo(formData: FormData) {
    const todo = { id: crypto.randomUUID(), text: formData.get('text') };
    addOptimistic(todo);       // 立即顯示
    await createTodo(formData); // 背景送出
  }

  return (
    <form action={addTodo}>
      {optimisticTodos.map(todo => <div key={todo.id}>{todo.text}</div>)}
      <input name="text" />
    </form>
  );
}
```

## 元件組合模式

### Server/Client 邊界

```tsx
// ✅ 正確：Server 元件傳遞資料給 Client 元件
async function Page() {
  const data = await fetchData(); // 伺服器端取資料
  return <InteractiveChart data={data} />; // 傳給客戶端
}

// ❌ 錯誤：Client 元件包裹 Server 元件
'use client';
function Wrapper() {
  return <ServerComponent />; // 會強制變成 Client
}

// ✅ 正確：用 children 注入 Server 元件
'use client';
function ClientWrapper({ children }) {
  const [open, setOpen] = useState(false);
  return <div>{open && children}</div>;
}

// 在 Server 端組合
function Page() {
  return (
    <ClientWrapper>
      <ServerContent />  {/* 仍是 Server Component */}
    </ClientWrapper>
  );
}
```

### Composition Pattern（組合模式）

```tsx
// 佈局：Server Component
export default async function Layout({ children }) {
  const user = await getUser();
  return (
    <div>
      <Sidebar user={user} />      {/* Server */}
      <main>{children}</main>
      <ClientNavbar user={user} />  {/* Client：互動導覽列 */}
    </div>
  );
}
```

## 效能最佳化

| 策略 | 做法 |
|------|------|
| 最小化 Client bundle | 預設 Server，只在需要互動時加 `'use client'` |
| 粒度化 Client 邊界 | 只把互動部分包成 Client Component，不要整頁 |
| 平行查詢 | `Promise.all()` 而非序列 `await` |
| Streaming | 用 `<Suspense>` 串流慢區塊 |
| 快取 | `unstable_cache` / `revalidatePath` / `revalidateTag` |
| 預載 | `<link rel="preload">` 關鍵資源 |

## 常見陷阱

| 陷阱 | 解法 |
|------|------|
| 在 Server Component 用 useState | 互動邏輯抽到 Client Component |
| 傳遞不可序列化的 props | Server→Client 只能傳 JSON 可序列化資料 |
| 忘記 `'use client'` 標記 | 報錯時檢查是否使用了 hooks 或事件 |
| 整頁標記 `'use client'` | 只標記需要互動的最小元件 |
| Server Action 未驗證輸入 | 永遠在 Action 中驗證（zod）— 客戶端資料不可信 |

## 安全注意事項

- Server Action 本質上是 HTTP endpoint — 必須做認證和授權檢查
- 不要在 Server Component 的 props 中傳遞機密資料給 Client Component
- React 19.0.2+ 修復了已知的 RSC 安全漏洞，確保更新到最新版
