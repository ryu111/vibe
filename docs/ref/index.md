# Vibe Marketplace — Plugin 設計總覽

> 6 個 plugin（forge + 5 新）的總流程、依賴關係，以及各文件索引。
>
> **此檔案由 `scripts/generate-dashboard.js` 自動產生，請勿手動編輯。**
> 修改來源：`docs/plugin-specs.json`（數量）+ `scripts/generate-dashboard.js`（結構）

---

## 1. 開發全流程圖

完整視覺化流程圖請見 [dashboard.html](../dashboard.html)。

```
開發者啟動 Claude Code
    │
    ▼
┌─ FLOW ─────────────────────────────────────┐
│  SessionStart: pipeline-init（環境偵測+規則）│
│  /flow:plan → /flow:architect → developer   │
│  suggest-compact · checkpoint · cancel      │
└─────────────────────┬───────────────────────┘
                      ▼
┌─ PATTERNS ──────────────────────────────────┐
│  8 個純知識 skills（無 hooks/agents）         │
└─────────────────────┬───────────────────────┘
                      ▼
┌─ SENTINEL ──────────────────────────────────┐
│  自動: auto-lint · auto-format · test-check │
│  手動: review · security · tdd · e2e · verify│
│  攔截: danger-guard · console-log-check     │
└─────────────────────┬───────────────────────┘
                      ▼
┌─ EVOLVE ────────────────────────────────────┐
│  /evolve:evolve（知識進化）                   │
│  /evolve:doc-sync（文件同步）                 │
│  agent: doc-updater                         │
└─────────────────────┬───────────────────────┘
                      ▼
                   完成

  ┌─ COLLAB ──── 任意階段可插入（需 Agent Teams）┐
  │  adversarial-plan · review · refactor       │
  └─────────────────────────────────────────────┘

  ┌─ claude-mem ──── 獨立 plugin，推薦搭配 ─────┐
  │  自動: 觀察捕獲 · session 摘要 · context 注入│
  └─────────────────────────────────────────────┘
```

---

## 2. 自動 vs 手動

```
自動觸發（Hooks，使用者無感）            手動觸發（Skills，使用者主動）
─────────────────────────            ─────────────────────────────
FLOW     SessionStart: pipeline-init  /flow:plan       功能規劃
FLOW     PreToolUse: suggest-compact  /flow:architect  架構設計
FLOW     PreCompact: log-compact      /flow:compact    手動壓縮
FLOW     SubagentStop: stage-trans.   /flow:checkpoint 建立檢查點
FLOW     Stop: pipeline-check         /flow:env-detect 環境偵測
FLOW     Stop: task-guard             /flow:cancel     取消鎖定
SENTINEL PostToolUse: auto-lint       /sentinel:review  深度審查
SENTINEL PostToolUse: auto-format     /sentinel:security 安全掃描
SENTINEL PostToolUse: test-check      /sentinel:tdd     TDD 工作流
SENTINEL PreToolUse: danger-guard     /sentinel:e2e     E2E 測試
SENTINEL Stop: console-log-check      /sentinel:coverage 覆蓋率
COLLAB   SessionStart: team-init      /sentinel:lint    手動 lint
                                      /sentinel:format  手動格式化
                                      /sentinel:verify  綜合驗證
                                      /evolve:evolve    知識進化
                                      /evolve:doc-sync  文件同步
                                      /collab:adversarial-plan  競爭規劃
                                      /collab:adversarial-review 對抗審查
                                      /collab:adversarial-refactor 競爭重構

自動: 13 hooks                         手動: 24 skills（+ patterns 8 知識 skills）
跨 session 記憶：claude-mem（獨立 plugin，非依賴）
```

---

## 3. 依賴關係圖

```
┌─────────────────────────────────────────────────────────┐
│                    獨立（可單獨安裝）                      │
│    ┌────────────┐    ┌────────────┐                     │
│    │  patterns  │    │ claude-mem │                     │
│    │  純知識庫   │    │  記憶持久化 │                     │
│    └────────────┘    └────────────┘                     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                 核心雙引擎（建議一起安裝）                  │
│    ┌────────────┐    ┌────────────┐                     │
│    │    flow    │    │  sentinel  │                     │
│    └────────────┘    └────────────┘                     │
│          │                  │                           │
│          └──────┬───────────┘                           │
│                 │ 可選增強                               │
│          ┌──────▼───────┐                               │
│          │   evolve     │                               │
│          └──────────────┘                               │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                 進階（需 Agent Teams）                    │
│    ┌────────────┐                                       │
│    │   collab   │  需 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS │
│    └────────────┘                                       │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 建構順序

| Phase | Plugin | 前置條件 | 組件數 |
|:-----:|--------|---------|:------:|
| 3 | **flow** | forge ✅ | 6S + 3A + 7H + 10Sc |
| 4 | **sentinel** | forge ✅ | 9S + 6A + 5H + 6Sc |
| 5 | **patterns** | 無 | 8S |
| 6 | **evolve** | flow 可選 | 2S + 1A |
| 7 | **collab** | Agent Teams | 3S + 1H + 1Sc |

> **flow 先於 sentinel**：規劃 → 寫碼 → 品質檢查，符合自然開發流程。

---

## 5. 文件索引

| # | Plugin | 文件 | Skills | Agents | Hooks | Scripts |
|:-:|--------|------|:------:|:------:|:-----:|:-------:|
| 1 | flow | [flow.md](flow.md) | 6 | 3 | 7 | 10 |
| 2 | sentinel | [sentinel.md](sentinel.md) | 9 | 6 | 5 | 6 |
| 3 | patterns | [patterns.md](patterns.md) | 8 | 0 | 0 | 0 |
| 4 | evolve | [evolve.md](evolve.md) | 2 | 1 | 0 | 0 |
| 5 | collab | [collab.md](collab.md) | 3 | 0 | 1 | 1 |

> **S** = Skill, **A** = Agent, **H** = Hook, **Sc** = Script

---

## 6. 總量統計

| 組件類型 | 數量 | 說明 |
|---------|:----:|------|
| **Plugins** | 6 | forge ✅ + 5 新 |
| **Skills** | 32 | 24 動態能力 + 8 知識庫（patterns） |
| **Agents** | 10 | 跨 3 個 plugins |
| **Hooks** | 13 | 自動觸發 |
| **Scripts** | 24 | hook 腳本 + 共用函式庫 |
| **合計** | 79 | 跨 6 個獨立安裝的 plugins |
