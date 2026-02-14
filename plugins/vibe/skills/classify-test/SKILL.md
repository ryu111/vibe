---
name: classify-test
description: >-
  分類器診斷 — 測試 prompt 分類結果、顯示命中信號層、蒐集誤判語料。
  觸發詞：classify-test、分類測試、分類器、測試分類、誤判。
argument-hint: "[要測試的 prompt 或子指令]"
allowed-tools: Bash, Read
---

# /classify-test — 分類器診斷與語料蒐集

即時測試 task-classifier 的分類結果，並蒐集誤判語料供 evolve 進化。

## 指令

| 子指令 | 說明 |
|--------|------|
| `{prompt}` | 測試指定 prompt 的分類結果 + 命中信號 |
| `corpus` | 顯示已蒐集的誤判語料統計 |
| `corpus show [N]` | 顯示最近 N 筆誤判記錄（預設 10） |
| `corpus clear` | 清除語料檔 |

## 執行規則

### 1. 解析 `$ARGUMENTS`

- 「corpus」「語料」「show」「clear」→ 語料管理子指令
- 其他文字 → 視為要測試的 prompt

### 2. 測試 prompt

使用 Bash 執行：

```bash
node -e "
const { classify, isStrongQuestion, STRONG_QUESTION, TRIVIAL, WEAK_EXPLORE, ACTION_PATTERNS } = require('${CLAUDE_PLUGIN_ROOT}/scripts/lib/flow/classifier.js');
const prompt = process.argv[1];
const p = prompt.toLowerCase();
const result = classify(prompt);
const strong = isStrongQuestion(p);
const trivial = TRIVIAL.test(p);
const weak = WEAK_EXPLORE.test(p);
const actions = ACTION_PATTERNS.filter(a => a.pattern.test(p)).map(a => a.type);
const signals = [];
STRONG_QUESTION.forEach((re, i) => { if (re.test(p.trim())) signals.push('STRONG[' + i + ']: ' + re.source); });
if (trivial) signals.push('TRIVIAL');
if (weak) signals.push('WEAK_EXPLORE');
actions.forEach(a => signals.push('ACTION: ' + a));
console.log(JSON.stringify({ prompt, result, strong, trivial, weak, actions, signals }, null, 2));
" -- '要測試的 prompt'
```

**注意**：上面的 `'要測試的 prompt'` 替換為使用者實際輸入的 `$ARGUMENTS`。

將結果格式化為：

```
## 分類結果

| 項目 | 值 |
|------|-----|
| **Prompt** | `{prompt}` |
| **分類** | `{result}` ← {TYPE_LABELS[result]} |
| **強疑問** | {strong ? '是' : '否'} |
| **Trivial** | {trivial ? '是' : '否'} |
| **弱探索** | {weak ? '是' : '否'} |
| **動作匹配** | {actions.join(', ') || '無'} |

### 命中信號
{signals 列表}

### 判斷路徑
Phase {N}: {signal} → {result}
```

然後用 AskUserQuestion 問：

- **分類正確** — 結束
- **分類錯誤 → 記錄語料** — 詢問正確分類，然後寫入語料檔

### 3. 記錄誤判語料

語料檔路徑：`~/.claude/classifier-corpus.jsonl`

每行格式（JSONL）：
```json
{"prompt":"原始 prompt","actual":"分類器結果","expected":"使用者指定的正確分類","signals":["命中的信號"],"timestamp":"ISO 時間"}
```

使用 Bash `echo >> ~/.claude/classifier-corpus.jsonl` 追加。

### 4. 語料管理

#### corpus（統計）

讀取 `~/.claude/classifier-corpus.jsonl`，統計：
- 總筆數
- 各分類的誤判次數（actual → expected 的轉換分布）
- 最常見的誤判模式

#### corpus show

顯示最近 N 筆記錄，每筆：
```
[時間] "{prompt}" → actual:{actual} expected:{expected}
```

#### corpus clear

清除語料檔後確認。

## 與 evolve 整合

`/vibe:evolve` 可讀取 `~/.claude/classifier-corpus.jsonl` 作為進化輸入：
- 分析誤判模式 → 建議新的 regex 規則
- 識別缺失的疑問信號 → 建議加入 STRONG_QUESTION
- 統計 false positive/negative 比例 → 評估分類器健康度

## 使用者要求

$ARGUMENTS
