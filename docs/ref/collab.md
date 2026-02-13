# collab — 多視角競爭分析

> **優先級**：低（最後建構）
> **定位**：多視角競爭分析 — Agent Teams 驅動的對抗式審查與重構
> **前身**：ECC /multi-plan + /multi-execute（原設計為跨模型協作，已改為 Agent Teams 優先）

---

## 1. 概述

collab 是 Vibe marketplace 的多視角競爭分析 plugin。它利用 **Agent Teams**（多個獨立 Claude 實例）組成專門團隊，從不同角度同時分析同一程式碼或計畫，透過**觀點競爭**產出更全面的結論。

核心理念：**分歧即價值 — 多個 Claude 各自獨立分析，分歧點是最值得關注的地方。**

### 設計轉變

| | 舊設計（v0，未實作） | 新設計（v1） |
|---|---|----|
| **機制** | 外部模型 API（Codex、Gemini） | Agent Teams（多 Claude 實例） |
| **門檻** | 需 API key + 外部 CLI | 只需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |
| **核心價值** | 不同模型的差異觀點 | 不同角色/視角的差異觀點 |
| **可靠度** | 受限於外部 API 穩定性 | 原生 Claude Code 功能 |

轉變原因：Agent Teams 覆蓋了原設計 ~80% 的價值（交叉驗證、多視角分析），且零外部依賴。

### 與其他 plugin 的關係

- **sentinel** 的 `/vibe:review` 是單一視角的程式碼審查 → collab 的 `adversarial-review` 是多視角對抗式審查
- **flow** 的 `/vibe:plan` 是單一視角的計畫 → collab 的 `adversarial-plan` 是多視角競爭規劃
- **未來考量**：collab 的能力可逐步合併進 sentinel 和 flow，作為進階模式

### 前置條件

| 條件 | 必要性 | 說明 |
|------|:------:|------|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | **必要** | 啟用 Agent Teams 實驗性功能 |
| 外部模型 API key | 可選 | 未來增強：引入外部模型做額外交叉驗證 |

---

## 2. 設計目標

| # | 目標 | 說明 |
|:-:|------|------|
| 1 | **角色分離** | 每個隊友扮演不同審查角色（安全、效能、架構、可維護性） |
| 2 | **獨立分析** | 隊友各自獨立分析，不受彼此影響（隊友不繼承主管對話歷史） |
| 3 | **對抗式發現** | 刻意從不同角度審查，分歧點自動標記 |
| 4 | **共識排序** | 多隊友共識 > 單一發現 → 按共識度 × 嚴重程度排序 |
| 5 | **主管整合** | Team Lead 收集所有隊友結果，合併產出最終報告 |

---

## 3. 組件清單

| 類型 | 名稱 | 說明 |
|------|------|------|
| **Skill** | `adversarial-plan` | 對抗式規劃 — 多視角競爭產出最佳方案 |
| **Skill** | `adversarial-review` | 對抗式審查 — 多角色同時審查程式碼 |
| **Skill** | `adversarial-refactor` | 對抗式重構 — 多方案競爭重構程式碼 |
| **Hook** | TaskCompleted | 任務完成通知 — 收集隊友結果 |

---

## 4. Skills 設計

### 4.1 adversarial-plan — 對抗式規劃

```yaml
name: adversarial-plan
description: >
  對抗式規劃 — 組建 Agent Team，多個 Claude 各自獨立擬定方案，再由主管合併最佳策略。
  觸發詞：adversarial-plan、對抗式規劃、競爭規劃、多方案規劃。
```

**能力範圍**：

| 能力 | 說明 |
|------|------|
| 團隊組建 | 根據任務性質組建 2-3 人團隊，各有不同立場 |
| 獨立規劃 | 每個隊友各自產出完整方案 |
| 差異對比 | 主管對比各方案的分歧點 |
| 最優合併 | 擷取各方案優點，合併最終版本 |

**Agent Teams 配置**：

```
Team Lead（主管）：Shift+Tab 委派模式 — 只協調不寫碼
├── Teammate A「架構師」：偏好簡潔、高效能、最小依賴
├── Teammate B「工程師」：偏好可維護性、測試友善、漸進式
└── Teammate C「挑戰者」：主動找漏洞、質疑假設、提出反例
```

**UX 流程**：

```
Step 1: 使用者描述需求
  └── 主管分析需求，決定團隊配置

Step 2: 委派任務（Shift+Tab 委派模式）
  ├── 每個隊友收到相同需求 + 不同立場指示
  └── 隊友獨立產出方案（不互通）

Step 3: 收集方案（TeammateIdle 事件）
  └── 主管讀取每個隊友的產出

Step 4: 差異報告
  ├── 共識（所有方案同意）→ 高信心，直接採用
  ├── 分歧（方案不同）→ 標示供使用者判斷
  └── 獨特觀點（只有一個方案提出）→ 值得考慮

Step 5: 最終方案
  └── 主管整合各方優點 → 產出最終計畫
```

---

### 4.2 adversarial-review — 對抗式審查

```yaml
name: adversarial-review
description: >
  對抗式審查 — 組建審查團隊，多個 Claude 從不同角度同時審查程式碼。
  觸發詞：adversarial-review、對抗式審查、多角度審查、競爭審查。
```

**能力範圍**：

| 能力 | 說明 |
|------|------|
| 程式碼收集 | 收集待審查的程式碼（git diff 或指定範圍） |
| 角色分工 | 每個隊友專注不同面向 |
| 平行審查 | 隊友同時獨立審查 |
| 共識分析 | 合併結果，按共識度排序 |

**Agent Teams 配置**：

```
Team Lead（主管）：收集結果 + 產出報告
├── Teammate「安全審查員」：OWASP Top 10、注入、權限、加密
├── Teammate「效能審查員」：N+1 查詢、記憶體洩漏、演算法複雜度
└── Teammate「架構審查員」：耦合度、SRP、DRY、可測試性
```

**UX 流程**：

```
Step 1: 收集程式碼
  └── git diff 或使用者指定範圍

Step 2: 平行審查
  ├── 每個隊友收到相同程式碼 + 專屬審查角度
  └── 各自獨立產出 findings 列表

Step 3: 結果合併
  ├── 共識（≥2 隊友同意）→ 高信心
  ├── 分歧（隊友意見相反）→ 標示爭議
  └── 獨特發現（只有一個隊友提出）→ 需驗證

Step 4: 產出報告
  └── 按 共識度 × 嚴重程度 排序
      CRITICAL（共識）> CRITICAL（單一）> HIGH（共識）> ...
```

**結果格式**：

```markdown
## 對抗式審查報告

### 共識發現（高信心）
- [CRITICAL] SQL 注入風險 — db/queries.ts:42（安全 + 架構 同意）
- [HIGH] 未處理的 Promise rejection — api/handler.ts:18（安全 + 效能 同意）

### 分歧（需使用者判斷）
- db/models.ts:55 — 安全審查員建議加密，效能審查員認為影響查詢速度
  → 安全觀點：PII 欄位必須加密
  → 效能觀點：加密增加 30% 查詢延遲，建議應用層處理

### 獨特發現（待驗證）
- [MEDIUM] 過度耦合 — 只有架構審查員提出，建議二次確認
```

---

### 4.3 adversarial-refactor — 對抗式重構

```yaml
name: adversarial-refactor
description: >
  對抗式重構 — 多個 Claude 各自提出重構方案，競爭產出最佳實作。
  觸發詞：adversarial-refactor、對抗式重構、競爭重構、多方案重構。
```

**能力範圍**：

| 能力 | 說明 |
|------|------|
| 目標分析 | 分析待重構的程式碼和目標 |
| 方案競爭 | 每個隊友各自產出完整重構實作 |
| 品質評估 | 主管從可讀性、效能、測試、相容性評估各方案 |
| 最優選擇 | 選出最佳方案或合併多個方案的優點 |

**Agent Teams 配置**：

```
Team Lead（主管）：Shift+Tab 委派模式 — 評估方案品質
├── Teammate「保守派」：最小改動、向後相容、漸進式重構
├── Teammate「激進派」：全面重寫、最佳實踐、不留技術債
└── Teammate「實用派」：平衡改動幅度與收益，80/20 法則
```

**UX 流程**：

```
Step 1: 使用者指定重構目標
  └── 主管分析程式碼現狀 + 目標

Step 2: 委派重構任務
  ├── 每個隊友收到相同目標 + 不同策略指示
  └── 各自獨立產出完整重構方案（含程式碼）

Step 3: 方案評估
  ├── 改動幅度（diff 行數）
  ├── 測試影響（需修改多少測試）
  ├── 向後相容性
  └── 可讀性改善度

Step 4: 使用者選擇
  ├── 展示各方案的優缺點對比表
  ├── 使用者選擇方案（或合併）
  └── 主管執行選定方案

Step 5: 驗證（可選 → sentinel:verify）
  └── 確認重構後所有測試通過
```

---

## 5. Hook 設計

### 5.1 TaskCompleted

collab 利用 Agent Teams 內建的 `TaskCompleted` 事件追蹤隊友進度：

```json
{
  "hooks": {
    "TaskCompleted": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/collect-results.js",
        "timeout": 10,
        "statusMessage": "收集隊友結果..."
      }
    ]
  }
}
```

**行為**：
- 當共享任務列表中的任務被標記為 `completed` 時觸發
- 收集隊友的產出並儲存
- 所有隊友完成時通知主管開始合併分析

> **注意**：`TeammateIdle` 也會在隊友完成時觸發，但不支援 prompt/agent hook。`TaskCompleted` 更適合追蹤結構化任務進度。

---

## 6. 目錄結構

```
plugins/collab/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── adversarial-plan/
│   │   └── SKILL.md
│   ├── adversarial-review/
│   │   └── SKILL.md
│   └── adversarial-refactor/
│       └── SKILL.md
├── hooks/
│   └── hooks.json
└── scripts/
    └── collect-results.js        # TaskCompleted hook 腳本
```

---

## 7. 演進路線

### 階段 1：Agent Teams 核心（v1）

以 Agent Teams 為唯一機制：
- 3 個 adversarial skills
- 多 Claude 實例各扮演不同角色
- 零外部依賴

### 階段 2：能力擴散（未來考量）

將成熟的能力合併進其他 plugin：

| collab 能力 | 合併目標 | 形式 |
|------------|---------|------|
| adversarial-review | **sentinel** | 新增 `/vibe:review --adversarial` 模式 |
| adversarial-plan | **flow** | 新增 `/vibe:plan --adversarial` 模式 |
| adversarial-refactor | **sentinel** | 新增 `/vibe:refactor --adversarial` 模式 |

合併後 collab plugin 可能退役，或轉型為「Agent Teams 配置管理」的工具型 plugin。

### 階段 3：跨模型增強（遠期）

在 Agent Teams 基礎上加入外部模型：
- 隊友可選擇性呼叫外部模型（Codex、Gemini）做對照分析
- 保持 Claude 主權：外部模型結果只作為參考
- 需要對應 API key 才啟用

---

## 8. 與原 ECC 的對應

| Vibe collab 組件 | ECC 對應 | 演變 |
|-----------------|---------|------|
| adversarial-plan | /multi-plan | 外部模型 → Agent Teams |
| adversarial-review | /multi-execute（審查部分） | 外部模型 → Agent Teams |
| adversarial-refactor | 無直接對應 | 新增：對抗式重構 |

**保留的 ECC 核心概念**：
- **交叉驗證**：多視角同時分析，合併最優結果
- **差異報告**：標示分歧，讓使用者做最終決策
- **平行分析**：多實例同時工作，效率不打折

**進化的概念**：
- **Claude 主權 → 角色分離**：不再是「Claude vs 其他模型」，而是「多個 Claude 各司其職」
- **模型分工 → 視角分工**：不靠模型差異產生多樣性，靠角色指示產生多樣性
- **跨模型 → 對抗式**：從「多模型交叉驗證」進化為「多視角對抗競爭」

---

## 9. 驗收標準

| # | 條件 | 說明 |
|:-:|------|------|
| C-01 | Plugin 可載入 | `claude --plugin-dir ./plugins/collab` 成功載入 |
| C-02 | 3 個 skill 可呼叫 | `/vibe:adversarial-plan`、`/vibe:adversarial-review`、`/vibe:adversarial-refactor` |
| C-03 | Agent Teams 啟動 | 環境變數設定後可成功組建團隊 |
| C-04 | 隊友獨立分析 | 各隊友產出不同角度的分析結果 |
| C-05 | 差異報告 | 正確對比和呈現多視角的共識與分歧 |
| C-06 | 驗證腳本全 PASS | forge:scaffold 驗證通過 |

---

## 10. plugin.json

```json
{
  "name": "collab",
  "version": "0.1.0",
  "description": "多視角競爭分析 — Agent Teams 驅動的對抗式審查與重構",
  "skills": ["./skills/"]
}
```
