# Vibe Marketplace — Plugin 設計總覽

> 5 個 plugin（forge + 4 新）的總流程、依賴關係，以及各文件索引。

---

## 1. 開發全流程圖

一個完整的開發 session，plugin 按以下順序參與：

```
╔══════════════════════════════════════════════════════════════════════╗
║                      開發者啟動 Claude Code                          ║
╚═══════════════════════════════╦══════════════════════════════════════╝
                                ▼
┌─ FLOW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┐
│                                                                   │
│  ① SessionStart hook（自動）                                       │
│     ├── 載入前次 session context（修改中的檔案、任務進度）            │
│     └── 偵測專案環境（語言/框架/PM/工具）                           │
│                                                                   │
│  ② 規劃階段（手動觸發）                                            │
│     ├── /flow:plan       需求分析 → 分階段計畫                      │
│     ├── /flow:architect  程式碼庫分析 → 架構方案                    │
│     └── /flow:compact    追蹤 context，建議壓縮                     │
│                                                                   │
│  Agents: planner（唯讀）, architect（唯讀）                         │
│  Hooks: suggest-compact（50 calls 閾值）, log-compact              │
└━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┘
                              ▼
┌─ PATTERNS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┐
│                                         │      開發者寫程式碼
│  Claude 寫碼時自動參考的知識庫            │      ┌──────────────┐
│  • coding-standards  • typescript       │ ───→ │ Write / Edit │
│  • frontend-patterns • python           │      └──────┬───────┘
│  • backend-patterns  • go               │             │
│  • db-patterns       • testing          │             │
│                                         │             │
│  8 個純知識 skills（無 hooks/agents）     │             │
└━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┘             │
                                                        ▼
┌─ SENTINEL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┐
│                                                                   │
│  ③ 自動品質守衛（hooks，使用者無感）                                │
│     ├── PostToolUse: auto-lint     → ESLint/Ruff/golangci         │
│     ├── PostToolUse: auto-format   → Prettier/Ruff format/gofmt  │
│     ├── PostToolUse: test-check    → 提醒跑相關測試               │
│     ├── PreToolUse:  danger-guard  → 攔截 rm -rf, DROP 等         │
│     └── Stop: console-log-check   → 偵測殘留 debug 碼            │
│                                                                   │
│  ④ 測試驅動（手動觸發）                                            │
│     ├── /sentinel:tdd      RED → GREEN → REFACTOR                 │
│     ├── /sentinel:e2e      Playwright Page Object Model            │
│     ├── /sentinel:coverage 覆蓋率分析（目標 80%）                  │
│     └── /sentinel:verify   Build → Types → Lint → Tests → Git     │
│                                                                   │
│  ⑤ 深度審查（手動觸發）                                            │
│     ├── /sentinel:review   程式碼審查（CRITICAL→LOW 排序）          │
│     ├── /sentinel:security OWASP Top 10 安全掃描                   │
│     ├── /sentinel:lint     手動靜態分析                             │
│     └── /sentinel:format   手動格式化                              │
│                                                                   │
│  Agents: code-reviewer, security-reviewer,                        │
│          build-error-resolver, e2e-runner                          │
└━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┘
                              ▼
┌─ EVOLVE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┐
│                                                                   │
│  ⑥ 文件同步（手動觸發）                                            │
│     ├── /evolve:doc-gen   從程式碼產生 README、API docs            │
│     └── /evolve:doc-sync  偵測並更新過時文件                       │
│                                                                   │
│  ⑦ 知識提取（自動+手動）                                           │
│     ├── SessionEnd hook: evaluate-session（自動評估學習機會）       │
│     ├── /evolve:learn    從 session 提取 instincts                │
│     └── /evolve:evolve   instincts 聚類 → 進化為 skill/agent      │
│                                                                   │
│  Agent: doc-updater（可寫）                                        │
└━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┘
                              ▼
┌─ FLOW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┐
│                                                                   │
│  ⑧ SessionEnd hook（自動）                                         │
│     ├── 儲存 session context（修改檔案、任務進度）                  │
│     └── 清理過舊 sessions（保留最近 10 個）                        │
│                                                                   │
│  /flow:checkpoint — 任意時機手動建立/恢復檢查點                     │
└━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┘
                              ▼
╔══════════════════════════════════════════════════════════════════════╗
║                         Session 結束                                ║
╚══════════════════════════════════════════════════════════════════════╝


    ┌─ COLLAB ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┐
    │                                                               │
    │  ← 任意階段可插入（需 Agent Teams 環境變數）                    │
    │  ├── /collab:adversarial-plan     多視角競爭規劃               │
    │  ├── /collab:adversarial-review   多角色對抗式審查             │
    │  └── /collab:adversarial-refactor 多方案競爭重構               │
    │                                                               │
    │  Agent Teams：多 Claude 實例各司其職，分歧即價值                │
    └━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┘
```

---

## 2. 自動 vs 手動

```
自動觸發（Hooks，使用者無感）           手動觸發（Skills，使用者主動）
────────────────────────             ────────────────────────────
FLOW     SessionStart: 載入 context   /flow:plan       功能規劃
FLOW     SessionEnd: 儲存 context     /flow:architect  架構設計
FLOW     PreToolUse: suggest-compact  /flow:compact    手動壓縮
SENTINEL PostToolUse: auto-lint       /flow:checkpoint  建立檢查點
SENTINEL PostToolUse: auto-format     /flow:env-detect  環境偵測
SENTINEL PostToolUse: test-check      /sentinel:review  深度審查
SENTINEL PreToolUse: danger-guard     /sentinel:security 安全掃描
SENTINEL Stop: console-log-check      /sentinel:tdd     TDD 工作流
EVOLVE   SessionEnd: evaluate-session /sentinel:verify   綜合驗證
EVOLVE   SessionStart: load-instincts /evolve:doc-gen   文件生成
                                      /evolve:learn     知識提取
                                      /collab:adversarial-plan  競爭規劃
                                      /collab:adversarial-review 對抗審查
                                      /collab:adversarial-refactor 競爭重構

自動: 10 hooks                        手動: 13 skills（+ patterns 8 知識 skills）
```

---

## 3. 依賴關係圖

```
┌─────────────────────────────────────────────────────────┐
│                    獨立（可單獨安裝）                      │
│                                                         │
│    ┌────────────┐                                       │
│    │  patterns  │  純知識庫，8 skills                     │
│    │            │  無 hooks/agents/scripts               │
│    └────────────┘                                       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                 核心雙引擎（建議一起安裝）                  │
│                                                         │
│    ┌────────────┐    ┌────────────┐                     │
│    │    flow    │    │  sentinel  │                     │
│    │ 5 skills   │    │ 8 skills   │                     │
│    │ 2 agents   │    │ 4 agents   │                     │
│    │ 4 hooks    │    │ 5 hooks    │                     │
│    │ 7 scripts  │    │ 6 scripts  │                     │
│    └────────────┘    └────────────┘                     │
│          │                  │                           │
│          └──────┬───────────┘                           │
│                 │ 可選增強                               │
│          ┌──────▼───────┐                               │
│          │   evolve     │                               │
│          │ 4 skills     │                               │
│          │ 1 agent      │                               │
│          │ 2 hooks      │                               │
│          └──────────────┘                               │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                 進階（需 Agent Teams）                    │
│                                                         │
│    ┌────────────┐                                       │
│    │   collab   │  需 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS │
│    │ 3 skills   │  多視角對抗式分析                      │
│    └────────────┘                                       │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 建構順序

| Phase | Plugin | 前置條件 | 組件數 |
|:-----:|--------|---------|:------:|
| 3 | **flow** | forge ✅ | 5S + 2A + 4H + 7Sc |
| 4 | **sentinel** | forge ✅ | 8S + 4A + 5H + 6Sc |
| 5 | **patterns** | 無 | 8S |
| 6 | **evolve** | flow 可選 | 4S + 1A + 2H + 2Sc |
| 7 | **collab** | Agent Teams | 3S + 1H + 1Sc |

> **flow 先於 sentinel**：規劃 → 寫碼 → 品質檢查，符合自然開發流程。

---

## 5. 文件索引

| # | Plugin | 文件 | Skills | Agents | Hooks | Scripts |
|:-:|--------|------|:------:|:------:|:-----:|:-------:|
| 1 | sentinel | [sentinel.md](sentinel.md) | 8 | 4 | 5 | 6 |
| 2 | flow | [flow.md](flow.md) | 5 | 2 | 4 | 7 |
| 3 | patterns | [patterns.md](patterns.md) | 8 | 0 | 0 | 0 |
| 4 | evolve | [evolve.md](evolve.md) | 4 | 1 | 2 | 2 |
| 5 | collab | [collab.md](collab.md) | 3 | 0 | 1 | 1 |

> **S** = Skill, **A** = Agent, **H** = Hook, **Sc** = Script

---

## 6. 總量統計

| 組件類型 | 數量 | 說明 |
|---------|:----:|------|
| **Plugins** | 5 | forge ✅ + 4 新 |
| **Skills** | 28 | 20 動態能力 + 8 知識庫（patterns） |
| **Agents** | 7 | 3 唯讀 + 4 可寫 |
| **Hooks** | 12 | 10 自動 + 2 可選 |
| **Scripts** | 16 | hook 腳本 + 共用函式庫 |
| **合計** | 63 | 跨 5 個獨立安裝的 plugins |

**對比 ECC**：71 組件塞 1 個 plugin → Vibe：63 組件分散 5 個 plugins
