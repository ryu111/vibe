---
name: backend-patterns
description: >-
  後端開發模式 — API 設計（REST/GraphQL）、middleware、
  認證授權、ORM、快取策略。
---

## Quick Reference

| 場景 | 推薦方案 |
|------|---------|
| API 設計 | REST（CRUD 資源）/ GraphQL（複雜查詢） |
| 錯誤處理 | 統一 middleware 錯誤處理鏈 |
| 認證 | JWT（無狀態）/ Session（強一致性需求） |
| 授權 | RBAC（角色）+ Policy-based（細粒度） |
| 資料存取 | Repository Pattern（隔離資料層） |
| 快取 | Cache-Aside + TTL（讀多寫少） |
| API 版本控制 | URL versioning（/v1/users）或 Header |
| 速率限制 | Token Bucket + Redis（分散式） |
| 任務佇列 | BullMQ（Node.js）/ Celery（Python） |

## Patterns

### Pattern 1: Repository Pattern

**何時使用**

Controller 需要與資料庫互動，但不應直接耦合 ORM 實作。

**❌ BAD**

```javascript
// Controller 直接操作 Prisma
app.get('/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: { posts: true }
  });
  res.json(user);
});

// 測試困難、換 ORM 需改所有 controller
```

**✅ GOOD**

```javascript
// Repository 隔離資料層
class UserRepository {
  async findById(id) {
    return prisma.user.findUnique({
      where: { id },
      include: { posts: true }
    });
  }
}

// Controller 只依賴 interface
app.get('/users/:id', async (req, res) => {
  const user = await userRepo.findById(req.params.id);
  res.json(user);
});

// 可 mock repository 測試、換 ORM 只改一處
```

**說明**

Repository Pattern 在資料層和業務邏輯間建立抽象層，降低耦合、提升可測試性。適合中大型專案。

### Pattern 2: Middleware 錯誤處理鏈

**何時使用**

多個 endpoint 需要統一的錯誤格式、日誌記錄和狀態碼對應。

**❌ BAD**

```javascript
app.post('/users', async (req, res) => {
  try {
    const user = await createUser(req.body);
    res.json(user);
  } catch (err) {
    console.error(err); // 每個 endpoint 重複
    res.status(500).json({ error: err.message });
  }
});

// 錯誤格式不一致、狀態碼邏輯分散
```

**✅ GOOD**

```javascript
// 自定義錯誤類別
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

// 統一錯誤處理 middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(err.statusCode || 500).json({
    error: err.message,
    ...(process.env.NODE_ENV === 'dev' && { stack: err.stack })
  });
});

// Controller 拋錯即可
app.post('/users', async (req, res) => {
  const user = await createUser(req.body); // 錯誤自動被 catch
  res.json(user);
});
```

**說明**

集中式錯誤處理確保格式一致、減少重複程式碼、方便日誌追蹤。使用自定義錯誤類別攜帶 HTTP 狀態碼。

### Pattern 3: JWT 認證流程

**何時使用**

無狀態 API、分散式系統、前後端分離架構。

**❌ BAD**

```javascript
// 在每個 endpoint 重複驗證邏輯
app.get('/profile', (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send('No token');

  try {
    const decoded = jwt.verify(token, SECRET);
    const user = getUserById(decoded.id);
    res.json(user);
  } catch {
    res.status(401).send('Invalid token');
  }
});
```

**✅ GOOD**

```javascript
// 認證 middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new AuthError('Missing token');

  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    throw new AuthError('Invalid token');
  }
};

// 套用到需要保護的路由
app.get('/profile', authenticate, async (req, res) => {
  const user = await getUserById(req.user.id);
  res.json(user);
});

// Refresh token 機制
app.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  const payload = jwt.verify(refreshToken, REFRESH_SECRET);
  const newToken = jwt.sign({ id: payload.id }, SECRET, { expiresIn: '15m' });
  res.json({ token: newToken });
});
```

**說明**

JWT 適合無狀態場景，但需注意：(1) 使用短期 access token + 長期 refresh token，(2) 敏感操作需額外驗證，(3) 無法主動撤銷（需配合黑名單或短 TTL）。

### Pattern 4: API 版本控制

**何時使用**

API 需向後相容、有多個客戶端版本同時存在、breaking change 需漸進遷移。

**❌ BAD**

```javascript
// 直接修改現有 endpoint
app.get('/users/:id', async (req, res) => {
  const user = await getUser(req.params.id);
  // 改回傳格式會破壞舊客戶端
  res.json({ data: user, meta: { version: 2 } });
});
```

**✅ GOOD**

```javascript
// URL 版本控制（最明確）
app.get('/v1/users/:id', async (req, res) => {
  const user = await getUser(req.params.id);
  res.json(user); // 舊格式
});

app.get('/v2/users/:id', async (req, res) => {
  const user = await getUser(req.params.id);
  res.json({ data: user, meta: { timestamp: Date.now() } }); // 新格式
});

// Header 版本控制（較彈性）
app.get('/users/:id', async (req, res) => {
  const version = req.headers['api-version'] || '1';
  const user = await getUser(req.params.id);

  if (version === '2') {
    res.json({ data: user, meta: { timestamp: Date.now() } });
  } else {
    res.json(user);
  }
});
```

**說明**

URL 版本控制最直觀、易於快取、方便測試。Header 版本控制較彈性但增加客戶端複雜度。避免 query parameter 版本控制（影響 SEO 和快取）。

### Pattern 5: Cache-Aside 快取策略

**何時使用**

讀多寫少、資料更新頻率低、可容忍短暫不一致。

**❌ BAD**

```javascript
// 每次都查資料庫
app.get('/products/:id', async (req, res) => {
  const product = await db.product.findUnique({ where: { id } });
  res.json(product);
});

// 或者只寫快取不考慮失效
redis.set(`product:${id}`, JSON.stringify(product)); // 永不過期
```

**✅ GOOD**

```javascript
// Cache-Aside Pattern
app.get('/products/:id', async (req, res) => {
  const cacheKey = `product:${req.params.id}`;

  // 1. 先查快取
  let product = await redis.get(cacheKey);
  if (product) {
    return res.json(JSON.parse(product));
  }

  // 2. 快取未命中，查資料庫
  product = await db.product.findUnique({ where: { id: req.params.id } });

  // 3. 寫回快取（設定 TTL）
  await redis.setex(cacheKey, 3600, JSON.stringify(product));
  res.json(product);
});

// 資料更新時主動失效快取
app.put('/products/:id', async (req, res) => {
  const product = await db.product.update({
    where: { id: req.params.id },
    data: req.body
  });

  await redis.del(`product:${req.params.id}`); // 失效快取
  res.json(product);
});
```

**說明**

Cache-Aside 由應用層控制快取邏輯，適合複雜場景。關鍵點：(1) 設定合理 TTL 防止記憶體溢位，(2) 更新時主動失效，(3) 考慮快取穿透（查詢不存在的 key）需快取空值。

### Pattern 6: Rate Limiting（速率限制）

**何時使用**

防止 API 濫用、保護後端資源、實作付費分級服務。

**❌ BAD**

```javascript
// 簡單計數器（無法防止突發流量）
const requestCounts = {};
app.use((req, res, next) => {
  const ip = req.ip;
  requestCounts[ip] = (requestCounts[ip] || 0) + 1;

  if (requestCounts[ip] > 100) {
    return res.status(429).send('Too many requests');
  }
  next();
});

// 無法重置計數、記憶體會無限增長
```

**✅ GOOD**

```javascript
// Token Bucket 演算法（允許突發流量）
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分鐘
  max: 100, // 最多 100 次請求
  standardHeaders: true, // 回傳 RateLimit-* headers
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

app.use('/api/', limiter);

// 分散式場景使用 Redis 儲存計數
const RedisStore = require('rate-limit-redis');
const limiter = rateLimit({
  store: new RedisStore({ client: redisClient }),
  windowMs: 15 * 60 * 1000,
  max: 100
});
```

**說明**

Token Bucket 允許短時間內的突發流量，適合真實場景。分散式系統必須使用 Redis 等共享儲存，避免單機計數不準確。設定合理的 `windowMs` 和 `max` 值。

## Checklist

API 開發審查清單：

- [ ] **錯誤處理**：所有 endpoint 都有統一的錯誤處理 middleware
- [ ] **認證授權**：敏感操作需驗證 JWT 和權限檢查
- [ ] **輸入驗證**：使用 schema validator（如 Joi、Zod）驗證請求參數
- [ ] **速率限制**：公開 API 需實作 rate limiting 防止濫用
- [ ] **快取策略**：讀多寫少的資料使用 Cache-Aside + TTL
- [ ] **日誌記錄**：記錄請求 ID、使用者 ID、錯誤堆疊（脫敏）
- [ ] **API 文件**：使用 OpenAPI/Swagger 自動生成文件
- [ ] **版本控制**：Breaking change 需建立新版本 endpoint
- [ ] **CORS 設定**：正確配置 CORS headers（避免 `*` 在生產環境）
- [ ] **健康檢查**：提供 `/health` endpoint 檢查資料庫連線狀態

## 常見陷阱

### 1. N+1 查詢問題

使用 ORM 時容易產生 N+1 查詢，拖垮效能。

```javascript
// ❌ N+1 查詢
const users = await User.findAll();
for (const user of users) {
  user.posts = await Post.findAll({ where: { userId: user.id } }); // N 次查詢
}

// ✅ 使用 eager loading
const users = await User.findAll({ include: [Post] }); // 1 次查詢
```

### 2. JWT 無法撤銷

JWT 簽發後在有效期內無法主動撤銷，敏感操作需額外機制。

**解法**：(1) 使用短 TTL（如 15 分鐘），(2) 維護 Redis 黑名單，(3) 敏感操作改用 session。

### 3. 快取一致性問題

多個服務同時更新資料時，快取失效邏輯可能遺漏。

**解法**：(1) 使用事件機制（如 Redis Pub/Sub）通知快取失效，(2) 設定保守的 TTL，(3) 強一致性需求改用資料庫鎖。

### 4. 密碼明文儲存或弱雜湊

使用 MD5 或 SHA-1 儲存密碼極易被破解。

**解法**：使用 bcrypt（自動加鹽、可調整成本係數）或 Argon2。

```javascript
// ✅ bcrypt 儲存密碼
const bcrypt = require('bcrypt');
const hash = await bcrypt.hash(password, 10); // 成本係數 10
await db.user.create({ email, passwordHash: hash });

// 驗證
const valid = await bcrypt.compare(inputPassword, user.passwordHash);
```

### 5. SQL Injection

使用字串拼接 SQL 容易受攻擊。

**解法**：永遠使用 ORM 或 prepared statements。

```javascript
// ❌ SQL Injection 風險
const user = await db.query(`SELECT * FROM users WHERE email = '${email}'`);

// ✅ 使用參數化查詢
const user = await db.query('SELECT * FROM users WHERE email = ?', [email]);
```

### 6. 忘記設定 CORS

前端跨域請求被瀏覽器阻擋，後端沒正確配置 CORS。

**解法**：使用 `cors` middleware，生產環境指定白名單。

```javascript
const cors = require('cors');
app.use(cors({
  origin: ['https://example.com'], // 避免 '*'
  credentials: true // 允許 cookie
}));
```

### 7. 未限制請求大小

惡意使用者上傳巨大 JSON 癱瘓伺服器。

**解法**：設定 `body-parser` 限制。

```javascript
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
```

---

## 深度參考

需要 API 安全和進階設計模式時，讀取 `references/api-security.md`，涵蓋：
- JWT vs Session 比較 + JWT 最佳實踐
- 速率限制模式（Token Bucket + Redis）
- CORS 安全設定
- 輸入驗證模式（Zod Schema）
- API 版本控制策略
- 錯誤回應標準化（RFC 9457）
- 冪等性設計 + Webhook 安全
