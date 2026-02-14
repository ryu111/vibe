#!/usr/bin/env node
/**
 * classifier.js — 兩階段級聯分類器（Cascading Classifier）
 *
 * 設計原則：
 *   誤觸 pipeline（false positive）代價 >> 漏觸 pipeline（false negative）
 *   → 疑問句永遠優先於動作關鍵字
 *   → 使用者可用 /vibe:scope 明確啟動 pipeline，不需靠分類器猜
 *
 * 分類流程：
 *   Phase 1:  Strong Question Guard — 多層疑問信號（最高優先級）
 *   Phase 2:  Trivial Detection — hello world / poc / demo
 *   Phase 3:  Weak Explore — 看看 / 查看 / 說明 等探索詞
 *   Phase 4:  Action Keywords — tdd / feature / refactor / bugfix
 *   Default:  quickfix（保守，不鎖定 pipeline）
 *
 * @module flow/classifier
 */
'use strict';

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
 * 兩階段級聯分類
 * @param {string} prompt - 使用者輸入（原始文字）
 * @returns {string} 任務類型：research|quickfix|tdd|test|refactor|feature|bugfix
 */
function classify(prompt) {
  if (!prompt) return 'quickfix';
  const p = prompt.toLowerCase();

  // Phase 1: 強疑問信號 — 最高優先級，無法被動作關鍵字覆蓋
  if (isStrongQuestion(p)) return 'research';

  // Phase 2: Trivial 偵測（hello world, poc, demo 等簡單意圖）
  if (TRIVIAL.test(p)) return 'quickfix';

  // Phase 3: 弱探索信號（在 trivial 之後）
  if (WEAK_EXPLORE.test(p)) return 'research';

  // Phase 4: 動作分類（only if NOT question, NOT trivial, NOT exploration）
  for (const { type, pattern } of ACTION_PATTERNS) {
    if (pattern.test(p)) return type;
  }

  // 預設：quickfix（保守 — 僅 DEV 階段，不鎖定 pipeline 模式）
  return 'quickfix';
}

module.exports = {
  classify,
  isStrongQuestion,
  // 匯出常量供測試驗證
  STRONG_QUESTION,
  TRIVIAL,
  WEAK_EXPLORE,
  ACTION_PATTERNS,
};
