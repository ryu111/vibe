# Vibe Marketplace — Plugin 設計總覽

> 2 個 plugin（forge + 0 新）的總流程、依賴關係，以及各文件索引。
>
> **此檔案由 `dashboard/scripts/generate.js` 自動產生，請勿手動編輯。**
> 修改來源：`docs/plugin-specs.json`（數量）+ `dashboard/scripts/generate.js`（結構）

---

## 1. 開發全流程圖

完整視覺化流程圖請見 [dashboard.html](../dashboard.html)。

```
開發者啟動 Claude Code
    │
    ▼
┌─ FLOW ─────────────────────────────────────┐
│  SessionStart: pipeline-init（環境偵測+規則）│
│  /vibe:scope → /vibe:architect → developer   │
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
│  /vibe:evolve（知識進化）                   │
│  /vibe:doc-sync（文件同步）                 │
│  agent: doc-updater                         │
└─────────────────────┬───────────────────────┘
                      ▼
                   完成

  ┌─ DASHBOARD ─ 監控層（即時視覺化）───────────┐
  │  SessionStart: 自動啟動 WebSocket server    │
  │  /vibe:dashboard（手動控管）            │
  └─────────────────────────────────────────────┘

  ┌─ REMOTE ─── 遠端控制（Telegram）──────────────┐
  │  SessionStart: 自動啟動 bot daemon          │
  │  SubagentStop: pipeline 進度推播            │
  │  /remote · /remote-config（手動控管）        │
  └─────────────────────────────────────────────┘

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
FLOW     SessionStart: pipeline-init  /vibe:scope      功能規劃
FLOW     PreToolUse: suggest-compact  /vibe:architect  架構設計
FLOW     PreCompact: log-compact      /vibe:context-status  Context 狀態
FLOW     SubagentStop: stage-trans.   /vibe:checkpoint 建立檢查點
FLOW     Stop: pipeline-check         /vibe:env-detect 環境偵測
FLOW     Stop: task-guard             /vibe:cancel     取消鎖定
SENTINEL PostToolUse: auto-lint       /vibe:review  深度審查
SENTINEL PostToolUse: auto-format     /vibe:security 安全掃描
SENTINEL PostToolUse: test-check      /vibe:tdd     TDD 工作流
SENTINEL PreToolUse: danger-guard     /vibe:e2e     E2E 測試
SENTINEL Stop: console-log-check      /vibe:coverage 覆蓋率
DASH     SessionStart: autostart      /vibe:lint    手動 lint
REMOTE   SessionStart: autostart      /vibe:format  手動格式化
REMOTE   SubagentStop: sender         /vibe:verify  綜合驗證
COLLAB   SessionStart: team-init      /vibe:evolve    知識進化
                                      /vibe:doc-sync  文件同步
                                      /vibe:dashboard 儀表板控管
                                      /remote           遠端控管
                                      /remote-config    遠端設定
                                      /vibe:adversarial-plan  競爭規劃
                                      /vibe:adversarial-review 對抗審查
                                      /vibe:adversarial-refactor 競爭重構

自動: 21 hooks                         手動: 33 skills（+ patterns 0 知識 skills）
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
│    ┌────────────▼──┐  ┌────────────┐  ┌────────────┐   │
│    │   evolve      │  │ dashboard  │  │   remote   │   │
│    │  知識進化      │  │  即時監控   │  │  遠端控制   │   │
│    └───────────────┘  └────────────┘  └────────────┘   │
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
| 3 | **vibe** | forge ✅ | 29S + 10A + 21H + 31Sc |

> **flow 先於 sentinel**：規劃 → 寫碼 → 品質檢查，符合自然開發流程。

---

## 5. 文件索引

| # | Plugin | 文件 | Skills | Agents | Hooks | Scripts |
|:-:|--------|------|:------:|:------:|:-----:|:-------:|
| 1 | vibe | [vibe.md](vibe.md) | 29 | 10 | 21 | 31 |

> **S** = Skill, **A** = Agent, **H** = Hook, **Sc** = Script

---

## 6. 總量統計

| 組件類型 | 數量 | 說明 |
|---------|:----:|------|
| **Plugins** | 2 | forge ✅ + 0 新 |
| **Skills** | 33 | 33 動態能力 + 0 知識庫（patterns） |
| **Agents** | 10 | 跨 1 個 plugins |
| **Hooks** | 21 | 自動觸發 |
| **Scripts** | 38 | hook 腳本 + 共用函式庫 |
| **合計** | 102 | 跨 2 個獨立安裝的 plugins |
