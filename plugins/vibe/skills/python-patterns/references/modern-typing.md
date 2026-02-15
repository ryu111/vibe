# Python 現代型別系統（3.12+）

> 本文件涵蓋 Python 3.12 和 3.13 引入的新型別語法和模式。

## Python 3.12：新型別參數語法（PEP 695）

### 泛型函式

```python
# 舊語法（3.11 以前）
from typing import TypeVar
T = TypeVar('T')
def first(items: list[T]) -> T: ...

# 新語法（3.12+）
def first[T](items: list[T]) -> T: ...
```

### 泛型類別

```python
# 舊語法
from typing import TypeVar, Generic
T = TypeVar('T')
class Stack(Generic[T]):
    def push(self, item: T) -> None: ...

# 新語法（3.12+）
class Stack[T]:
    def push(self, item: T) -> None: ...
```

### 帶約束的 TypeVar

```python
# 上限約束
def process[T: Hashable](item: T) -> T: ...

# 聯合約束
def stringify[T: (int, float, str)](value: T) -> str: ...
```

### type 陳述式（型別別名）

```python
# 舊語法
from typing import TypeAlias
Vector: TypeAlias = list[float]

# 新語法（3.12+）— 支援延遲求值
type Vector = list[float]
type Tree[T] = T | list[Tree[T]]  # 遞迴型別！
```

### ParamSpec 新語法

```python
# 舊語法
from typing import ParamSpec, Callable
P = ParamSpec('P')

# 新語法（3.12+）
type IntFunc[**P] = Callable[P, int]
```

### TypeVarTuple 新語法

```python
# 舊語法
from typing import TypeVarTuple
Ts = TypeVarTuple('Ts')

# 新語法（3.12+）
type LabeledTuple[*Ts] = tuple[str, *Ts]
```

## Python 3.13：型別參數預設值（PEP 696）

```python
# TypeVar 預設值
class Response[T = dict]:
    data: T

r1: Response       # T = dict（使用預設）
r2: Response[str]  # T = str（顯式指定）

# ParamSpec 預設值
class Handler[**P = [int, str]]:
    def call(self, *args: P.args, **kwargs: P.kwargs) -> None: ...
```

## Python 3.13：TypeIs（PEP 742）

比 TypeGuard 更直覺的型別窄化：

```python
from typing import TypeIs

# TypeGuard 的問題：只窄化 True 分支
def is_str_guard(val: object) -> TypeGuard[str]:
    return isinstance(val, str)

# TypeIs 的改進：同時窄化 True 和 False 分支
def is_str(val: str | int) -> TypeIs[str]:
    return isinstance(val, str)

def process(val: str | int) -> None:
    if is_str(val):
        val.upper()    # val: str ✅
    else:
        val + 1        # val: int ✅（TypeGuard 做不到）
```

## Python 3.13：ReadOnly TypedDict（PEP 705）

```python
from typing import TypedDict, ReadOnly

class Config(TypedDict):
    name: str                # 可讀寫
    version: ReadOnly[str]   # 唯讀

config: Config = {"name": "app", "version": "1.0"}
config["name"] = "new"      # ✅
config["version"] = "2.0"   # ❌ 型別錯誤
```

## 實用進階模式

### Protocol 結合泛型

```python
from typing import Protocol, runtime_checkable

@runtime_checkable
class Comparable[T](Protocol):
    def __lt__(self, other: T) -> bool: ...
    def __eq__(self, other: object) -> bool: ...

def sort_items[T: Comparable](items: list[T]) -> list[T]:
    return sorted(items)
```

### dataclass 進階用法

```python
from dataclasses import dataclass, field

@dataclass(frozen=True, slots=True, kw_only=True)
class Config:
    host: str = "localhost"
    port: int = 8080
    tags: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.port < 0 or self.port > 65535:
            raise ValueError(f"不合法的 port: {self.port}")
```

### 結構化並發（Python 3.11+）

```python
import asyncio

async def fetch_all(urls: list[str]) -> list[str]:
    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(fetch(url)) for url in urls]
    # TaskGroup 確保所有任務完成或全部取消
    return [t.result() for t in tasks]

# 對比舊的 gather（不會在例外時取消其他任務）
# results = await asyncio.gather(*tasks)
```

### match/case 模式匹配（3.10+）

```python
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float

def describe(shape: Point | tuple[Point, ...]) -> str:
    match shape:
        case Point(x=0, y=0):
            return "原點"
        case Point(x, y) if x == y:
            return f"對角線上 ({x})"
        case [Point(), Point(), *rest]:
            return f"多邊形，{2 + len(rest)} 個頂點"
        case _:
            return "未知形狀"
```

## 版本特性對照表

| 版本 | 主要型別特性 |
|------|------------|
| 3.10 | match/case、ParamSpec、TypeAlias |
| 3.11 | Self、LiteralString、TypeVarTuple、TaskGroup |
| 3.12 | 型別參數語法（`def f[T]`）、type 陳述式、override |
| 3.13 | TypeVar 預設值、TypeIs、ReadOnly TypedDict |
| 3.14 | TypeForm（PEP 747）、延遲標註求值 |
