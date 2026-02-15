---
name: frontend-patterns
description: >-
  前端開發模式 — React hooks、Next.js App Router、
  Vue Composition API、狀態管理、效能最佳化。
---

## Quick Reference

| 場景 | 推薦方案 | 避免 |
|------|---------|------|
| 靜態頁面 | Server Component | Client Component |
| 表單互動 | Client Component + controlled inputs | 非控制元件 |
| 全域狀態（少量） | React Context / Vue provide | Redux / Pinia |
| 全域狀態（複雜） | Zustand / Pinia | prop drilling |
| 伺服器資料 | TanStack Query / SWR / useFetch | useEffect + fetch |
| 清單渲染 | virtualization（>100 項） | 全部渲染 |
| 圖片 | next/image / nuxt-img | 原生 `<img>` |
| 路由資料 | Server Component async fetch | Client-side useEffect fetch |

## Patterns

### Pattern 1: Server vs Client Components（Next.js）

**何時使用**：Next.js App Router 專案中決定元件類型。

**❌ BAD**：
```tsx
// app/users/page.tsx
'use client'  // 不必要的 client boundary
import { useState, useEffect } from 'react';

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    fetch('/api/users').then(r => r.json()).then(setUsers);
  }, []);
  return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>;
}
```

**✅ GOOD**：
```tsx
// app/users/page.tsx (Server Component — 預設)
import { UserList } from './user-list';

export default async function UsersPage() {
  const users = await db.user.findMany();  // 直接在伺服器取資料
  return <UserList users={users} />;
}

// app/users/user-list.tsx (Client — 只在需要互動時)
'use client'
export function UserList({ users }: { users: User[] }) {
  const [search, setSearch] = useState('');
  const filtered = users.filter(u => u.name.includes(search));
  return (
    <>
      <input value={search} onChange={e => setSearch(e.target.value)} />
      <ul>{filtered.map(u => <li key={u.id}>{u.name}</li>)}</ul>
    </>
  );
}
```

**說明**：Server Component 直接存取資料庫，零 bundle size。只在需要 state/event 時才用 `'use client'`。

---

### Pattern 2: useEffect 資料取得陷阱

**何時使用**：需要在元件載入時取得資料。

**❌ BAD**：
```tsx
function UserProfile({ userId }: { userId: string }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/users/${userId}`)
      .then(r => r.json())
      .then(setUser)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [userId]);
  // 問題：race condition、無快取、無 dedup、無 retry
}
```

**✅ GOOD**：
```tsx
import { useQuery } from '@tanstack/react-query';

function UserProfile({ userId }: { userId: string }) {
  const { data: user, isLoading, error } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => fetch(`/api/users/${userId}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000,  // 5 分鐘內不重新請求
  });
}
```

**說明**：TanStack Query / SWR 自動處理 race condition、快取、dedup、retry、loading/error state。useEffect + fetch 只適合不需要這些特性的極簡場景。

---

### Pattern 3: 狀態管理粒度

**何時使用**：決定狀態放在哪裡。

**❌ BAD**：
```tsx
// 所有狀態都塞進一個巨大的全域 store
const useStore = create((set) => ({
  user: null,
  theme: 'light',
  sidebarOpen: true,
  modalOpen: false,
  formData: {},
  searchQuery: '',
  selectedItems: [],
  // ... 50 個狀態全部在這裡
}));
```

**✅ GOOD**：
```tsx
// 全域：真正需要跨頁面共享的
const useAuthStore = create((set) => ({
  user: null,
  login: (user) => set({ user }),
  logout: () => set({ user: null }),
}));

// 頁面層級：React Context 或 URL state
// 元件層級：useState / useReducer
function SearchPage() {
  const [query, setQuery] = useState('');       // 元件本地
  const [filters] = useSearchParams();          // URL 狀態
  const user = useAuthStore(s => s.user);       // 全域共享
}
```

**說明**：狀態位置 = 最小共用祖先。URL 狀態可被書籤/分享/瀏覽器返回。

---

### Pattern 4: 條件渲染清晰化

**何時使用**：多個條件決定顯示不同 UI。

**❌ BAD**：
```tsx
return (
  <div>
    {loading ? <Spinner /> : error ? <Error msg={error} /> :
     data && data.length > 0 ? <List items={data} /> :
     data && data.length === 0 ? <Empty /> : null}
  </div>
);
```

**✅ GOOD**：
```tsx
if (loading) return <Spinner />;
if (error) return <Error msg={error} />;
if (!data || data.length === 0) return <Empty />;

return <List items={data} />;
```

**說明**：Early return 同樣適用於 JSX。三元運算子最多用一層，超過則用 early return 或獨立函式。

---

### Pattern 5: 效能最佳化 — memo 使用時機

**何時使用**：子元件因父元件 re-render 而不必要地重新渲染。

**❌ BAD**：
```tsx
// 對所有元件都加 memo — 過度最佳化
const Button = memo(({ onClick, children }) => (
  <button onClick={onClick}>{children}</button>
));

// 同時 useCallback 包裹所有函式
const handleClick = useCallback(() => { doSomething(); }, []);
```

**✅ GOOD**：
```tsx
// 只在確認有效能問題時才 memo
// 1. 元件渲染成本高（大型清單、圖表、複雜計算）
const ExpensiveChart = memo(function ExpensiveChart({ data }: Props) {
  return <Chart data={data} />;  // 渲染成本高
});

// 2. 穩定 callback 傳給 memo 元件時才需要 useCallback
function Dashboard({ chartData }: { chartData: DataPoint[] }) {
  const handleDrill = useCallback((point: DataPoint) => {
    navigate(`/detail/${point.id}`);
  }, [navigate]);

  return <ExpensiveChart data={chartData} onDrill={handleDrill} />;
}
```

**說明**：先量測、再最佳化。React DevTools Profiler 可以確認 re-render 是否真的是瓶頸。大多數情況下 React 的 reconciliation 已經夠快。

---

### Pattern 6: 表單處理

**何時使用**：處理複雜表單（>3 個欄位）。

**❌ BAD**：
```tsx
function SignUpForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [nameError, setNameError] = useState('');
  const [emailError, setEmailError] = useState('');
  // ... 每個欄位都有 state + error state
}
```

**✅ GOOD**：
```tsx
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const schema = z.object({
  name: z.string().min(2, '至少 2 個字元'),
  email: z.string().email('無效的 email'),
  password: z.string().min(8, '至少 8 個字元'),
  confirmPassword: z.string(),
}).refine(d => d.password === d.confirmPassword, {
  message: '密碼不一致',
  path: ['confirmPassword'],
});

function SignUpForm() {
  const { register, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(schema),
  });
  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <input {...register('name')} />
      {errors.name && <span>{errors.name.message}</span>}
      {/* ... */}
    </form>
  );
}
```

**說明**：react-hook-form + zod = 宣告式驗證、型別安全、最少 re-render。schema 可以跟後端共用。

### Pattern 7: 無障礙（Accessibility）

**何時使用**：所有面向使用者的 UI 元件。

**❌ BAD**：
```tsx
<div onClick={handleClick}>點擊這裡</div>
<div class="modal">
  <span class="close" onClick={onClose}>X</span>
  <p>確定要刪除嗎？</p>
  <div onClick={onConfirm}>確定</div>
</div>
```

**✅ GOOD**：
```tsx
<button onClick={handleClick}>點擊這裡</button>
<dialog open={isOpen} aria-labelledby="modal-title">
  <h2 id="modal-title">確認刪除</h2>
  <p>確定要刪除嗎？</p>
  <button onClick={onConfirm}>確定</button>
  <button onClick={onClose} autoFocus>取消</button>
</dialog>
```

**說明**：使用語意化 HTML（`<button>` 而非 `<div onClick>`）自動獲得鍵盤導航和螢幕閱讀器支援。`aria-labelledby` 關聯標題，`autoFocus` 讓對話框開啟時焦點在安全操作上。

## Checklist

- [ ] Server Component 是否為預設選擇？只在需要互動時才用 `'use client'`？
- [ ] 資料取得是否用 TanStack Query / SWR 而非裸 useEffect？
- [ ] 狀態是否放在最小共用祖先？URL 狀態是否用 searchParams？
- [ ] 清單超過 100 項是否使用 virtualization（react-virtual / vue-virtual-scroller）？
- [ ] 圖片是否使用框架內建元件（next/image）？
- [ ] 三元運算子是否最多一層？多條件用 early return。
- [ ] 表單是否使用 form library（react-hook-form / vee-validate）+ schema 驗證？
- [ ] 互動元素是否使用語意化 HTML（`<button>`、`<a>`、`<dialog>`）？

## 常見陷阱

1. **useEffect 依賴遺漏**：ESLint exhaustive-deps 規則不要關閉，而是修正依賴陣列。
2. **Context 過度使用**：頻繁變更的值放 Context 會導致整棵子樹 re-render，改用 Zustand selector。
3. **layout shift**：圖片和動態內容需要預留空間（`aspect-ratio` 或固定高度）。
4. **hydration mismatch**：Server/Client 渲染結果不同（如 `Date.now()`、`window.innerWidth`），用 `useEffect` 延遲 client-only 內容。
5. **過度最佳化**：不要預設加 `memo` / `useMemo` / `useCallback`，先用 Profiler 確認瓶頸。
6. **`<div>` 取代 `<button>`**：失去鍵盤導航（Tab/Enter/Space）、螢幕閱讀器無法辨識、需手動加 `role`/`tabIndex`/`onKeyDown`。

---

## 深度參考

需要 React Server Components 模式時，讀取 `references/server-components.md`，涵蓋：
- Server vs Client 元件決策流程
- 資料擷取模式（直接查詢、平行、Streaming + Suspense）
- Server Actions（表單處理、樂觀更新）
- Server/Client 邊界組合模式
- 效能最佳化策略
- 安全注意事項（RSC 漏洞修復）
