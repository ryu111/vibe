# patterns — 語言/框架模式庫

> **優先級**：中（結構簡單，量大，可穿插開發）
> **定位**：純知識庫 — 編碼標準、設計模式、最佳實踐
> **ECC 對應**：14+ pattern/standards skills（coding-standards, backend-patterns, frontend-patterns 等）

---

## 1. 概述

patterns 是 Vibe marketplace 的知識庫 plugin。它**不執行任何自動化操作**，純粹提供**編碼標準和最佳實踐**作為 Claude 的參考知識。

核心理念：**Claude 知道的越多，寫出的程式碼越好。**

與其他 plugin 的關係：
- patterns 提供知識 → sentinel 依據知識做審查
- patterns 的 coding-standards → 所有 plugin 寫程式碼時都會參考
- patterns 純知識庫 → 最像 ECC 的原始 skills 設計

### ECC Skill 模式

patterns 是唯一完全遵循 ECC 靜態知識庫模式的 plugin：
- Frontmatter 極簡（只 name + description）
- 內容 = 純知識（patterns、checklists、GOOD/BAD 對比）
- 無 hooks、scripts、agents
- 無 `$ARGUMENTS` 語意執行

## 2. 設計目標

| # | 目標 | 說明 |
|:-:|------|------|
| 1 | **全端覆蓋** | 前端（React/Next.js/Vue）+ 後端（Node.js/Python/Go） |
| 2 | **即時可用** | Claude 在寫程式碼時自動參考對應的 pattern |
| 3 | **GOOD/BAD 對比** | 每個 pattern 都有 ❌ BAD 和 ✅ GOOD 範例 |
| 4 | **Quick Reference** | 每個 skill 都有快速參考表格 |
| 5 | **可擴展** | 新增語言/框架只需新增 SKILL.md |

---

## 3. 組件清單

| 類型 | 名稱 | 說明 |
|------|------|------|
| **Skill** | `coding-standards` | 通用編碼標準（命名、結構、錯誤處理） |
| **Skill** | `frontend-patterns` | 前端模式（React/Next.js/Vue） |
| **Skill** | `backend-patterns` | 後端模式（API 設計、middleware、ORM） |
| **Skill** | `db-patterns` | 資料庫模式（PostgreSQL、Redis、query 最佳化） |
| **Skill** | `typescript-patterns` | TypeScript 特化（型別體操、utility types、strict mode） |
| **Skill** | `python-patterns` | Python 特化（typing、async、dataclass） |
| **Skill** | `go-patterns` | Go 特化（error handling、concurrency、interface） |
| **Skill** | `testing-patterns` | 測試模式（unit/integration/e2e、mocking、fixtures） |

> **無 Agents、Hooks、Scripts** — 純知識庫。

---

## 4. Skills 設計

### 4.1 coding-standards — 通用編碼標準

```yaml
name: coding-standards
description: >
  通用編碼標準 — 命名規範、檔案組織、錯誤處理、不可變性原則。
  適用於所有語言和框架。
```

**內容結構**：

#### 命名規範

| 元素 | 規範 | 範例 |
|------|------|------|
| 變數/函式 | camelCase | `getUserById`, `isActive` |
| 類別/型別 | PascalCase | `UserService`, `ApiResponse` |
| 常數 | UPPER_SNAKE | `MAX_RETRY_COUNT`, `API_BASE_URL` |
| 檔案 | kebab-case | `user-service.ts`, `api-handler.py` |
| 目錄 | kebab-case | `user-management/`, `api-routes/` |

#### 檔案組織

- 每個檔案 200-400 行（上限 800 行）
- 單一職責：一個檔案做一件事
- 相關檔案放同一目錄
- Index 檔案只做 re-export

#### 錯誤處理

```
❌ BAD
try { ... } catch (e) { console.log(e) }

✅ GOOD
try { ... } catch (error) {
  if (error instanceof ValidationError) {
    return { status: 400, message: error.message };
  }
  logger.error('Unexpected error', { error, context: { userId } });
  throw error;
}
```

#### 不可變性（CRITICAL）

```
❌ BAD
function addItem(cart, item) {
  cart.items.push(item);  // 修改原物件
  return cart;
}

✅ GOOD
function addItem(cart, item) {
  return { ...cart, items: [...cart.items, item] };
}
```

---

### 4.2 frontend-patterns — 前端模式

```yaml
name: frontend-patterns
description: >
  前端開發模式 — React hooks、Next.js App Router、
  Vue Composition API、狀態管理、效能最佳化。
```

**涵蓋範圍**：

| 主題 | 內容 |
|------|------|
| React Hooks | useState/useEffect/useCallback/useMemo 最佳實踐 |
| Next.js App Router | Server Components、Route Handlers、Middleware |
| Vue Composition API | ref/reactive/computed/watch 模式 |
| 狀態管理 | Zustand / Pinia / React Context 使用場景 |
| 資料取得 | SWR / TanStack Query / useFetch 模式 |
| 效能 | Lazy loading、Code splitting、Image optimization |
| 無障礙 | ARIA、語意化 HTML、鍵盤導航 |

**關鍵 Patterns**：

```
# Server vs Client Components（Next.js）

❌ BAD — 在 Server Component 使用 useState
'use client'  // 不必要的 client boundary
export default function UserList({ users }) { ... }

✅ GOOD — Server Component 做資料取得，Client Component 做互動
// app/users/page.tsx (Server)
export default async function UsersPage() {
  const users = await getUsers();
  return <UserList users={users} />;
}
// components/UserList.tsx (Client — 只在需要互動時)
'use client'
export function UserList({ users }) { ... }
```

---

### 4.3 backend-patterns — 後端模式

```yaml
name: backend-patterns
description: >
  後端開發模式 — API 設計（REST/GraphQL）、middleware、
  認證授權、ORM、快取策略。
```

**涵蓋範圍**：

| 主題 | 內容 |
|------|------|
| API 設計 | RESTful conventions、GraphQL schema、版本控制 |
| Middleware | 認證、日誌、錯誤處理、速率限制 |
| 認證授權 | JWT、OAuth 2.0、RBAC、Session 管理 |
| ORM | Prisma / SQLAlchemy / GORM 最佳實踐 |
| 快取 | Redis patterns、cache invalidation、TTL 策略 |
| 佇列 | BullMQ / Celery 任務佇列模式 |

**關鍵 Patterns**：

```
# Repository Pattern

❌ BAD — Controller 直接操作資料庫
app.get('/users/:id', async (req, res) => {
  const user = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  res.json(user);
});

✅ GOOD — 透過 Repository 抽象資料存取
// repository
class UserRepository {
  async findById(id: string): Promise<User | null> { ... }
}
// controller
app.get('/users/:id', async (req, res) => {
  const user = await userRepo.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});
```

---

### 4.4 db-patterns — 資料庫模式

```yaml
name: db-patterns
description: >
  資料庫模式 — PostgreSQL 查詢最佳化、索引策略、
  migration、連線池管理、Redis 快取模式。
```

**涵蓋範圍**：

| 主題 | 內容 |
|------|------|
| PostgreSQL | 查詢最佳化、索引策略、CTE、Window functions |
| Migration | 版本控制、回滾策略、零停機遷移 |
| 連線池 | 池大小設定、健康檢查、超時處理 |
| Redis | 資料結構選擇、TTL 策略、pub/sub |
| N+1 問題 | 偵測和解決 N+1 查詢 |

---

### 4.5 typescript-patterns — TypeScript 特化

```yaml
name: typescript-patterns
description: >
  TypeScript 進階模式 — Utility types、Generic constraints、
  Discriminated unions、Type guards、Strict mode 最佳實踐。
```

**涵蓋範圍**：

| 主題 | 內容 |
|------|------|
| 型別體操 | Utility types（Partial、Pick、Omit、Record） |
| Generics | Constraints、Default types、Conditional types |
| 型別守衛 | Type guards、Discriminated unions、Narrowing |
| Strict mode | strictNullChecks、noImplicitAny、exactOptionalPropertyTypes |
| Zod/Valibot | Runtime validation + Type inference |

**關鍵 Patterns**：

```
# Discriminated Union + Exhaustive Check

❌ BAD
type Result = { success: boolean; data?: any; error?: string };

✅ GOOD
type Result<T> =
  | { status: 'success'; data: T }
  | { status: 'error'; error: string };

function handleResult<T>(result: Result<T>) {
  switch (result.status) {
    case 'success': return result.data;
    case 'error': throw new Error(result.error);
    default: const _exhaustive: never = result; // 編譯期檢查
  }
}
```

---

### 4.6 python-patterns — Python 特化

```yaml
name: python-patterns
description: >
  Python 進階模式 — typing、async/await、dataclass、
  Protocol、FastAPI/Django 最佳實踐。
```

**涵蓋範圍**：

| 主題 | 內容 |
|------|------|
| typing | TypeVar、Generic、Protocol、Literal |
| async | asyncio patterns、async generators、TaskGroup |
| dataclass | frozen、slots、field factories |
| FastAPI | Dependency injection、Pydantic models、Background tasks |
| Django | Model managers、Queryset optimization、Signals |

---

### 4.7 go-patterns — Go 特化

```yaml
name: go-patterns
description: >
  Go 進階模式 — error handling、concurrency（goroutines/channels）、
  interface design、testing patterns。
```

**涵蓋範圍**：

| 主題 | 內容 |
|------|------|
| Error handling | Sentinel errors、error wrapping、custom error types |
| Concurrency | goroutines、channels、sync primitives、context |
| Interface | Implicit interfaces、interface segregation、accept interfaces return structs |
| Testing | Table-driven tests、test fixtures、mocking |
| Project layout | Standard Go project layout |

---

### 4.8 testing-patterns — 測試模式

```yaml
name: testing-patterns
description: >
  測試模式 — unit/integration/e2e 測試策略、
  mocking、fixtures、測試金字塔、覆蓋率目標。
```

**涵蓋範圍**：

| 主題 | 內容 |
|------|------|
| 測試金字塔 | Unit（70%）→ Integration（20%）→ E2E（10%） |
| 命名 | `should [expected behavior] when [condition]` |
| Mocking | 何時 mock、mock 策略、dependency injection |
| Fixtures | Factory patterns、test data builders |
| 覆蓋率 | 80% 目標、關鍵路徑 100%、UI 可適度降低 |
| E2E | Page Object Model、test isolation、retry strategy |

---

## 5. SKILL.md 統一格式

每個 pattern skill 都遵循相同結構：

```markdown
---
name: {skill-name}
description: {一句話描述}
---

## Quick Reference
（表格形式的速查指南）

## Patterns

### Pattern 1: {模式名稱}
**何時使用**：...
**❌ BAD**：...
**✅ GOOD**：...
**說明**：...

### Pattern 2: {模式名稱}
...

## Checklist
（審查清單）

## 常見陷阱
（踩坑記錄）
```

---

## 6. 目錄結構

> 已併入統一 `vibe` plugin，以下為 patterns 模組相關檔案。

```
plugins/vibe/
├── .claude-plugin/
│   └── plugin.json
└── skills/
    ├── coding-standards/
    │   └── SKILL.md
    ├── frontend-patterns/
    │   └── SKILL.md
    ├── backend-patterns/
    │   └── SKILL.md
    ├── db-patterns/
    │   └── SKILL.md
    ├── typescript-patterns/
    │   └── SKILL.md
    ├── python-patterns/
    │   └── SKILL.md
    ├── go-patterns/
    │   └── SKILL.md
    └── testing-patterns/
        └── SKILL.md
```

> **無 agents/、hooks/、scripts/** — 純知識庫，最簡結構。

---

## 7. ECC 參考對應

| Vibe patterns skill | ECC 對應 | 差異 |
|--------------------|---------|------|
| coding-standards | coding-standards | 合併 ECC 的通用+語言專用標準 |
| frontend-patterns | frontend-patterns | 擴展：加入 Next.js App Router、Vue |
| backend-patterns | backend-patterns | 擴展：加入 FastAPI、Django |
| db-patterns | postgres-patterns + clickhouse-io | 合併 + 擴展 Redis |
| typescript-patterns | 無直接對應 | 新增：從 coding-standards 抽出 TS 專項 |
| python-patterns | python-patterns | 擴展：加入 FastAPI、Django |
| go-patterns | golang-patterns | 相同定位 |
| testing-patterns | tdd-workflow + *-testing | 合併測試相關 skills |

**ECC 未移植的功能**：
- `java-coding-standards` — 目標使用者不含 Java
- `springboot-patterns` — 同上
- `django-tdd` — 合併到 testing-patterns
- `jpa-patterns` — 同上

---

## 8. 驗收標準

| # | 條件 | 說明 |
|:-:|------|------|
| P-01 | Plugin 可載入 | `claude --plugin-dir ./plugins/patterns` 成功載入 |
| P-02 | 8 個 skill 可呼叫 | 各 `/vibe:{skill}` 命令 |
| P-03 | 每個 skill 有 GOOD/BAD 對比 | 至少 5 組 |
| P-04 | 每個 skill 有 Quick Reference | 至少一個表格 |
| P-05 | 每個 skill 有 Checklist | 至少 5 項 |
| P-06 | 驗證腳本全 PASS | forge:scaffold 驗證通過 |

---

## 9. plugin.json

```json
{
  "name": "patterns",
  "version": "0.1.0",
  "description": "語言/框架模式庫 — 編碼標準、設計模式、最佳實踐",
  "skills": ["./skills/"]
}
```

> **極簡 manifest** — 無 agents、hooks 不宣告、純 skills 自動掃描。
