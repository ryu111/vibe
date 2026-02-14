# Vibe Marketplace — Plugin 設計總覽

> 2 個 plugin（forge + vibe）的總流程、模組架構，以及各文件索引。
>
> **此檔案由 `dashboard/scripts/generate.js` 自動產生，請勿手動編輯。**
> 修改來源：`docs/plugin-specs.json`（數量）+ `dashboard/scripts/generate.js`（結構）

---

## 1. 開發全流程圖

完整視覺化流程圖請見 [dashboard.html](../dashboard.html)。

```
使用者提出需求
    │
    ▼
┌─ task-classifier（haiku · UserPromptSubmit）──┐
│  自動分類任務類型 → 建議 pipeline 啟動階段     │
└─────────────────────┬────────────────────────┘
                      ▼
┌─ 規劃模組 ────────────────────────────────────┐
│  PLAN: planner（/vibe:scope）                 │
│  ARCH: architect（/vibe:architect）            │
│  pipeline-init · suggest-compact · cancel     │
└─────────────────────┬────────────────────────┘
                      ▼
┌─ 知識模組 ────────────────────────────────────┐
│  8 個純知識 skills（coding-standards + 7 語言） │
│  無 hooks/agents — 按需載入                    │
└─────────────────────┬────────────────────────┘
                      ▼
┌─ 品質模組 ────────────────────────────────────┐
│  DEV: developer（寫碼 + 自動 lint/format）     │
│  REVIEW: code-reviewer + security-reviewer    │
│  TEST: tester + build-error-resolver          │
│  QA: qa · E2E: e2e-runner                     │
│  danger-guard · check-console-log             │
└─────────────────────┬────────────────────────┘
                      ▼
┌─ 進化模組 ────────────────────────────────────┐
│  DOCS: doc-updater（/vibe:doc-sync）          │
│  /vibe:evolve（知識進化）                     │
└─────────────────────┬────────────────────────┘
                      ▼
                   完成

  ┌─ 監控模組 ─ WebSocket 即時儀表板 ────────────┐
  │  SessionStart: 自動啟動 · /vibe:dashboard    │
  └─────────────────────────────────────────────┘

  ┌─ 遠端模組 ─ Telegram 雙向控制 ──────────────┐
  │  進度推播 · 狀態查詢 · 遠端指令 · tmux 控制  │
  └─────────────────────────────────────────────┘
```

---

## 2. 自動 vs 手動

```
自動觸發（Hooks，使用者無感）              手動觸發（Skills，使用者主動）
──────────────────────────              ──────────────────────────────
SessionStart: pipeline-init             /vibe:scope       功能規劃
SessionStart: dashboard-autostart       /vibe:architect   架構設計
SessionStart: remote-autostart          /vibe:context-status  Context 狀態
UserPromptSubmit: task-classifier       /vibe:checkpoint  建立檢查點
PreToolUse(Task): delegation-tracker    /vibe:env-detect  環境偵測
PreToolUse(Write|Edit): dev-gate        /vibe:cancel      取消鎖定
PreToolUse(EnterPlanMode): plan-mode-gate /vibe:review    深度審查
PreToolUse(*): suggest-compact          /vibe:security    安全掃描
PreToolUse(Bash): danger-guard          /vibe:tdd         TDD 工作流
PreToolUse(AskUserQuestion): remote-ask /vibe:e2e         E2E 測試
PostToolUse(Write|Edit): auto-lint      /vibe:qa          行為測試
PostToolUse(Write|Edit): auto-format    /vibe:coverage    覆蓋率
PostToolUse(Write|Edit): test-check     /vibe:lint        手動 lint
PreCompact: log-compact                 /vibe:format      手動格式化
SubagentStop: stage-transition          /vibe:verify      綜合驗證
SubagentStop: remote-sender             /vibe:evolve      知識進化
Stop: pipeline-check                    /vibe:doc-sync    文件同步
Stop: task-guard                        /vibe:dashboard   儀表板控管
Stop: check-console-log                 /remote           遠端控管
Stop: dashboard-refresh                 /remote-config    遠端設定
Stop: remote-receipt                    /vibe:hook-diag   Hook 診斷
UserPromptSubmit: remote-prompt-forward

自動: 22 hooks                           手動: 25 skills（+ 8 知識 skills）
跨 session 記憶：claude-mem（獨立 plugin，推薦搭配）
```

---

## 3. 建構順序

| Phase | Plugin | 描述 | 組件數 |
|:-----:|--------|------|:------:|
| 1 | **forge** | 造工具的工具 — 建立、驗證、管理 Claude Code plugin 組件 | 4S + 7Sc |
| 2 | **vibe** | 全方位開發工作流 — 規劃、品質守衛、知識庫、即時監控、遠端控制 | 29S + 10A + 22H + 37Sc |

---

## 4. 文件索引

| # | Plugin | 文件 | Skills | Agents | Hooks | Scripts |
|:-:|--------|------|:------:|:------:|:-----:|:-------:|
| 1 | forge | [forge.md](forge.md) | 4 | 0 | 0 | 7 |
| 2 | vibe | [vibe.md](vibe.md) | 29 | 10 | 22 | 37 |

> **S** = Skill, **A** = Agent, **H** = Hook, **Sc** = Script

---

## 5. 總量統計

| 組件類型 | 數量 | 說明 |
|---------|:----:|------|
| **Plugins** | 2 | forge + vibe |
| **Skills** | 33 | 25 動態能力 + 8 知識庫 |
| **Agents** | 10 | 全部在 vibe plugin |
| **Hooks** | 22 | 自動觸發 |
| **Scripts** | 44 | hook 腳本 + 共用函式庫 |
| **合計** | 109 | 跨 2 個 plugins |
