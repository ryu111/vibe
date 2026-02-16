#!/usr/bin/env node
/**
 * classifier.js — 三層級聯分類器（Three-Layer Cascading Classifier）
 *
 * 設計原則：
 *   誤觸 pipeline（false positive）代價 >> 漏觸 pipeline（false negative）
 *   → 疑問句永遠優先於動作關鍵字
 *   → 使用者可用 /vibe:scope 明確啟動 pipeline，不需靠分類器猜
 *
 * 三層架構：
 *   Layer 1:  Explicit Pipeline — [pipeline:xxx] 語法（100% 信心度）
 *   Layer 2:  Regex Classifier — 疑問/trivial/動作關鍵字（70~95% 信心度）
 *     ├─ Strong Question Guard — 多層疑問信號（最高優先級）
 *     ├─ Trivial Detection — hello world / poc / demo
 *     ├─ Weak Explore — 看看 / 查看 / 說明 等探索詞
 *     └─ Action Keywords — tdd / feature / refactor / bugfix
 *   Layer 3:  LLM Fallback — 低信心度時呼叫 Sonnet 語意分類（ANTHROPIC_API_KEY 降級為 context 注入）
 *
 * 環境變數：
 *   VIBE_CLASSIFIER_MODEL     — Layer 3 LLM 模型（預設 claude-sonnet-4-20250514）
 *   VIBE_CLASSIFIER_THRESHOLD — Layer 2→3 降級閾值（預設 0.7，設 1.0 可完全停用 Layer 3）
 *
 * 分類流程（舊版 classify）：
 *   Phase 1:  Strong Question Guard — 多層疑問信號（最高優先級）
 *   Phase 2:  Trivial Detection — hello world / poc / demo
 *   Phase 3:  Weak Explore — 看看 / 查看 / 說明 等探索詞
 *   Phase 4:  Action Keywords — tdd / feature / refactor / bugfix
 *   Default:  quickfix（保守，不鎖定 pipeline）
 *
 * @module flow/classifier
 */
'use strict';

const https = require('https');
const { PIPELINES, TASKTYPE_TO_PIPELINE } = require('../registry.js');

// ═══════════════════════════════════════════════
// Phase 1: 強疑問信號（任何命中 → research）
// ═══════════════════════════════════════════════

const STRONG_QUESTION = [
  // 句尾疑問標記（中文助詞 + 問號）
  /[?？嗎呢]\s*$/,

  // 中文疑問代詞
  /什麼|怎麼|為什麼|為何|哪裡|哪個|哪些|多少|幾個|誰|何時|如何/,

  // A不A 正反疑問結構
  /有沒有|是不是|能不能|會不會|可不可以|要不要|好不好|對不對|算不算/,

  // 文言疑問助詞
  /是否|能否|可否|有無/,

  // 顯式探詢意圖
  /想知道|想了解|想問|好奇|不確定|不知道|搞不清|請問/,

  // 英文 WH 疑問（句首）
  /^(what|how|why|where|when|which|who|explain|describe)\b/,
];

/**
 * 判斷是否為強疑問句
 * @param {string} p - lowercased prompt
 * @returns {boolean}
 */
function isStrongQuestion(p) {
  return STRONG_QUESTION.some(re => re.test(p.trim()));
}

// ═══════════════════════════════════════════════
// Phase 2: Trivial 偵測
// ═══════════════════════════════════════════════

const TRIVIAL = /hello.?world|boilerplate|scaffold|skeleton|poc|proof.?of.?concept|概念驗證|prototype|原型|試做|試作|簡單的?\s*(?:範例|demo|example|試試)|練習用|練習一下|tutorial|學習用|playground|scratch/;

// ═══════════════════════════════════════════════
// Phase 3: 弱探索信號（放在 trivial 之後，避免
//          「做一個 hello world 看看」被誤判為 research）
// ═══════════════════════════════════════════════

const WEAK_EXPLORE = /看看|查看|找找|說明|解釋|告訴|描述|列出|做什麼|是什麼|有哪些|出問題/;

// ═══════════════════════════════════════════════
// Phase 4: 動作分類
// ═══════════════════════════════════════════════

const ACTION_PATTERNS = [
  { type: 'tdd', pattern: /tdd|test.?first|測試驅動|先寫測試/ },
  { type: 'test', pattern: /^(write|add|create|fix).*test|^(寫|加|新增|修).*測試|^test\b/ },
  { type: 'refactor', pattern: /refactor|restructure|重構|重寫|重新設計|改架構/ },
  { type: 'feature', pattern: /implement|develop|build.*feature|新增功能|建立.*(?:功能|api|rest|endpoint|server|service|database|服務|系統|模組|元件|頁面|app|應用|專案|component|module)|實作|開發.*功能|加入.*功能|新的.*(api|endpoint|component|頁面|模組|plugin)|整合.*系統/ },
  { type: 'quickfix', pattern: /fix.*typo|rename|change.*name|update.*text|改名|修.*typo|換.*名|改.*顏色|改.*文字/ },
  { type: 'bugfix', pattern: /fix|bug|修(復|正)|debug|壞了|出錯|不work|不能/ },
];

/**
 * 詳細分類（內部函式）— 回傳 taskType + matchedRule
 * @param {string} prompt - 使用者輸入（原始文字）
 * @returns {{ taskType: string, matchedRule: string }}
 */
function classifyDetailed(prompt) {
  if (!prompt) return { taskType: 'quickfix', matchedRule: 'default' };
  const p = prompt.toLowerCase();

  if (isStrongQuestion(p)) return { taskType: 'research', matchedRule: 'strong-question' };
  if (TRIVIAL.test(p)) return { taskType: 'quickfix', matchedRule: 'trivial' };
  if (WEAK_EXPLORE.test(p)) return { taskType: 'research', matchedRule: 'weak-explore' };

  for (const { type, pattern } of ACTION_PATTERNS) {
    if (pattern.test(p)) return { taskType: type, matchedRule: `action:${type}` };
  }

  return { taskType: 'quickfix', matchedRule: 'default' };
}

/**
 * 兩階段級聯分類（舊版介面，向後相容）
 * @param {string} prompt - 使用者輸入（原始文字）
 * @returns {string} 任務類型：research|quickfix|tdd|test|refactor|feature|bugfix
 */
function classify(prompt) {
  return classifyDetailed(prompt).taskType;
}

// ═══════════════════════════════════════════════
// Layer 1: 顯式 Pipeline 覆寫
// ═══════════════════════════════════════════════

/**
 * 解析顯式 pipeline 語法 [pipeline:xxx]
 * @param {string} prompt - 使用者輸入（原始文字）
 * @returns {string|null} pipeline ID 或 null（大小寫不敏感）
 */
function extractExplicitPipeline(prompt) {
  if (!prompt) return null;

  // 匹配 [pipeline:xxx] 語法（大小寫不敏感）
  const match = prompt.match(/\[pipeline:([a-z0-9-]+)\]/i);
  if (!match) return null;

  const pipelineId = match[1].toLowerCase();

  // 驗證是否為合法 pipeline ID
  if (!PIPELINES[pipelineId]) {
    return null; // 不合法的 ID 忽略，降級到 Layer 2
  }

  return pipelineId;
}

// ═══════════════════════════════════════════════
// Layer 2: Regex 分類 + 信心度評分
// ═══════════════════════════════════════════════

/**
 * 將 taskType 映射到 pipeline ID
 * @param {string} taskType - classify() 回傳的任務類型
 * @returns {string} pipeline ID
 */
function mapTaskTypeToPipeline(taskType) {
  return TASKTYPE_TO_PIPELINE[taskType] || 'fix';
}

/**
 * 計算信心度（根據分類結果）
 * @param {string} taskType - classify() 回傳的任務類型
 * @param {string} prompt - 原始 prompt（用於判斷是否命中特定規則）
 * @returns {number} 信心度 0~1
 */
function calculateConfidence(taskType, prompt) {
  const p = prompt.toLowerCase();

  // Strong question guard 命中 → 最高信心度
  if (taskType === 'research' && isStrongQuestion(p)) {
    return 0.95;
  }

  // Trivial 命中 → 高信心度
  if (taskType === 'quickfix' && TRIVIAL.test(p)) {
    return 0.9;
  }

  // Weak explore 命中 → 低信心度（可能需要 Layer 3）
  if (taskType === 'research' && WEAK_EXPLORE.test(p)) {
    return 0.6;
  }

  // Action keywords 命中 → 中高信心度
  const actionMatch = ACTION_PATTERNS.find(({ pattern }) => pattern.test(p));
  if (actionMatch) {
    return 0.8;
  }

  // 預設 quickfix → 中信心度
  return 0.7;
}

/**
 * 三層分類（新版介面）
 * @param {string} prompt - 使用者輸入（原始文字）
 * @returns {{ pipeline: string, confidence: number, source: 'explicit'|'regex'|'pending-llm'|'llm'|'regex-low' }}
 */
function classifyWithConfidence(prompt) {
  if (!prompt) {
    return { pipeline: 'fix', confidence: 0.7, source: 'regex', matchedRule: 'default' };
  }

  // Layer 1: 顯式覆寫
  const explicitPipeline = extractExplicitPipeline(prompt);
  if (explicitPipeline) {
    return { pipeline: explicitPipeline, confidence: 1.0, source: 'explicit', matchedRule: 'explicit' };
  }

  // Layer 2: Regex 分類（取得 matchedRule）
  const { taskType, matchedRule } = classifyDetailed(prompt);
  const pipeline = mapTaskTypeToPipeline(taskType);
  const confidence = calculateConfidence(taskType, prompt);

  // Layer 3: 低信心度時標記為 pending-llm（由 task-classifier hook 觸發 LLM 呼叫）
  const threshold = getAdaptiveThreshold();
  const source = confidence < threshold ? 'pending-llm' : 'regex';

  return { pipeline, confidence, source, matchedRule };
}

// ═══════════════════════════════════════════════
// Layer 3: LLM Fallback（Sonnet 語意分類）
// ═══════════════════════════════════════════════

/** Layer 3 LLM 模型（環境變數可覆寫，預設 Sonnet） */
const LLM_MODEL = process.env.VIBE_CLASSIFIER_MODEL || 'claude-sonnet-4-20250514';

/** Layer 3 LLM 呼叫逾時（ms，Sonnet 比 Haiku 稍慢） */
const LLM_TIMEOUT = 10000;

/** @deprecated 由 getAdaptiveThreshold() 取代 — 保留供測試向後相容 */
const LLM_CONFIDENCE_THRESHOLD = (() => {
  const v = parseFloat(process.env.VIBE_CLASSIFIER_THRESHOLD);
  return Number.isNaN(v) ? 0.7 : v;
})();

/**
 * 呼叫 Anthropic API 進行語意分類
 *
 * @param {string} prompt - 使用者輸入
 * @returns {Promise<{pipeline: string, confidence: number, source: 'llm'}|null>}
 *   成功回傳分類結果，失敗回傳 null（供降級使用）
 */
function classifyWithLLM(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Promise.resolve(null);

  const catalog = Object.entries(PIPELINES)
    .map(([id, p]) => `- ${id}: ${p.description}`)
    .join('\n');

  const systemPrompt = [
    '你是任務分類器。根據使用者輸入判斷最適合的開發 pipeline。',
    '只回覆一個 JSON 物件：{"pipeline":"<id>"}',
    '',
    '可用 pipeline：',
    catalog,
    '',
    '分類原則：',
    '- 問問題、查資料、探索 → none',
    '- 修 typo、改名、一行修改 → fix',
    '- Bug 修復、小功能補丁 → quick-dev',
    '- 新功能、新系統、新模組 → standard（無 UI）或 full（含 UI）',
    '- 重構 → standard',
    '- TDD 工作流 → test-first',
    '- 純 UI/樣式 → ui-only',
    '- 純文件 → docs-only',
    '- 安全修復 → security',
  ].join('\n');

  const body = JSON.stringify({
    model: LLM_MODEL,
    max_tokens: 60,
    messages: [{ role: 'user', content: prompt.slice(0, 500) }],
    system: systemPrompt,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try {
          const parsed = JSON.parse(data);
          const text = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
          const match = text.match(/\{[^}]+\}/);
          if (!match) { resolve(null); return; }
          const result = JSON.parse(match[0]);
          if (!result.pipeline || !PIPELINES[result.pipeline]) { resolve(null); return; }
          resolve({ pipeline: result.pipeline, confidence: 0.85, source: 'llm' });
        } catch (_) { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(LLM_TIMEOUT, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * 產生 Pipeline 目錄提示（LLM 降級時注入 additionalContext）
 * @returns {string}
 */
function buildPipelineCatalogHint() {
  const catalog = Object.entries(PIPELINES)
    .filter(([id]) => id !== 'none')
    .map(([id, p]) => `  [pipeline:${id}] — ${p.label}：${p.description}`)
    .join('\n');

  return '\n💡 分類器信心度偏低。如果自動選擇不正確，可在 prompt 中加上語法覆寫：\n' + catalog;
}

// ═══════════════════════════════════════════════
// Adaptive Confidence（動態閾值）
// ═══════════════════════════════════════════════

/** classifier-stats.json 路徑 */
const STATS_PATH = require('path').join(require('os').homedir(), '.claude', 'classifier-stats.json');

/**
 * 計算自適應 Layer 2→3 降級閾值
 *
 * 優先級：VIBE_CLASSIFIER_THRESHOLD 環境變數 > 自適應 > 預設 0.7
 *
 * 自適應邏輯：讀取 classifier-stats.json 的 recentWindow 滑動窗口，
 * 計算 Layer 2 分類的修正率（corrected=true 的比例）。
 * - 樣本 < 10 → 不啟用，保持 0.7
 * - 修正率 > 30% → 降為 0.5（觸發更多 Layer 3）
 * - 否則 → 保持 0.7
 *
 * @returns {number} 閾值 0~1
 */
function getAdaptiveThreshold() {
  // 環境變數最高優先
  const envVal = parseFloat(process.env.VIBE_CLASSIFIER_THRESHOLD);
  if (!Number.isNaN(envVal)) return envVal;

  // 讀取統計檔案
  try {
    const fs = require('fs');
    if (!fs.existsSync(STATS_PATH)) return 0.7;
    const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    const window = stats.recentWindow || [];

    // 只計算 Layer 2 的修正率
    const layer2 = window.filter(r => r.layer === 2);
    if (layer2.length < 10) return 0.7;

    const corrected = layer2.filter(r => r.corrected).length;
    const rate = corrected / layer2.length;
    return rate > 0.3 ? 0.5 : 0.7;
  } catch (_) {
    return 0.7;
  }
}

// ═══════════════════════════════════════════════
// 匯出
// ═══════════════════════════════════════════════

module.exports = {
  // 舊版介面（向後相容）
  classify,
  isStrongQuestion,

  // 新版介面
  extractExplicitPipeline,
  classifyWithConfidence,

  // Adaptive Confidence
  getAdaptiveThreshold,

  // Layer 3 LLM
  classifyWithLLM,
  buildPipelineCatalogHint,

  // 匯出常量供測試驗證
  STRONG_QUESTION,
  TRIVIAL,
  WEAK_EXPLORE,
  ACTION_PATTERNS,
  LLM_MODEL,
  LLM_TIMEOUT,
  LLM_CONFIDENCE_THRESHOLD, // deprecated: 保留供既有測試向後相容
  STATS_PATH,
};
