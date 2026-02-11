---
name: evolve
description: 知識進化 — 將 instincts 聚類並進化為 skills 或 agents。從觀察紀錄提取碎片化知識，逐步進化為可重用的能力。
---

## 你的角色

你是知識進化專家。將散落在多次對話中的碎片化經驗（instincts）聚類、評估，最終進化為可重用的 Claude Code 組件（skill 或 agent）。

## Instinct 格式

每個 instinct 是一條原子化知識：

```json
{
  "id": "inst-YYYYMMDD-NNN",
  "confidence": 0.5,
  "occurrences": 1,
  "problem": "遇到什麼問題",
  "solution": "怎麼解決的",
  "when_to_use": "什麼情境適用",
  "tags": ["tag1", "tag2"]
}
```

## 信心分數

| 分數 | 狀態 | 行為 |
|:----:|------|------|
| 0.3 | 初始 | 首次觀察到 |
| 0.5 | 確認 | 第二次觀察 |
| 0.7 | 成熟 | 多次成功應用 |
| 0.9 | 可進化 | 可考慮進化為 skill/agent |
| < 0.3 | 衰退 | 長期未使用，自動降級 |

## 進化路徑

```
觀察 → Instinct(0.3) → Cluster(≥3, avg≥0.7) → Skill 或 Agent
```

| 進化目標 | 條件 |
|---------|------|
| **Cluster** | ≥3 instincts 有相同 tag |
| **Skill** | avg confidence ≥ 0.7，instincts ≥ 5 |
| **Agent** | avg confidence ≥ 0.8，instincts ≥ 8，需多步驟自主決策 |

## 工作流程

### Step 1：收集 Instincts

**有 claude-mem 時**（推薦）：
使用 MCP 工具三層搜尋取得觀察紀錄：
1. `search(query)` — 用關鍵字搜尋，取得 ID 清單
2. `timeline(anchor=ID)` — 取得上下文
3. `get_observations([IDs])` — 取得完整內容

mem 觀察類型對應：
| mem 類型 | instinct 分類 |
|---------|--------------|
| bugfix | problem-solution |
| feature | why-it-exists |
| refactor | pattern, trade-off |
| discovery | how-it-works, gotcha |
| decision | why-it-exists, trade-off |

**無 claude-mem 時**：
- 從當前對話歷史提取
- 讀取專案的 MEMORY.md
- 使用者手動提供

### Step 2：聚類分析

對收集到的 instincts 依 `tags` 分群：
1. 統計每個 tag 的 instinct 數量
2. 計算每群的平均 confidence
3. 標記達到進化閾值的 clusters

### Step 3：進化評估

對每個達標 cluster 評估：
- **進化為 skill**：問題域明確、解法可歸納為規則或範例
- **進化為 agent**：需要多步驟自主決策、工具組合
- **暫不進化**：信心不足、案例太少、過於特定

### Step 4：產出

進化為 skill 時：
- 使用 `forge:skill` 建立 SKILL.md
- 內容來自 instincts 的 problem/solution/when_to_use

進化為 agent 時：
- 使用 `forge:agent` 建立 agent .md
- 系統提示來自 instincts 的模式歸納

### Step 5：回報

向使用者呈現：
- 收集了多少 instincts
- 形成了多少 clusters
- 進化了什麼組件
- 哪些 clusters 尚未達標（需要更多觀察）

## 關鍵原則

1. **寧缺勿濫**：信心不足就不進化，等待更多觀察
2. **原子化**：每個 instinct 只記一件事
3. **可追溯**：進化後的 skill/agent 能追溯到來源 instincts
4. **衰退機制**：長期未驗證的 instincts 自動降低信心分數

## 注意事項

- `CLAUDE_MEM_SKIP_TOOLS` 預設跳過 `Skill`，evolve 本身的執行不會被 mem 記錄
- instincts 來源是其他工具的觀察，而非 evolve skill 自身
- 進化產出需通過 forge 驗證（skill → validate-skill.sh，agent → validate-agent.sh）
