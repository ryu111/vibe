# API 安全與設計進階模式

> 本文件涵蓋 SKILL.md 未深入的 API 安全實作和進階設計模式。

## 認證模式比較

### JWT vs Session

| 面向 | JWT | Session |
|------|-----|---------|
| 狀態 | 無狀態（token 自含資訊） | 有狀態（server 儲存 session） |
| 水平擴展 | ✅ 天然支援（不需共享儲存） | 需要 Redis 等共享 session store |
| 撤銷 | ❌ 困難（需黑名單或短 TTL） | ✅ 刪除 session 立即失效 |
| 大小 | 較大（含 payload） | 較小（只有 session ID） |
| XSS 風險 | 高（存 localStorage）→ 用 httpOnly cookie | 低（httpOnly cookie） |
| CSRF 風險 | 低（Authorization header） | 需要 CSRF token |
| 適用場景 | API-to-API、微服務 | 傳統 Web 應用 |

### JWT 最佳實踐

```javascript
// ✅ 正確的 JWT 設定
const token = jwt.sign(payload, secret, {
  expiresIn: '15m',        // 短期 access token
  algorithm: 'RS256',       // 非對稱加密（公鑰驗證）
  issuer: 'auth-service',
  audience: 'api-service',
});

// ✅ Refresh Token 策略
// Access Token: 15 分鐘（記憶體 / httpOnly cookie）
// Refresh Token: 7 天（httpOnly + secure + sameSite cookie）

// ❌ 常見錯誤
jwt.sign(payload, secret);                // 未設過期時間
jwt.sign(payload, secret, { algorithm: 'none' });  // 不安全演算法
```

## 速率限制模式

### Token Bucket（推薦）

```javascript
// 使用 Redis 實作 Token Bucket
const RATE_LIMIT = { tokens: 100, interval: 60 }; // 每分鐘 100 請求

async function rateLimit(userId) {
  const key = `rate:${userId}`;
  const now = Date.now();

  // Lua 腳本保證原子操作
  const result = await redis.eval(`
    local tokens = tonumber(redis.call('get', KEYS[1]) or ARGV[1])
    local lastRefill = tonumber(redis.call('get', KEYS[2]) or ARGV[3])
    local elapsed = tonumber(ARGV[3]) - lastRefill
    local refill = math.floor(elapsed / 1000 * (tonumber(ARGV[1]) / tonumber(ARGV[2])))
    tokens = math.min(tonumber(ARGV[1]), tokens + refill)

    if tokens > 0 then
      redis.call('set', KEYS[1], tokens - 1)
      redis.call('set', KEYS[2], ARGV[3])
      return 1
    end
    return 0
  `, 2, key, `${key}:ts`, RATE_LIMIT.tokens, RATE_LIMIT.interval, now);

  return result === 1;
}
```

### 回應標頭

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1706745600
Retry-After: 30
```

## CORS 安全設定

```javascript
// ✅ 精確設定
const corsOptions = {
  origin: ['https://app.example.com', 'https://admin.example.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400, // preflight 快取 24 小時
};

// ❌ 常見不安全設定
app.use(cors({ origin: '*' }));                    // 允許所有來源
app.use(cors({ origin: true, credentials: true })); // 洩漏認證
```

## 輸入驗證模式

### Zod Schema 驗證（推薦）

```typescript
import { z } from 'zod';

const CreateUserSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  email: z.string().email().toLowerCase(),
  age: z.number().int().min(0).max(150).optional(),
  role: z.enum(['user', 'admin']).default('user'),
});

// Middleware 驗證
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        details: result.error.flatten(),
      });
    }
    req.validated = result.data;
    next();
  };
}

app.post('/users', validate(CreateUserSchema), createUser);
```

## API 版本控制策略

| 策略 | 格式 | 優點 | 缺點 |
|------|------|------|------|
| URL Path | `/v1/users` | 直觀、易快取 | URL 膨脹 |
| Query Param | `/users?v=1` | 簡單 | 易被忽略 |
| Header | `Accept: application/vnd.api+json;v=1` | 乾淨 URL | 不直觀 |
| Content Negotiation | `Accept: application/vnd.company.v1+json` | REST 正統 | 複雜 |

**推薦**：URL Path（`/v1/users`）— 最直觀，CDN 友好。

## 錯誤回應標準化

### RFC 9457（Problem Details）

```json
{
  "type": "https://api.example.com/errors/validation",
  "title": "Validation Error",
  "status": 422,
  "detail": "Email 格式不正確",
  "instance": "/users/123",
  "errors": [
    {
      "field": "email",
      "message": "必須是有效的 email 地址",
      "code": "INVALID_FORMAT"
    }
  ]
}
```

### HTTP Status Code 速查

| 場景 | Status Code |
|------|:-----------:|
| 成功建立 | 201 Created |
| 成功但無內容 | 204 No Content |
| 驗證失敗 | 422 Unprocessable Entity |
| 未認證 | 401 Unauthorized |
| 無權限 | 403 Forbidden |
| 找不到 | 404 Not Found |
| 衝突（如重複） | 409 Conflict |
| 速率限制 | 429 Too Many Requests |
| 伺服器錯誤 | 500 Internal Server Error |

## 冪等性設計

```javascript
// 用 Idempotency-Key 確保重複請求安全
app.post('/payments', async (req, res) => {
  const key = req.headers['idempotency-key'];
  if (!key) return res.status(400).json({ error: '需要 Idempotency-Key' });

  // 檢查是否已處理
  const cached = await redis.get(`idempotency:${key}`);
  if (cached) return res.json(JSON.parse(cached));

  // 處理請求
  const result = await processPayment(req.body);

  // 快取結果（24 小時）
  await redis.setex(`idempotency:${key}`, 86400, JSON.stringify(result));
  res.json(result);
});
```

## Webhook 安全

```javascript
// 簽名驗證
import crypto from 'crypto';

function verifyWebhook(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(`sha256=${expected}`)
  );
}
```
