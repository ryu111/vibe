---
name: python-patterns
description: >-
  Python 進階模式 — typing、async/await、dataclass、
  Protocol、FastAPI/Django 最佳實踐。
---

## Quick Reference

| 場景 | 推薦做法 |
|------|----------|
| 定義介面 | 使用 `Protocol`（結構型）而非 `ABC`（名義型） |
| 不可變資料類別 | `@dataclass(frozen=True, slots=True)` |
| 並行 async 任務 | `asyncio.TaskGroup`（Python 3.11+） |
| FastAPI 依賴注入 | `Depends()` + 型別標註 |
| Django 關聯查詢 | `select_related()`（1對1/外鍵）+ `prefetch_related()`（多對多） |
| 資料驗證 | Pydantic v2 `BaseModel` + `Field` |
| 型別泛型 | `TypeVar` + `Generic[T]` |
| 字面值型別 | `Literal["a", "b"]` 限定合法值 |

## Patterns

### Pattern 1: Protocol vs ABC（結構型 typing）

**何時使用**

需要定義介面但不想強制繼承時（Duck Typing + 型別檢查）。

**❌ BAD**

```python
from abc import ABC, abstractmethod

class Drawable(ABC):
    @abstractmethod
    def draw(self) -> None:
        pass

# 強制繼承才能通過型別檢查
class Circle(Drawable):
    def draw(self) -> None:
        print("Circle")
```

**✅ GOOD**

```python
from typing import Protocol

class Drawable(Protocol):
    def draw(self) -> None: ...

# 任何有 draw() 的類別都符合 Drawable
class Circle:
    def draw(self) -> None:
        print("Circle")

def render(obj: Drawable) -> None:
    obj.draw()

render(Circle())  # 型別檢查通過
```

**說明**

`Protocol` 提供結構型別（structural typing），符合 Python 的 Duck Typing 哲學，且無需改動既有類別。`ABC` 適合需要共享實作的場景。

### Pattern 2: dataclass(frozen=True, slots=True)

**何時使用**

不可變資料類別 + 記憶體最佳化。

**❌ BAD**

```python
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float

p = Point(1.0, 2.0)
p.x = 999  # 可被修改
p.z = 3.0  # 可新增任意屬性（__dict__ overhead）
```

**✅ GOOD**

```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class Point:
    x: float
    y: float

p = Point(1.0, 2.0)
# p.x = 999  # FrozenInstanceError
# p.z = 3.0  # AttributeError（無 __dict__）
```

**說明**

`frozen=True` 防止修改（immutable，可做 dict key），`slots=True`（Python 3.10+）減少記憶體消耗 ~40%。適合值物件（Value Object）。

### Pattern 3: async TaskGroup（Python 3.11+）

**何時使用**

並行執行多個 async 任務，需要等待全部完成或處理例外。

**❌ BAD**

```python
import asyncio

async def main():
    tasks = [
        asyncio.create_task(fetch(1)),
        asyncio.create_task(fetch(2)),
        asyncio.create_task(fetch(3)),
    ]
    # 手動管理 task 生命週期
    results = await asyncio.gather(*tasks, return_exceptions=True)
```

**✅ GOOD**

```python
import asyncio

async def main():
    async with asyncio.TaskGroup() as tg:
        task1 = tg.create_task(fetch(1))
        task2 = tg.create_task(fetch(2))
        task3 = tg.create_task(fetch(3))
    # 離開 context 時自動等待所有 task
    # 任一 task 失敗會立即取消其他 task
    results = [task1.result(), task2.result(), task3.result()]
```

**說明**

`TaskGroup` 提供結構化並行（Structured Concurrency），自動處理 task 取消和例外傳播，避免 task 洩漏。

### Pattern 4: FastAPI Dependency Injection

**何時使用**

需要共享資源（DB session、認證）或解耦商業邏輯。

**❌ BAD**

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/users/{user_id}")
async def get_user(user_id: int):
    db = Database()  # 每次手動建立
    user = db.query(user_id)
    db.close()
    return user
```

**✅ GOOD**

```python
from fastapi import FastAPI, Depends
from typing import Annotated

app = FastAPI()

async def get_db():
    db = Database()
    try:
        yield db
    finally:
        db.close()

@app.get("/users/{user_id}")
async def get_user(
    user_id: int,
    db: Annotated[Database, Depends(get_db)]
):
    return db.query(user_id)
```

**說明**

`Depends()` 實現依賴注入，自動管理資源生命週期。`Annotated` 保持型別提示清晰。適合 DB session、快取、認證等。

### Pattern 5: Django QuerySet 最佳化

**何時使用**

存取關聯物件時避免 N+1 查詢問題。

**❌ BAD**

```python
# N+1 queries: 1 查 posts + N 查每個 post 的 author
posts = Post.objects.all()
for post in posts:
    print(post.author.name)  # 每次都查 DB
```

**✅ GOOD**

```python
# 1 query（JOIN）
posts = Post.objects.select_related('author').all()
for post in posts:
    print(post.author.name)  # 已在記憶體

# 多對多用 prefetch_related（2 queries）
posts = Post.objects.prefetch_related('tags').all()
for post in posts:
    print([tag.name for tag in post.tags.all()])
```

**說明**

`select_related()` 用 SQL JOIN（1對1/外鍵），`prefetch_related()` 用 IN 查詢（多對多/反向外鍵）。效能差異可達 100 倍。

### Pattern 6: Pydantic v2 Model

**何時使用**

API 資料驗證、設定檔解析、型別強制。

**❌ BAD**

```python
def create_user(data: dict) -> dict:
    # 手動驗證
    if not isinstance(data.get("email"), str):
        raise ValueError("Invalid email")
    if data.get("age", 0) < 0:
        raise ValueError("Age must be positive")
    return data
```

**✅ GOOD**

```python
from pydantic import BaseModel, EmailStr, Field

class User(BaseModel):
    email: EmailStr
    age: int = Field(ge=0, le=150)
    name: str = Field(min_length=1, max_length=100)

    model_config = {"strict": True}  # Pydantic v2

# 自動驗證 + 型別轉換
user = User(email="test@example.com", age=25, name="Alice")
```

**說明**

Pydantic v2 使用 Rust core（效能提升 5-50 倍），`model_config` 取代 v1 的 `Config` 類別。`Field` 提供細粒度驗證。

### Pattern 7: TypeVar + Generic

**何時使用**

需要保留型別資訊的泛型容器或函式。

**❌ BAD**

```python
from typing import Any

class Stack:
    def __init__(self):
        self._items: list[Any] = []

    def push(self, item: Any) -> None:
        self._items.append(item)

    def pop(self) -> Any:  # 失去型別資訊
        return self._items.pop()
```

**✅ GOOD**

```python
from typing import TypeVar, Generic

T = TypeVar('T')

class Stack(Generic[T]):
    def __init__(self):
        self._items: list[T] = []

    def push(self, item: T) -> None:
        self._items.append(item)

    def pop(self) -> T:  # 保留型別
        return self._items.pop()

stack = Stack[int]()
stack.push(42)
value: int = stack.pop()  # 型別檢查器知道是 int
```

**說明**

`Generic[T]` 讓型別檢查器追蹤容器內元素型別，避免 `Any` 導致的型別遺失。適合集合類別、工廠函式。

### Pattern 8: async Generator

**何時使用**

需要非同步產生資料流（分頁、串流 API）。

**❌ BAD**

```python
async def fetch_all_pages(url: str) -> list[dict]:
    results = []
    page = 1
    while True:
        data = await fetch_page(url, page)
        if not data:
            break
        results.extend(data)  # 全部載入記憶體
        page += 1
    return results
```

**✅ GOOD**

```python
from typing import AsyncGenerator

async def fetch_pages(url: str) -> AsyncGenerator[dict, None]:
    page = 1
    while True:
        data = await fetch_page(url, page)
        if not data:
            break
        for item in data:
            yield item  # 逐項產生
        page += 1

# 使用
async for item in fetch_pages("https://api.example.com"):
    process(item)  # 串流處理
```

**說明**

async generator 避免一次載入所有資料，適合大型資料集或無限串流。記憶體消耗從 O(n) 降至 O(1)。

## Checklist

- [ ] 使用 `Protocol` 定義介面（結構型 typing）
- [ ] dataclass 加上 `frozen=True, slots=True`（不可變 + 記憶體最佳化）
- [ ] async 並行用 `TaskGroup`（Python 3.11+）
- [ ] FastAPI 用 `Depends()` 管理依賴
- [ ] Django 關聯查詢用 `select_related` / `prefetch_related`
- [ ] Pydantic v2 用 `model_config` 取代 `Config`
- [ ] 泛型函式/類別用 `TypeVar` + `Generic[T]`
- [ ] 避免 `Any` 型別（改用 `Protocol` 或 `TypeVar`）
- [ ] 大型資料流用 async generator
- [ ] 使用 `Literal` 限定字串/整數合法值

## 常見陷阱

### 1. 誤用 `list[int]` 在 runtime

```python
# ❌ TypeError: 'type' object is not subscriptable (Python 3.8)
def foo(items: list[int]) -> None:
    pass

# ✅ Python 3.9+ 原生支援，或用 typing.List
from typing import List
def foo(items: List[int]) -> None:  # Python 3.8 相容
    pass
```

### 2. async 函式忘記 await

```python
# ❌ 回傳 coroutine 物件，不執行
result = fetch_data()

# ✅ 實際執行
result = await fetch_data()
```

### 3. dataclass mutable default

```python
# ❌ 共享同一個 list 實例
@dataclass
class Config:
    tags: list[str] = []

# ✅ 使用 field(default_factory)
from dataclasses import field

@dataclass
class Config:
    tags: list[str] = field(default_factory=list)
```

### 4. Django QuerySet 重複 evaluate

```python
# ❌ 每次迴圈都重新查詢 DB
for i in range(10):
    posts = Post.objects.all()  # 10 次查詢

# ✅ 快取 QuerySet
posts = list(Post.objects.all())  # 1 次查詢
for i in range(10):
    process(posts)
```

### 5. Pydantic v2 的 Config 類別已棄用

```python
# ❌ Pydantic v2 不支援
class User(BaseModel):
    class Config:
        strict = True

# ✅ 使用 model_config
class User(BaseModel):
    model_config = {"strict": True}
```
