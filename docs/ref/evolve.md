# evolve — 知識進化

> **優先級**：低
> **定位**：持續學習 + 文件自動化 — 從開發中提取知識，保持文件同步
> **合併自**：原 learner + 原 docs
> **ECC 對應**：continuous-learning-v2 + /learn /evolve commands + doc-updater agent

---

## 1. 概述

evolve 是 Vibe marketplace 的知識進化 plugin。它做兩件互補的事：

1. **學習**：觀察開發模式 → 提取可重用知識 → 進化為 skills/agents
2. **文件**：偵測程式碼變更 → 自動更新文件 → 保持同步

合併 learner + docs 的原因：兩者都是「從程式碼中提取和維護知識」，一個產出 instincts，一個產出文件。

核心理念：**每次開發都是學習機會，文件是程式碼的影子。**

## 2. 設計目標

| # | 目標 | 說明 |
|:-:|------|------|
| 1 | **自動觀察** | SessionEnd 時自動評估是否有可提取的模式 |
| 2 | **碎片化知識** | Atomic instincts（Problem + Solution + When to Use） |
| 3 | **進化路徑** | instincts → cluster → skill/agent |
| 4 | **文件同步** | 程式碼變更後偵測過時文件 |
| 5 | **文件生成** | 從程式碼自動產生 README、API docs、JSDoc |

---

## 3. 組件清單

### Skills（4 個）

| 名稱 | 說明 |
|------|------|
| `learn` | 知識提取 — 從 session 提取可重用的 instincts |
| `evolve` | 知識進化 — instincts 聚類 → 進化為 skill/agent |
| `doc-gen` | 文件生成 — 從程式碼產生 README、API docs、JSDoc |
| `doc-sync` | 文件同步 — 偵測程式碼與文件不同步並更新 |

### Agents（1 個）

| 名稱 | Model | 權限 | 說明 |
|------|:-----:|:----:|------|
| `doc-updater` | haiku | 可寫 | 分析程式碼變更並更新對應文件 |

### Hooks（2 個）

| 事件 | 名稱 | 類型 | 強度 | 說明 |
|------|------|:----:|:----:|------|
| SessionEnd | evaluate-session | prompt | 軟建議 | 評估 session 是否有可提取模式 |
| SessionStart | load-instincts | command | — | 載入高信心 instincts |

---

## 4. Skills 詳細設計

### 4.1 learn — 知識提取

```yaml
name: learn
description: 知識提取 — 從當前 session 提取可重用的問題解決模式（instincts）。
```

**Instinct 格式**：

```json
{
  "id": "inst-20260209-001",
  "confidence": 0.5,
  "occurrences": 1,
  "problem": "Next.js API route 回傳 405",
  "solution": "檢查 export 的 HTTP method 名稱，App Router 使用命名導出",
  "when_to_use": "Next.js App Router API route 回傳非預期 HTTP status",
  "tags": ["next.js", "api-routes"]
}
```

**信心分數**：

| 分數 | 狀態 | 行為 |
|:----:|------|------|
| 0.3 | 初始 | 新觀察 |
| 0.5 | 確認 | 第二次觀察 |
| 0.7 | 成熟 | 多次成功應用 |
| 0.9 | 可進化 | 考慮進化為 skill |
| < 0.3 | 衰退 | 長期未使用，自動降級 |

### 4.2 evolve — 知識進化

```yaml
name: evolve
description: 知識進化 — 將 instincts 聚類並進化為 skills 或 agents。
```

**進化路徑**：

```
Observation → Instinct(0.3) → Cluster(≥3, avg≥0.7) → Skill/Agent
```

| 進化目標 | 條件 |
|---------|------|
| Cluster | ≥3 instincts 有相同 tag |
| Skill | avg confidence ≥ 0.7，instincts ≥ 5 |
| Agent | avg confidence ≥ 0.8，instincts ≥ 8，需多步驟 |

### 4.3 doc-gen — 文件生成

```yaml
name: doc-gen
description: 文件生成 — 從程式碼產生 README、API docs、JSDoc/docstring、CHANGELOG。
```

| 類型 | 來源 | 格式 |
|------|------|------|
| README.md | package.json + 目錄結構 | Markdown |
| API Reference | 路由定義 + 型別 | Markdown / OpenAPI |
| JSDoc | 函式簽名 + 型別 | JSDoc 註解 |
| CHANGELOG | git log + conventional commits | Keep a Changelog |

### 4.4 doc-sync — 文件同步

```yaml
name: doc-sync
description: 文件同步 — 偵測程式碼與文件不同步並更新。
```

**偵測邏輯**：git diff → 分析變更 → 檢查對應文件是否過時 → 報告/自動更新

---

## 5. Agent 詳細設計

### 5.1 doc-updater（可寫）

```yaml
---
name: doc-updater
description: >-
  分析程式碼變更並自動更新對應文件。機械性變更自動套用，
  語意性變更產出建議供人工審查。
tools: Read, Write, Edit, Bash, Grep, Glob
model: haiku
color: green
maxTurns: 30
permissionMode: acceptEdits
memory: project
---
```

**工作流**：分析 git diff → 識別受影響文件 → 機械性變更自動更新 → 語意性變更產出建議

**品質標準**：描述準確反映程式碼、範例可直接執行、不過度文件化。

---

## 6. Hooks 詳細設計

### 6.1 SessionEnd: evaluate-session

```json
{
  "matcher": null,
  "hooks": [{
    "type": "prompt",
    "prompt": "Evaluate this session for reusable patterns. If ≥10 messages and involved problem-solving, suggest 1-3 instincts (Problem | Solution | When to Use). Otherwise respond 'No patterns.'",
    "model": "haiku",
    "timeout": 15,
    "statusMessage": "評估學習機會..."
  }]
}
```

### 6.2 SessionStart: load-instincts

```json
{
  "matcher": "startup|resume",
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/load-instincts.js",
    "timeout": 5,
    "once": true,
    "statusMessage": "載入學習記憶..."
  }]
}
```

載入高信心（≥0.7）且與當前專案相關的 instincts。

---

## 7. Scripts

| 腳本 | 位置 | 功能 |
|------|------|------|
| `load-instincts.js` | `scripts/hooks/` | 載入高信心 instincts |
| `instinct-store.js` | `scripts/lib/` | Instinct CRUD + 聚類 + 衰退 |

---

## 8. 目錄結構

```
plugins/evolve/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── learn/
│   │   └── SKILL.md
│   ├── evolve/
│   │   └── SKILL.md
│   ├── doc-gen/
│   │   └── SKILL.md
│   └── doc-sync/
│       └── SKILL.md
├── agents/
│   └── doc-updater.md
├── hooks/
│   └── hooks.json
└── scripts/
    ├── hooks/
    │   └── load-instincts.js
    └── lib/
        └── instinct-store.js
```

---

## 9. 驗收標準

| # | 條件 |
|:-:|------|
| E-01 | Plugin 可載入，4 個 skill 可呼叫 |
| E-02 | doc-updater agent 可觸發 |
| E-03 | evaluate-session 在長 session 結束時建議提取模式 |
| E-04 | load-instincts 在 SessionStart 載入高信心知識 |
| E-05 | Instinct CRUD + 聚類功能正常 |
| E-06 | doc-gen 可從 TS 專案生成正確 README |
| E-07 | forge:scaffold 驗證全 PASS |

---

## 10. plugin.json

```json
{
  "name": "evolve",
  "version": "0.1.0",
  "description": "知識進化 — 持續學習、文件生成與同步",
  "skills": ["./skills/"],
  "agents": [
    "./agents/doc-updater.md"
  ]
}
```
