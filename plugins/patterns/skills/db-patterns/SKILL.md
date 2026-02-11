---
name: db-patterns
description: >-
  資料庫模式 — PostgreSQL 查詢最佳化、索引策略、
  migration、連線池管理、Redis 快取模式。
---

## Quick Reference

| 場景 | 推薦方案 | 關鍵點 |
|------|----------|--------|
| 多欄位查詢 | 複合索引 | 最常用欄位放最左邊 |
| 關聯查詢 | JOIN + Eager loading | 避免 N+1 問題 |
| 大表查詢 | CTE + Window functions | 分步驟、易維護 |
| Schema 變更 | 分階段 migration | 零停機部署 |
| 熱資料快取 | Redis Hash/String | 設定合理 TTL |
| 連線管理 | 連線池（5-10） | CPU 核心數的 2-3 倍 |
| 階層資料 | Recursive CTE | PostgreSQL 原生支援 |
| 計數查詢 | Redis Counter | 避免 COUNT(*) |

## Patterns

### Pattern 1: 複合索引欄位順序

**何時使用**：多欄位 WHERE 子句查詢，需要最佳化查詢效能。

**❌ BAD**
```sql
-- 索引順序錯誤
CREATE INDEX idx_orders_bad ON orders (created_at, status, user_id);

-- 查詢主要用 user_id 和 status
SELECT * FROM orders
WHERE user_id = 123
  AND status = 'pending'
  AND created_at > '2024-01-01';
-- 索引無法有效使用（最左欄位 created_at 不在 WHERE 前段）
```

**✅ GOOD**
```sql
-- 索引順序：高選擇性 → 低選擇性
CREATE INDEX idx_orders_good ON orders (user_id, status, created_at);

-- 相同查詢現在可以完全使用索引
SELECT * FROM orders
WHERE user_id = 123
  AND status = 'pending'
  AND created_at > '2024-01-01';
-- Index Only Scan，效能提升 10-100 倍
```

**說明**：複合索引遵循「最左前綴原則」— 欄位順序應該是：等值查詢欄位（=）→ 範圍查詢欄位（>, <, BETWEEN）→ 排序欄位（ORDER BY）。高選擇性欄位（值分散）放前面，低選擇性欄位（如 status 只有幾個值）放中間。

### Pattern 2: 解決 N+1 查詢問題

**何時使用**：需要載入關聯資料（如文章和作者），避免多次資料庫往返。

**❌ BAD**
```javascript
// Prisma ORM - N+1 問題
const posts = await prisma.post.findMany();
// 1 次查詢

for (const post of posts) {
  const author = await prisma.user.findUnique({
    where: { id: post.authorId }
  });
  // N 次查詢（N = posts 數量）
  console.log(`${post.title} by ${author.name}`);
}
// 總共 1 + N 次查詢 → 如果有 100 篇文章 = 101 次查詢
```

**✅ GOOD**
```javascript
// Eager loading - 一次性載入關聯
const posts = await prisma.post.findMany({
  include: {
    author: true  // JOIN 查詢
  }
});
// 只有 1 次查詢（使用 LEFT JOIN）

posts.forEach(post => {
  console.log(`${post.title} by ${post.author.name}`);
});
// 效能提升：從 101 次查詢 → 1 次查詢
```

**說明**：N+1 問題是 ORM 最常見的效能陷阱。使用 `include`（Prisma）或 `prefetch_related`（Django）來預載入關聯資料。可用 Prisma 的 `prisma:query` 日誌或 Django Debug Toolbar 偵測。

### Pattern 3: 零停機 Migration

**何時使用**：生產環境 schema 變更，需要避免服務中斷。

**❌ BAD**
```sql
-- 一步完成：會鎖表數秒到數分鐘
ALTER TABLE users
  DROP COLUMN old_email,
  ADD COLUMN new_email VARCHAR(255) NOT NULL;

-- NOT NULL 約束會導致：
-- 1. 全表掃描檢查
-- 2. 已有 row 無法插入預設值 → 錯誤
```

**✅ GOOD**
```sql
-- 階段 1：新增欄位（允許 NULL）
ALTER TABLE users ADD COLUMN new_email VARCHAR(255);
-- 部署程式碼：雙寫 old_email + new_email

-- 階段 2：回填資料（分批執行）
UPDATE users SET new_email = old_email WHERE new_email IS NULL;
-- 使用 LIMIT + 迴圈，避免長時間鎖表

-- 階段 3：加上約束
ALTER TABLE users ALTER COLUMN new_email SET NOT NULL;
-- 部署程式碼：只寫 new_email

-- 階段 4：移除舊欄位
ALTER TABLE users DROP COLUMN old_email;
```

**說明**：分階段 migration 原則：先加後減、允許冗餘期、雙寫雙讀、分批回填。每階段獨立部署，可隨時回滾。PostgreSQL 的 `ADD COLUMN ... DEFAULT` 在 11+ 版本不鎖表（預設值寫入 metadata）。

### Pattern 4: 連線池設定

**何時使用**：Node.js/Python 應用連接 PostgreSQL，需要管理連線數量。

**❌ BAD**
```javascript
// 連線池過大
const pool = new Pool({
  max: 100,  // ❌ 每個 instance 100 個連線
  idleTimeoutMillis: 60000
});

// 問題：
// - 3 個應用實例 = 300 個連線（PostgreSQL 預設上限 100）
// - 大量 idle 連線浪費記憶體
// - 連線建立慢（TCP + SSL + auth）
```

**✅ GOOD**
```javascript
// 連線池大小 = CPU 核心數 × 2 + 1 個備用
const pool = new Pool({
  max: 10,               // 4 核心 × 2 + 2
  min: 2,                // 保持最小連線
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // 健康檢查
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});

// 監控
pool.on('error', (err) => {
  console.error('Idle client error', err);
});
```

**說明**：連線池大小公式：`connections = ((core_count × 2) + effective_spindle_count)`。對於 SSD 可簡化為核心數的 2-3 倍。監控指標：等待時間、idle 連線數、拒絕數。使用 PgBouncer 等連線池代理可進一步最佳化。

### Pattern 5: Redis 資料結構選擇

**何時使用**：選擇最適合業務場景的 Redis 資料型態。

**❌ BAD**
```javascript
// 用 String 儲存 JSON 物件
await redis.set('user:123', JSON.stringify({
  name: 'Alice',
  email: 'alice@example.com',
  score: 100
}));

// 每次更新需要：
// 1. GET 整個 JSON
// 2. 解析 JSON
// 3. 修改一個欄位
// 4. 序列化回 JSON
// 5. SET 整個 JSON
const user = JSON.parse(await redis.get('user:123'));
user.score += 10;
await redis.set('user:123', JSON.stringify(user));
```

**✅ GOOD**
```javascript
// 用 Hash 儲存物件
await redis.hSet('user:123', {
  name: 'Alice',
  email: 'alice@example.com',
  score: '100'
});

// 原子操作更新單一欄位
await redis.hIncrBy('user:123', 'score', 10);
// 只讀取需要的欄位
const email = await redis.hGet('user:123', 'email');

// 高頻計數器用 String + INCR
await redis.set('page_views', 0);
await redis.incr('page_views');  // 原子性 +1
```

**說明**：資料結構選擇表：
- **String**：計數器（INCR）、快取整個物件（小物件）、分散式鎖
- **Hash**：物件屬性（user profile）、購物車
- **List**：佇列（LPUSH + BRPOP）、時間線
- **Set**：標籤、去重、交集/聯集查詢
- **Sorted Set**：排行榜、延遲任務（以時間為 score）

### Pattern 6: CTE 遞迴查詢階層資料

**何時使用**：查詢樹狀結構（如組織架構、留言串、類別樹）。

**❌ BAD**
```javascript
// 多次查詢 + 應用層遞迴
async function getOrgTree(managerId) {
  const manager = await db.query(
    'SELECT * FROM employees WHERE id = $1', [managerId]
  );
  const subordinates = await db.query(
    'SELECT * FROM employees WHERE manager_id = $1', [managerId]
  );

  // 遞迴查詢每個下屬
  for (const sub of subordinates) {
    sub.children = await getOrgTree(sub.id);  // N 次額外查詢
  }
  return { ...manager, children: subordinates };
}
// 深度為 5 的樹 → 可能數百次查詢
```

**✅ GOOD**
```sql
-- Recursive CTE - 一次查詢完成
WITH RECURSIVE org_tree AS (
  -- Base case：起始節點
  SELECT id, name, manager_id, 1 AS level, ARRAY[id] AS path
  FROM employees
  WHERE id = $1  -- 起始 manager

  UNION ALL

  -- Recursive case：找下屬
  SELECT e.id, e.name, e.manager_id,
         ot.level + 1,
         ot.path || e.id
  FROM employees e
  INNER JOIN org_tree ot ON e.manager_id = ot.id
  WHERE NOT e.id = ANY(ot.path)  -- 防止循環引用
)
SELECT * FROM org_tree ORDER BY level, name;
-- 單次查詢返回整棵樹，附帶層級和路徑資訊
```

**說明**：Recursive CTE 包含 base case（起始條件）和 recursive case（遞迴邏輯）。`path` 陣列用於偵測循環引用。適用場景：組織圖、BOM（物料清單）、路由表。限制：PostgreSQL 預設遞迴深度 100 層。

### Pattern 7: Window Functions 避免子查詢

**何時使用**：需要計算排名、累計、移動平均等聚合，但保留每一行資料。

**❌ BAD**
```sql
-- 用子查詢計算排名
SELECT
  p.id,
  p.name,
  p.sales,
  (SELECT COUNT(*)
   FROM products p2
   WHERE p2.sales > p.sales) + 1 AS rank
FROM products p
ORDER BY sales DESC;
-- 效能：O(n²) - 每行都掃描全表
```

**✅ GOOD**
```sql
-- Window Function - 單次掃描
SELECT
  id,
  name,
  sales,
  RANK() OVER (ORDER BY sales DESC) AS rank,
  SUM(sales) OVER (ORDER BY created_at) AS cumulative_sales,
  AVG(sales) OVER (
    ORDER BY created_at
    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) AS moving_avg_7d
FROM products;
-- 效能：O(n) - 只掃描一次
```

**說明**：Window functions 常用情境：`ROW_NUMBER()`（唯一排名）、`RANK()`（並列排名）、`LAG()/LEAD()`（上/下一行）、`FIRST_VALUE()/LAST_VALUE()`（窗口內首/尾值）。`PARTITION BY` 用於分組內排名（如每個類別的 top 3）。

### Pattern 8: Redis TTL 策略

**何時使用**：快取熱資料，避免記憶體無限增長和快取雪崩。

**❌ BAD**
```javascript
// 統一過期時間 → 快取雪崩
for (let i = 0; i < 1000; i++) {
  await redis.set(`product:${i}`, JSON.stringify(product), {
    EX: 3600  // 全部 1 小時後同時過期
  });
}
// 1 小時後：1000 個 key 同時失效 → 資料庫瞬間承受 1000 個查詢
```

**✅ GOOD**
```javascript
// 隨機化過期時間（防雪崩）
const baseTTL = 3600;
const jitter = Math.floor(Math.random() * 600);  // 0-10 分鐘
await redis.set(`product:${id}`, JSON.stringify(product), {
  EX: baseTTL + jitter  // 1-1.17 小時
});

// 分層 TTL 策略
const TTL_CONFIG = {
  hot: 3600,      // 1 小時 - 高頻資料（首頁商品）
  warm: 1800,     // 30 分鐘 - 中頻資料（類別頁）
  cold: 600       // 10 分鐘 - 低頻資料（詳情頁）
};

// 永久資料 + 定期更新（配置資料）
await redis.set('site:config', JSON.stringify(config));
// 不設 TTL，改用 Pub/Sub 通知更新
```

**說明**：TTL 策略：基礎時間 + 隨機抖動（jitter）防雪崩、根據存取頻率分層、熱點資料主動續期。快取穿透防護：空結果也快取（短 TTL）+ 布隆過濾器。快取擊穿防護：分散式鎖 + 雙重檢查。

## Checklist

- [ ] **索引覆蓋**：WHERE/JOIN/ORDER BY 欄位都有索引？複合索引順序正確？
- [ ] **N+1 偵測**：開啟 ORM 查詢日誌，檢查迴圈內是否有資料庫呼叫？
- [ ] **Migration 安全**：新增欄位允許 NULL？分階段部署？有回滾計畫？
- [ ] **連線池監控**：池大小合理（< 20）？有健康檢查？監控等待時間？
- [ ] **Redis 記憶體**：設定 `maxmemory-policy`？TTL 有隨機化？監控 `used_memory`？
- [ ] **查詢計畫**：生產環境跑過 `EXPLAIN ANALYZE`？識別 Seq Scan？
- [ ] **交易範圍**：交易只包含必要操作？避免跨服務呼叫？有超時設定？
- [ ] **防禦性查詢**：有 LIMIT 防止意外全表查詢？參數有 SQL injection 防護？
- [ ] **索引維護**：有監控未使用的索引（`pg_stat_user_indexes`）？定期 VACUUM？
- [ ] **快取一致性**：更新資料時同步失效快取？有快取版本機制？

## 常見陷阱

### 1. 盲目加索引導致寫入變慢
**現象**：為了最佳化查詢加了 10 個索引，結果 INSERT/UPDATE 變慢 3 倍。
**原因**：每個索引都要在寫入時同步更新（B-tree 維護成本）。
**解方**：只為高頻查詢加索引，監控 `pg_stat_user_indexes.idx_scan`，刪除 scan 數為 0 的索引。

### 2. Redis 記憶體爆炸
**現象**：Redis 記憶體使用從 2GB 暴增到 16GB，開始 swap，效能驟降。
**原因**：快取沒設 TTL + 業務流量增長 + 未設 `maxmemory`。
**解方**：設定 `maxmemory 8gb` + `maxmemory-policy allkeys-lru`，所有快取設 TTL。

### 3. CTE 重複執行（Materialized vs Non-Materialized）
**現象**：用 CTE 簡化查詢，但效能反而更差。
**原因**：PostgreSQL 12 之前 CTE 會 materialize（物化），12+ 改為 inline（內聯）可能重複執行。
**解方**：需要物化時明確使用 `WITH ... AS MATERIALIZED`，避免重複執行。

### 4. 連線池耗盡導致 503
**現象**：應用突然所有請求回傳 503，資料庫連線數正常。
**原因**：某個慢查詢佔住連線不釋放（如忘記 `await`），導致池耗盡。
**解方**：設定 `statement_timeout`（PostgreSQL）+ `connectionTimeoutMillis`（連線池）+ 監控慢查詢日誌。

### 5. JSONB 欄位缺索引導致全表掃描
**現象**：查詢 JSONB 欄位內的屬性，效能極差。
**原因**：JSONB 內的 key 查詢需要特殊索引（GIN 或表達式索引）。
**解方**：
```sql
-- GIN 索引（適合多 key 查詢）
CREATE INDEX idx_data_gin ON table USING GIN (data);

-- 表達式索引（適合單 key 查詢）
CREATE INDEX idx_data_name ON table ((data->>'name'));
```

### 6. Migration 回滾失敗
**現象**：部署失敗需要回滾，但 migration down 執行報錯。
**原因**：`DROP COLUMN` 後無法恢復資料，或忘記寫 down migration。
**解方**：遵循「可逆 migration」原則 — down 必須能恢復 up 的所有變更，測試環境先執行 up → down → up 流程。

### 7. Redis Pub/Sub 訊息遺失
**現象**：用 Pub/Sub 做快取失效通知，但部分服務沒收到訊息。
**原因**：Pub/Sub 不保證送達（無持久化、無 ACK 機制）。
**解方**：改用 Redis Streams（有 consumer group + ACK）或 message queue（RabbitMQ/Kafka）。

### 8. COUNT(*) 拖垮效能
**現象**：分頁查詢需要總數，`COUNT(*)` 查詢要數秒。
**原因**：PostgreSQL 的 MVCC 機制導致 COUNT 必須掃描所有 tuple。
**解方**：
- 快取總數（Redis）+ 定期更新
- 用估算值：`SELECT reltuples FROM pg_class WHERE relname = 'table_name'`
- 顯示「約 XXX 筆」而非精確數字
