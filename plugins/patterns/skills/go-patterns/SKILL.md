---
name: go-patterns
description: >-
  Go 進階模式 — error handling、concurrency（goroutines/channels）、
  interface design、testing patterns。
---

## Quick Reference

| 場景 | 推薦做法 |
|------|---------|
| 錯誤處理 | 使用 `fmt.Errorf` 配合 `%w` 包裹錯誤；定義 sentinel errors 用 `errors.Is` |
| 錯誤類型檢查 | 使用 `errors.As` 而非 type assertion |
| 並發控制 | 使用 `context.Context` 傳遞取消信號；用 `sync.WaitGroup` 等待 goroutines |
| Channel 使用 | 建立者負責關閉 channel；避免從多處關閉同一 channel |
| Interface 設計 | 接受 interface、回傳 struct；保持 interface 小而專一 |
| 測試結構 | 使用 table-driven tests；子測試用 `t.Run()` |
| 選項模式 | 使用 Functional Options Pattern 處理可選參數 |
| 資源清理 | 使用 `defer` 確保資源釋放；注意 defer 在迴圈中的行為 |

## Patterns

### Pattern 1: Error Wrapping

**何時使用**：需要為錯誤添加上下文資訊，同時保留原始錯誤以便上層判斷錯誤類型。

**❌ BAD**
```go
func readConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        // 丟失原始錯誤資訊
        return nil, fmt.Errorf("failed to read config")
    }
    // ...
}

// 呼叫方無法判斷是否為 os.ErrNotExist
if err != nil {
    // 無法區分錯誤類型
}
```

**✅ GOOD**
```go
func readConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        // 使用 %w 保留原始錯誤
        return nil, fmt.Errorf("failed to read config from %s: %w", path, err)
    }
    // ...
}

// 呼叫方可以使用 errors.Is 判斷
if err != nil {
    if errors.Is(err, os.ErrNotExist) {
        // 處理檔案不存在
    }
}
```

**說明**：使用 `%w` verb 包裹錯誤可以保留錯誤鏈，讓上層程式碼使用 `errors.Is` 和 `errors.As` 進行錯誤判斷。這是 Go 1.13+ 的標準做法。

### Pattern 2: Context 傳遞和取消

**何時使用**：需要在多個 goroutine 間傳遞取消信號、deadline 或 request-scoped 值。

**❌ BAD**
```go
func fetchData(url string) ([]byte, error) {
    // 沒有 timeout，可能永久阻塞
    resp, err := http.Get(url)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    return io.ReadAll(resp.Body)
}

// 無法取消長時間運行的操作
go fetchData("https://slow-api.example.com")
```

**✅ GOOD**
```go
func fetchData(ctx context.Context, url string) ([]byte, error) {
    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, err
    }

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    return io.ReadAll(resp.Body)
}

// 使用時可以設定 timeout
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
data, err := fetchData(ctx, "https://api.example.com")
```

**說明**：將 `context.Context` 作為第一個參數傳遞是 Go 的慣例。Context 應該從上層流向下層，並在適當時機呼叫 `cancel()` 釋放資源。

### Pattern 3: Channel Fan-Out/Fan-In Pattern

**何時使用**：需要將工作分散到多個 worker goroutine（fan-out），然後收集結果（fan-in）。

**❌ BAD**
```go
func processItems(items []Item) []Result {
    results := make([]Result, len(items))
    for i, item := range items {
        // 序列處理，無法利用並發
        results[i] = process(item)
    }
    return results
}
```

**✅ GOOD**
```go
func processItems(items []Item) []Result {
    jobs := make(chan Item, len(items))
    results := make(chan Result, len(items))

    // Fan-out: 啟動多個 worker
    const numWorkers = 5
    var wg sync.WaitGroup
    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for item := range jobs {
                results <- process(item)
            }
        }()
    }

    // 發送工作
    for _, item := range items {
        jobs <- item
    }
    close(jobs)

    // 等待所有 worker 完成並關閉結果 channel
    go func() {
        wg.Wait()
        close(results)
    }()

    // Fan-in: 收集結果
    var output []Result
    for result := range results {
        output = append(output, result)
    }
    return output
}
```

**說明**：這是 Go 並發的經典模式。注意：(1) 建立 channel 的 goroutine 負責關閉它 (2) 使用 `sync.WaitGroup` 等待所有 worker 完成 (3) 在另一個 goroutine 中關閉 results channel，避免阻塞主流程。

### Pattern 4: Interface Segregation

**何時使用**：設計函式或方法時，只依賴所需的最小介面，而非具體類型。

**❌ BAD**
```go
// 依賴具體類型，難以測試和擴展
func SaveUser(db *sql.DB, user *User) error {
    _, err := db.Exec("INSERT INTO users ...")
    return err
}

// 介面過大，包含不需要的方法
type Storage interface {
    Save(user *User) error
    Delete(id int) error
    List() ([]*User, error)
    Migrate() error
    Backup() error
}

func ProcessUser(s Storage, user *User) error {
    // 只用到 Save，但要求整個 Storage 介面
    return s.Save(user)
}
```

**✅ GOOD**
```go
// 定義小而專一的介面
type UserSaver interface {
    SaveUser(user *User) error
}

// 函式接受介面，易於測試和擴展
func SaveUser(saver UserSaver, user *User) error {
    return saver.SaveUser(user)
}

// 測試時可以輕鬆 mock
type mockSaver struct{}
func (m *mockSaver) SaveUser(user *User) error { return nil }

// 也可以使用標準庫介面
func WriteLog(w io.Writer, msg string) error {
    _, err := fmt.Fprintln(w, msg)
    return err
}
```

**說明**：Go 的 interface 是隱式實作的（implicit），應該在使用方定義小介面，而非在實作方定義大介面。遵循 "accept interfaces, return structs" 原則。

### Pattern 5: Table-Driven Tests

**何時使用**：需要測試多組輸入輸出組合，或相同邏輯的不同情境。

**❌ BAD**
```go
func TestAdd(t *testing.T) {
    result := Add(2, 3)
    if result != 5 {
        t.Errorf("expected 5, got %d", result)
    }

    result = Add(-1, 1)
    if result != 0 {
        t.Errorf("expected 0, got %d", result)
    }

    // 重複的測試程式碼，難以維護
}
```

**✅ GOOD**
```go
func TestAdd(t *testing.T) {
    tests := []struct {
        name     string
        a, b     int
        expected int
    }{
        {"positive numbers", 2, 3, 5},
        {"negative and positive", -1, 1, 0},
        {"zeros", 0, 0, 0},
        {"large numbers", 1000, 2000, 3000},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            result := Add(tt.a, tt.b)
            if result != tt.expected {
                t.Errorf("Add(%d, %d) = %d; want %d",
                    tt.a, tt.b, result, tt.expected)
            }
        })
    }
}
```

**說明**：Table-driven tests 是 Go 測試的標準模式。使用 `t.Run()` 建立子測試，可以單獨執行某個測試案例（`go test -run TestAdd/positive`），且失敗時有清楚的測試名稱。

### Pattern 6: Functional Options Pattern

**何時使用**：建構物件時需要多個可選參數，且未來可能新增更多選項。

**❌ BAD**
```go
// 使用 config struct，但零值有歧義
type Server struct {
    Port    int
    Timeout time.Duration
    TLS     bool
}

func NewServer(port int, timeout time.Duration, tls bool) *Server {
    // 呼叫方必須提供所有參數，即使使用預設值
    return &Server{Port: port, Timeout: timeout, TLS: tls}
}

// 使用時不清楚哪些是預設值
s := NewServer(8080, 0, false)
```

**✅ GOOD**
```go
type Server struct {
    port    int
    timeout time.Duration
    tls     bool
}

type Option func(*Server)

func WithPort(port int) Option {
    return func(s *Server) { s.port = port }
}

func WithTimeout(timeout time.Duration) Option {
    return func(s *Server) { s.timeout = timeout }
}

func WithTLS(enabled bool) Option {
    return func(s *Server) { s.tls = enabled }
}

func NewServer(opts ...Option) *Server {
    // 設定預設值
    s := &Server{
        port:    8080,
        timeout: 30 * time.Second,
        tls:     false,
    }

    // 應用選項
    for _, opt := range opts {
        opt(s)
    }
    return s
}

// 使用時語義清晰，且可擴展
s := NewServer(
    WithPort(9000),
    WithTimeout(60*time.Second),
)
```

**說明**：Functional Options Pattern 讓 API 既有彈性又保持向後相容。新增選項時不需要修改函式簽章，且呼叫方可以選擇性提供參數。

### Pattern 7: Defer for Resource Cleanup

**何時使用**：需要確保資源（檔案、鎖、連線）在函式返回前被釋放。

**❌ BAD**
```go
func processFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }

    data, err := io.ReadAll(f)
    if err != nil {
        // 忘記關閉檔案就返回了
        return err
    }

    f.Close()
    return process(data)
}

// 迴圈中使用 defer 會累積
func processFiles(paths []string) error {
    for _, path := range paths {
        f, _ := os.Open(path)
        defer f.Close() // 所有檔案都在函式結束時才關閉
        // ...
    }
    return nil
}
```

**✅ GOOD**
```go
func processFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close() // 確保檔案被關閉

    data, err := io.ReadAll(f)
    if err != nil {
        return err
    }

    return process(data)
}

// 迴圈中使用匿名函式包裹 defer
func processFiles(paths []string) error {
    for _, path := range paths {
        if err := func() error {
            f, err := os.Open(path)
            if err != nil {
                return err
            }
            defer f.Close() // 每次迴圈結束時關閉

            // 處理檔案...
            return nil
        }(); err != nil {
            return err
        }
    }
    return nil
}
```

**說明**：`defer` 是 Go 管理資源的慣用方式，應緊接在取得資源後宣告。注意 defer 在迴圈中的行為：所有 defer 會在函式返回時執行，可能導致資源累積。

## Checklist

審查 Go 程式碼時，檢查以下項目：

- [ ] 錯誤處理是否使用 `%w` 包裹，讓呼叫方能判斷錯誤類型
- [ ] 長時間運行的操作是否接受 `context.Context` 參數
- [ ] Goroutines 是否有明確的退出條件，避免 goroutine 洩漏
- [ ] Channel 是否由建立者負責關閉，且不會從多處關閉
- [ ] 公開 API 是否接受介面而非具體類型（accept interfaces, return structs）
- [ ] 測試是否使用 table-driven 結構，涵蓋正常和邊界情況
- [ ] 資源（檔案、連線、鎖）是否使用 `defer` 確保釋放
- [ ] 是否避免在迴圈中直接使用 `defer`，或使用匿名函式包裹
- [ ] 匯出的型別和函式是否有 godoc 註解
- [ ] 是否使用 `go fmt` 格式化程式碼，遵循社群風格

## 常見陷阱

### 1. Goroutine 洩漏

```go
// ❌ channel 沒有被消費，goroutine 永久阻塞
func leak() <-chan int {
    ch := make(chan int)
    go func() {
        ch <- 42 // 如果沒有接收者，這裡會永久阻塞
    }()
    return ch
}

// ✅ 使用 buffered channel 或確保有消費者
func noLeak() <-chan int {
    ch := make(chan int, 1) // buffered
    go func() {
        ch <- 42
    }()
    return ch
}
```

### 2. 迴圈變數捕獲

```go
// ❌ 所有 goroutine 共享同一個迴圈變數
for _, item := range items {
    go func() {
        process(item) // 捕獲到的是迴圈變數，可能都是最後一個值
    }()
}

// ✅ 傳遞參數或使用 Go 1.22+ 的新語義
for _, item := range items {
    go func(i Item) {
        process(i)
    }(item)
}
```

### 3. Slice 的底層陣列共享

```go
// ❌ append 可能修改原始 slice 的底層陣列
func addItem(slice []int, item int) []int {
    return append(slice, item) // 如果容量足夠，會修改原陣列
}

original := make([]int, 0, 10)
modified := addItem(original, 42)
// original 的底層陣列可能被修改

// ✅ 明確複製或使用完整 slice 表達式
func addItem(slice []int, item int) []int {
    result := make([]int, len(slice), len(slice)+1)
    copy(result, slice)
    return append(result, item)
}
```

### 4. 錯誤的 nil 檢查

```go
// ❌ interface 包含型別資訊，即使值為 nil
func returnsError() error {
    var err *MyError = nil
    return err // error 不是 nil！
}

if err := returnsError(); err != nil {
    // 會進入這裡，即使實際錯誤值為 nil
}

// ✅ 回傳明確的 nil 或非 nil error
func returnsError() error {
    var err *MyError = nil
    if err == nil {
        return nil // 明確回傳 nil
    }
    return err
}
```

### 5. 忘記處理 WaitGroup.Wait() 的阻塞

```go
// ❌ 主 goroutine 在 channel 接收時阻塞，wg.Wait() 永不執行
func broken() []Result {
    var wg sync.WaitGroup
    results := make(chan Result)

    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            results <- compute()
        }()
    }

    var output []Result
    for r := range results { // 阻塞：channel 永不關閉
        output = append(output, r)
    }

    wg.Wait() // 永遠不會執行到這裡
    return output
}

// ✅ 在單獨的 goroutine 中等待並關閉 channel
func fixed() []Result {
    var wg sync.WaitGroup
    results := make(chan Result, 10)

    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            results <- compute()
        }()
    }

    go func() {
        wg.Wait()
        close(results) // 所有 worker 完成後關閉 channel
    }()

    var output []Result
    for r := range results {
        output = append(output, r)
    }
    return output
}
```

