# 資料庫查詢最佳化指南

> 本文件涵蓋 PostgreSQL 查詢最佳化、索引策略和 Redis 進階模式。

## EXPLAIN ANALYZE 解讀

### 基本用法

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT u.name, COUNT(o.id)
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.created_at > '2024-01-01'
GROUP BY u.name;
```

### 輸出關鍵指標

| 指標 | 含義 | 警示閾值 |
|------|------|---------|
| `Seq Scan` | 全表掃描 | 大表（>10K rows）應有索引 |
| `actual time` | 實際耗時（ms） | 單一節點 > 100ms 需優化 |
| `rows` | 預估 vs 實際行數 | 差異 > 10x 需更新統計 |
| `Buffers: shared hit` | 快取命中 | hit/(hit+read) < 90% 需加記憶體 |
| `Sort Method: external merge` | 磁碟排序 | 增加 `work_mem` |
| `Nested Loop` | 巢狀迴圈 JOIN | 大表配對應改 Hash Join |

### 常見掃描型別效能排序

```
Index Only Scan  > Index Scan > Bitmap Index Scan > Seq Scan
（最快）                                            （最慢）
```

## 索引策略

### 索引類型選擇

| 索引類型 | 適用場景 | 範例 |
|---------|---------|------|
| B-tree（預設） | 等值查詢、範圍查詢、排序 | `CREATE INDEX ON users(email)` |
| Hash | 純等值查詢 | `CREATE INDEX ON users USING hash(token)` |
| GIN | 全文搜尋、JSONB、陣列 | `CREATE INDEX ON docs USING gin(content)` |
| GiST | 地理位置、範圍型別 | `CREATE INDEX ON places USING gist(location)` |
| BRIN | 自然排序的大表（時間序列） | `CREATE INDEX ON logs USING brin(created_at)` |

### 複合索引原則

```sql
-- 最左前綴原則：查詢必須從左到右使用索引欄位
CREATE INDEX idx_orders ON orders(user_id, status, created_at);

-- ✅ 能用到索引
WHERE user_id = 1
WHERE user_id = 1 AND status = 'active'
WHERE user_id = 1 AND status = 'active' AND created_at > '2024-01-01'

-- ❌ 不能用到索引（跳過了 user_id）
WHERE status = 'active'
WHERE created_at > '2024-01-01'
```

### 部分索引（Partial Index）

```sql
-- 只索引活躍訂單（減少索引大小）
CREATE INDEX idx_active_orders ON orders(user_id, created_at)
WHERE status = 'active';

-- 只索引未處理的任務
CREATE INDEX idx_pending_tasks ON tasks(priority, created_at)
WHERE completed_at IS NULL;
```

### 覆蓋索引（Covering Index）

```sql
-- INCLUDE 讓 Index Only Scan 涵蓋更多欄位
CREATE INDEX idx_users_email ON users(email) INCLUDE (name, avatar_url);

-- 查詢可以完全從索引滿足，不需回表
SELECT name, avatar_url FROM users WHERE email = 'test@test.com';
```

## N+1 問題解法

### 問題示範

```javascript
// ❌ N+1：1 次查 users + N 次查 orders
const users = await db.user.findMany();
for (const user of users) {
  user.orders = await db.order.findMany({ where: { userId: user.id } });
}

// ✅ Eager Loading：2 次查詢
const users = await db.user.findMany({
  include: { orders: true },
});

// ✅ DataLoader（GraphQL 場景）
const orderLoader = new DataLoader(async (userIds) => {
  const orders = await db.order.findMany({
    where: { userId: { in: userIds } },
  });
  return userIds.map(id => orders.filter(o => o.userId === id));
});
```

## 進階查詢模式

### 分頁：Cursor vs Offset

```sql
-- ❌ Offset 分頁（大偏移量很慢）
SELECT * FROM orders ORDER BY id LIMIT 20 OFFSET 100000;

-- ✅ Cursor 分頁（穩定效能）
SELECT * FROM orders
WHERE id > :last_cursor
ORDER BY id
LIMIT 20;
```

### 遞迴 CTE（階層資料）

```sql
-- 組織架構樹
WITH RECURSIVE org_tree AS (
  -- 起點
  SELECT id, name, parent_id, 0 AS depth
  FROM departments
  WHERE parent_id IS NULL

  UNION ALL

  -- 遞迴
  SELECT d.id, d.name, d.parent_id, t.depth + 1
  FROM departments d
  JOIN org_tree t ON d.parent_id = t.id
)
SELECT * FROM org_tree ORDER BY depth, name;
```

### Window Functions

```sql
-- 每個使用者的最新訂單
SELECT * FROM (
  SELECT o.*,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
  FROM orders o
) sub
WHERE rn = 1;

-- 累計金額
SELECT date, amount,
  SUM(amount) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING) AS running_total
FROM transactions;
```

## Redis 進階模式

### 資料結構選擇

| 場景 | 資料結構 | 指令 |
|------|---------|------|
| 快取 | String | GET/SET/SETEX |
| 計數器 | String | INCR/DECR |
| 排行榜 | Sorted Set | ZADD/ZRANGE/ZRANK |
| 唯一計數 | HyperLogLog | PFADD/PFCOUNT |
| 佇列 | List / Stream | LPUSH+BRPOP / XADD+XREAD |
| 限時任務 | Sorted Set | ZADD(score=timestamp) + ZRANGEBYSCORE |
| 分散式鎖 | String | SET NX EX |

### Cache-Aside 模式

```javascript
async function getUser(id) {
  // 1. 查快取
  const cached = await redis.get(`user:${id}`);
  if (cached) return JSON.parse(cached);

  // 2. 查資料庫
  const user = await db.user.findUnique({ where: { id } });
  if (!user) return null;

  // 3. 寫入快取（TTL 5 分鐘）
  await redis.setex(`user:${id}`, 300, JSON.stringify(user));
  return user;
}

// 更新時失效快取
async function updateUser(id, data) {
  await db.user.update({ where: { id }, data });
  await redis.del(`user:${id}`);  // 失效而非更新
}
```

### 分散式鎖

```javascript
async function acquireLock(key, ttl = 10) {
  const token = crypto.randomUUID();
  const acquired = await redis.set(
    `lock:${key}`, token, 'EX', ttl, 'NX'
  );
  return acquired ? token : null;
}

async function releaseLock(key, token) {
  // Lua 保證原子性（只釋放自己的鎖）
  await redis.eval(`
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    end
    return 0
  `, 1, `lock:${key}`, token);
}
```

## 連線池設定

| 參數 | 建議值 | 說明 |
|------|:------:|------|
| pool_size | CPU * 2 + 1 | PostgreSQL 連線數 |
| idle_timeout | 10s | 閒置連線回收時間 |
| connection_timeout | 5s | 取得連線超時 |
| statement_timeout | 30s | 查詢超時（防慢查詢） |
| max_overflow | pool_size * 0.5 | 臨時額外連線 |
