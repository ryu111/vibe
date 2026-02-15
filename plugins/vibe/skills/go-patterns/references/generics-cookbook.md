# Go 泛型實戰食譜

> 本文件涵蓋 Go 1.18+ 泛型的實用模式和標準庫泛型工具。

## 基本約束模式

### 內建約束（constraints 套件）

```go
import "golang.org/x/exp/constraints"

// 數值泛型函式
func Sum[T constraints.Integer | constraints.Float](nums []T) T {
    var total T
    for _, n := range nums {
        total += n
    }
    return total
}

// comparable 內建約束（可用 == 和 != 比較）
func Contains[T comparable](slice []T, target T) bool {
    for _, v := range slice {
        if v == target {
            return true
        }
    }
    return false
}
```

### 自訂約束介面

```go
// 聯合約束
type Number interface {
    int | int8 | int16 | int32 | int64 |
    float32 | float64
}

// 帶方法的約束
type Stringer interface {
    comparable
    String() string
}

// 近似約束（~ 允許底層型別匹配）
type Ordered interface {
    ~int | ~float64 | ~string
}

type MyInt int  // ~int 讓 MyInt 也符合 Ordered
```

## 標準庫泛型工具

### slices 套件（Go 1.21+）

```go
import "slices"

nums := []int{3, 1, 4, 1, 5, 9}

// 排序（取代 sort.Ints）
slices.Sort(nums)

// 搜尋（二分搜尋）
idx, found := slices.BinarySearch(nums, 4)

// 去重
unique := slices.Compact(slices.Clone(nums))

// 比較
slices.Equal([]int{1, 2}, []int{1, 2}) // true

// 自訂排序
slices.SortFunc(users, func(a, b User) int {
    return cmp.Compare(a.Name, b.Name)
})
```

### maps 套件（Go 1.21+）

```go
import "maps"

m := map[string]int{"a": 1, "b": 2}

// 取得所有鍵
keys := slices.Collect(maps.Keys(m))

// 取得所有值
vals := slices.Collect(maps.Values(m))

// 複製
clone := maps.Clone(m)

// 合併
maps.Copy(dst, src)

// 比較
maps.Equal(m1, m2)
```

### cmp 套件（Go 1.21+）

```go
import "cmp"

// 比較有序值
cmp.Compare(1, 2)         // -1
cmp.Compare("b", "a")     // 1

// 取較小/較大值
cmp.Or(0, 42)             // 42（第一個非零值）
min := cmp.Compare(a, b)
```

## 實用泛型模式

### 泛型 Result 型別

```go
type Result[T any] struct {
    Value T
    Err   error
}

func NewResult[T any](value T, err error) Result[T] {
    return Result[T]{Value: value, Err: err}
}

func (r Result[T]) Unwrap() (T, error) {
    return r.Value, r.Err
}

func Map[T, U any](r Result[T], fn func(T) U) Result[U] {
    if r.Err != nil {
        var zero U
        return Result[U]{Err: r.Err}
    }
    return Result[U]{Value: fn(r.Value)}
}
```

### 泛型 Optional 型別

```go
type Optional[T any] struct {
    value *T
}

func Some[T any](v T) Optional[T] {
    return Optional[T]{value: &v}
}

func None[T any]() Optional[T] {
    return Optional[T]{}
}

func (o Optional[T]) IsPresent() bool { return o.value != nil }
func (o Optional[T]) Get() (T, bool) {
    if o.value == nil {
        var zero T
        return zero, false
    }
    return *o.value, true
}

func (o Optional[T]) OrElse(fallback T) T {
    if o.value == nil {
        return fallback
    }
    return *o.value
}
```

### 泛型快取

```go
type Cache[K comparable, V any] struct {
    mu    sync.RWMutex
    items map[K]V
}

func NewCache[K comparable, V any]() *Cache[K, V] {
    return &Cache[K, V]{items: make(map[K]V)}
}

func (c *Cache[K, V]) Get(key K) (V, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    v, ok := c.items[key]
    return v, ok
}

func (c *Cache[K, V]) Set(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.items[key] = value
}
```

### 泛型 Pipeline / Map-Filter-Reduce

```go
func Map[T, U any](items []T, fn func(T) U) []U {
    result := make([]U, len(items))
    for i, item := range items {
        result[i] = fn(item)
    }
    return result
}

func Filter[T any](items []T, fn func(T) bool) []T {
    var result []T
    for _, item := range items {
        if fn(item) {
            result = append(result, item)
        }
    }
    return result
}

func Reduce[T, U any](items []T, init U, fn func(U, T) U) U {
    acc := init
    for _, item := range items {
        acc = fn(acc, item)
    }
    return acc
}
```

## 泛型最佳實踐

| 原則 | 說明 |
|------|------|
| 需要行為用 interface | 行為抽象用 interface，型別重用用 generics |
| 約束越精準越好 | `comparable` 比 `any` 好，自訂約束比 `comparable` 好 |
| 避免過度泛型化 | 只在 2+ 個型別需要時才用泛型 |
| 偏好標準庫 | `slices`、`maps`、`cmp` 比手寫快且正確 |
| 注意零值 | `var zero T` 取得型別零值，避免指標語意混淆 |
| 效能考量 | 泛型會產生特化程式碼（stenciling），大量實例化可能增加二進位大小 |

## 版本演進

| 版本 | 泛型相關變更 |
|------|------------|
| 1.18 | 泛型首次引入（TypeParams、constraints） |
| 1.21 | slices/maps/cmp 標準庫套件 |
| 1.22 | range over int、改進型別推斷 |
| 1.23 | range over function（iterators） |
| 1.24 | 泛型型別別名完整支援 |
| 1.25 | 移除 Core Types 概念，簡化約束模型 |
