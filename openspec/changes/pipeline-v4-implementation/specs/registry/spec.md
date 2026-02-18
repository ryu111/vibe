# Registry 模組 Delta Spec

## ADDED Requirements

### Requirement: PIPELINE_ROUTE_REGEX

registry.js 新增 PIPELINE_ROUTE 正規表達式。

#### Scenario: 匹配合法 PIPELINE_ROUTE
WHEN 文字中包含 `<!-- PIPELINE_ROUTE: {...} -->`
THEN PIPELINE_ROUTE_REGEX 匹配並擷取 JSON 字串

---

## MODIFIED Requirements

### Requirement: VERDICT_REGEX 向後相容

**完整修改後內容**：

VERDICT_REGEX 在 Phase 0-4 保留（向後相容期間）。Phase 5 移除或標記 deprecated。新增 PIPELINE_ROUTE_REGEX 與 VERDICT_REGEX 並存。

### Requirement: DAG 節點結構擴充

**完整修改後內容**：

v4 的 DAG 節點從 v3 的 `{ deps: string[] }` 擴充為：

```javascript
{
  deps: string[],       // 前驅依賴（v3 保留）
  next: string[],       // 後繼節點（v4 新增）
  onFail: string|null,  // QUALITY FAIL 時回退目標（v4 新增）
  maxRetries: number,   // 最大重試次數（v4 新增，預設 3）
  barrier: {            // 並行 barrier 配置（v4 新增，非並行為 null）
    group: string,
    total: number,
    siblings: string[]
  } | null
}
```

---

## REMOVED Requirements

（無移除 — 過渡期保留 VERDICT_REGEX，Phase 5 移除）
