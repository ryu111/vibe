# 各語言命名與組織慣例

> 本文件提供主流語言的命名規範、檔案組織和 import 排序慣例。

## TypeScript / JavaScript

### 命名

| 元素 | 慣例 | 範例 |
|------|------|------|
| 變數 / 函式 | camelCase | `getUserById`, `isActive` |
| 類別 / 介面 / 型別 | PascalCase | `UserService`, `ApiResponse` |
| 常數 | UPPER_SNAKE | `MAX_RETRY_COUNT` |
| 列舉值 | PascalCase | `Status.Active` |
| React 元件 | PascalCase | `UserCard`, `LoginForm` |
| Hook | use 前綴 + camelCase | `useAuth`, `useLocalStorage` |
| 檔案 | kebab-case | `user-service.ts` |
| React 元件檔案 | PascalCase 或 kebab-case | `UserCard.tsx` 或 `user-card.tsx` |
| 測試檔案 | `*.test.ts` / `*.spec.ts` | `user-service.test.ts` |

### Import 排序

```typescript
// 1. 外部套件（node_modules）
import React from 'react';
import { z } from 'zod';

// 2. 內部套件（alias）
import { db } from '@/lib/db';
import { UserCard } from '@/components/user-card';

// 3. 相對路徑
import { formatDate } from '../utils';
import { User } from './types';

// 4. 樣式
import styles from './page.module.css';
```

### 目錄結構

```
src/
├── app/          # 路由頁面（Next.js App Router）
├── components/   # 共用元件
├── lib/          # 核心函式庫
├── hooks/        # 自訂 hooks
├── utils/        # 工具函式
├── types/        # 共用型別
└── styles/       # 全域樣式
```

## Python

### 命名

| 元素 | 慣例 | 範例 |
|------|------|------|
| 變數 / 函式 | snake_case | `get_user_by_id`, `is_active` |
| 類別 | PascalCase | `UserService`, `ApiResponse` |
| 常數 | UPPER_SNAKE | `MAX_RETRY_COUNT` |
| 模組 / 套件 | snake_case | `user_service.py` |
| 私有 | 單底線前綴 | `_internal_method` |
| Name Mangling | 雙底線前綴 | `__secret` |
| 魔術方法 | 雙底線包圍 | `__init__`, `__str__` |
| 型別變數 | PascalCase | `T`, `KeyType` |

### Import 排序（isort）

```python
# 1. 標準庫
import os
import sys
from pathlib import Path

# 2. 第三方套件
import httpx
from fastapi import FastAPI, Depends
from pydantic import BaseModel

# 3. 本地模組
from app.models import User
from app.services.auth import verify_token
```

### 目錄結構

```
src/
├── app/
│   ├── __init__.py
│   ├── main.py          # 進入點
│   ├── models/          # 資料模型
│   ├── routers/         # API 路由
│   ├── services/        # 商業邏輯
│   ├── repositories/    # 資料存取
│   └── utils/           # 工具函式
├── tests/
│   ├── conftest.py      # 共用 fixtures
│   ├── test_models/
│   └── test_services/
└── pyproject.toml
```

## Go

### 命名

| 元素 | 慣例 | 範例 |
|------|------|------|
| 公開 | PascalCase | `GetUser`, `UserService` |
| 私有 | camelCase | `getUserFromDB` |
| 套件 | 全小寫，單字 | `user`, `auth`, `http` |
| 介面（單方法） | 方法名 + er | `Reader`, `Writer`, `Stringer` |
| 檔案 | snake_case | `user_service.go` |
| 測試檔案 | `*_test.go` | `user_service_test.go` |
| Acronyms | 全大寫或全小寫 | `HTTPClient`（公開）、`httpClient`（私有） |
| 接收者 | 1-2 字母縮寫 | `func (u *User) Name()` |

### Import 排序

```go
import (
    // 1. 標準庫
    "context"
    "fmt"
    "net/http"

    // 2. 第三方套件
    "github.com/gin-gonic/gin"
    "go.uber.org/zap"

    // 3. 本地模組
    "myapp/internal/models"
    "myapp/internal/services"
)
```

### 目錄結構

```
myapp/
├── cmd/              # 進入點（每個可執行檔一個目錄）
│   └── server/
│       └── main.go
├── internal/         # 私有套件（不可被外部 import）
│   ├── models/
│   ├── handlers/
│   ├── services/
│   └── repository/
├── pkg/              # 公開套件（可被外部使用）
├── api/              # API 定義（OpenAPI、protobuf）
└── go.mod
```

## Rust

### 命名

| 元素 | 慣例 | 範例 |
|------|------|------|
| 變數 / 函式 | snake_case | `get_user`, `is_valid` |
| 型別 / Trait | PascalCase | `UserService`, `Display` |
| 常數 | UPPER_SNAKE | `MAX_CONNECTIONS` |
| 模組 | snake_case | `user_service.rs` |
| Crate | kebab-case（Cargo.toml） | `my-project` |
| 生命週期 | 短小寫 | `'a`, `'static` |
| 巨集 | snake_case + `!` | `println!`, `vec!` |

## 通用原則

### 註解慣例

```
// ✅ 解釋「為什麼」
// 使用雙重檢查鎖定避免並發初始化

// ❌ 解釋「是什麼」（程式碼本身已說明）
// 取得使用者
const user = getUser(id);
```

### TODO 標籤

| 標籤 | 用途 |
|------|------|
| `TODO:` | 待完成的功能 |
| `FIXME:` | 已知 bug，待修復 |
| `HACK:` | 暫時方案，需重構 |
| `NOTE:` | 重要說明 |
| `PERF:` | 效能待優化 |

### Git Commit Message

```
<type>(<scope>): <subject>

<body>

<footer>
```

| Type | 用途 |
|------|------|
| feat | 新功能 |
| fix | Bug 修復 |
| docs | 文件更新 |
| style | 格式化（不影響邏輯） |
| refactor | 重構 |
| test | 測試 |
| chore | 建置、工具 |
| perf | 效能改善 |
