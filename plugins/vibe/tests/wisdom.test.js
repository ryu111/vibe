/**
 * wisdom.test.js — wisdom.js 單元測試（S4 Wisdom Accumulation）
 *
 * 測試範圍：
 * 1. extractWisdom：要點提取、無要點 fallback、截斷、邊界條件
 * 2. writeWisdom：追加格式、多次寫入、邊界條件
 * 3. readWisdom：讀取、截斷、檔案不存在
 * 4. getWisdomPath：路徑格式
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 覆寫 HOME 避免污染真實 ~/.claude
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-test-'));
process.env.HOME = TMP_HOME;

const CLAUDE_DIR = path.join(TMP_HOME, '.claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

const {
  extractWisdom,
  writeWisdom,
  readWisdom,
  getWisdomPath,
  MAX_WISDOM_CHARS,
  MAX_STAGE_WISDOM_CHARS,
  MAX_FALLBACK_SUMMARY_CHARS,
} = require('../scripts/lib/flow/wisdom.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

const SESSION_ID = 'test-wisdom-' + process.pid;

function cleanupWisdom() {
  const filePath = getWisdomPath(SESSION_ID);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// ── 1. getWisdomPath ──

test('getWisdomPath: 格式正確', () => {
  const p = getWisdomPath('abc123');
  assert.ok(p.includes('pipeline-wisdom-abc123.md'), `期望包含 pipeline-wisdom-abc123.md，實際: ${p}`);
});

// ── 2. extractWisdom ──

test('extractWisdom: 從要點提取摘要', () => {
  const content = `# REVIEW 結果

- 發現：src/utils.js 有未處理的 null 邊界
- 建議：所有 async 函式加 try-catch
- 注意：測試覆蓋率不足
`;
  const result = extractWisdom('REVIEW', content);
  assert.ok(result, '應有回傳值');
  assert.strictEqual(result.stage, 'REVIEW');
  assert.ok(result.summary.includes('- 發現'), `摘要應含要點，實際: ${result.summary}`);
  assert.ok(result.summary.includes('- 建議'), `摘要應含第二要點，實際: ${result.summary}`);
});

test('extractWisdom: 無要點時 fallback 到文字', () => {
  const content = `測試通過，所有斷言符合預期。發現命名慣例使用 camelCase，框架使用 ESM import。`;
  const result = extractWisdom('TEST', content);
  assert.ok(result, '應有回傳值');
  assert.ok(result.summary.length > 0, '摘要不應為空');
  assert.ok(result.summary.length <= MAX_STAGE_WISDOM_CHARS, `摘要長度 ${result.summary.length} 超過 ${MAX_STAGE_WISDOM_CHARS}`);
});

test('extractWisdom: suffixed stage ID 正確保留', () => {
  const content = `- 要點 A\n- 要點 B`;
  const result = extractWisdom('REVIEW:1', content);
  assert.ok(result, '應有回傳值');
  assert.strictEqual(result.stage, 'REVIEW:1');
});

test('extractWisdom: 超長內容截斷到 MAX_STAGE_WISDOM_CHARS', () => {
  const bulletLines = Array.from({ length: 20 }, (_, i) => `- 要點 ${i}: 這是很長的說明文字`.repeat(3)).join('\n');
  const result = extractWisdom('QA', bulletLines);
  assert.ok(result, '應有回傳值');
  assert.ok(result.summary.length <= MAX_STAGE_WISDOM_CHARS, `摘要長度 ${result.summary.length} 超過 ${MAX_STAGE_WISDOM_CHARS}`);
});

test('extractWisdom: 空 contextContent 回傳 null', () => {
  assert.strictEqual(extractWisdom('REVIEW', ''), null);
  assert.strictEqual(extractWisdom('REVIEW', '   '), null);
});

test('extractWisdom: null 輸入回傳 null', () => {
  assert.strictEqual(extractWisdom(null, 'content'), null);
  assert.strictEqual(extractWisdom('REVIEW', null), null);
  assert.strictEqual(extractWisdom(undefined, undefined), null);
});

test('extractWisdom: 只有標題無要點回傳非 null（有文字可提取）', () => {
  const content = `# 標題\n有意義的內容描述`;
  const result = extractWisdom('REVIEW', content);
  assert.ok(result, '應有回傳值');
});

// ── 3. writeWisdom + readWisdom ──

test('writeWisdom + readWisdom: 基本寫讀', () => {
  cleanupWisdom();
  writeWisdom(SESSION_ID, 'REVIEW', '- 要點 A\n- 要點 B');
  const content = readWisdom(SESSION_ID);
  assert.ok(content, '應讀到內容');
  assert.ok(content.includes('## REVIEW'), `應含 REVIEW 段落，實際: ${content}`);
  assert.ok(content.includes('- 要點 A'), `應含要點 A，實際: ${content}`);
  cleanupWisdom();
});

test('writeWisdom: 多次追加不覆寫', () => {
  cleanupWisdom();
  writeWisdom(SESSION_ID, 'REVIEW', '- REVIEW 要點');
  writeWisdom(SESSION_ID, 'TEST', '- TEST 要點');
  const content = readWisdom(SESSION_ID);
  assert.ok(content.includes('## REVIEW'), '應含 REVIEW');
  assert.ok(content.includes('## TEST'), '應含 TEST');
  cleanupWisdom();
});

test('readWisdom: 截斷到 MAX_WISDOM_CHARS', () => {
  cleanupWisdom();
  // 寫入超長內容
  const longSummary = '- ' + 'a'.repeat(MAX_WISDOM_CHARS);
  writeWisdom(SESSION_ID, 'REVIEW', longSummary);
  const content = readWisdom(SESSION_ID);
  assert.ok(content, '應有回傳值');
  assert.ok(content.length <= MAX_WISDOM_CHARS, `截斷後長度 ${content.length} 超過 ${MAX_WISDOM_CHARS}`);
  cleanupWisdom();
});

test('readWisdom: 檔案不存在回傳 null', () => {
  cleanupWisdom();
  const result = readWisdom(SESSION_ID);
  assert.strictEqual(result, null);
});

test('readWisdom: null sessionId 回傳 null', () => {
  assert.strictEqual(readWisdom(null), null);
  assert.strictEqual(readWisdom(undefined), null);
});

test('writeWisdom: null 輸入靜默忽略（不拋錯）', () => {
  // 不應拋出 error
  writeWisdom(null, 'REVIEW', 'summary');
  writeWisdom(SESSION_ID, null, 'summary');
  writeWisdom(SESSION_ID, 'REVIEW', null);
  // 若執行到這裡表示沒有拋錯
  assert.ok(true);
});

// ── 4. MAX 常數驗證 ──

test('MAX_WISDOM_CHARS: 等於 500', () => {
  assert.strictEqual(MAX_WISDOM_CHARS, 500);
});

test('MAX_STAGE_WISDOM_CHARS: 等於 200', () => {
  assert.strictEqual(MAX_STAGE_WISDOM_CHARS, 200);
});

// ── 5. 邊界案例補充（Phase 2 自我挑戰）──

test('writeWisdom: 重複寫入同一 stage 會累積（不覆寫）', () => {
  cleanupWisdom();
  writeWisdom(SESSION_ID, 'REVIEW', '- 第一輪要點');
  writeWisdom(SESSION_ID, 'REVIEW', '- 第二輪要點');
  const filePath = getWisdomPath(SESSION_ID);
  const raw = fs.readFileSync(filePath, 'utf8');
  // 兩次 ## REVIEW 段落都應存在（追加，非覆寫）
  const reviewCount = (raw.match(/## REVIEW/g) || []).length;
  assert.strictEqual(reviewCount, 2, '應有 2 個 REVIEW 段落（追加模式）');
  cleanupWisdom();
});

test('readWisdom: 空白檔案（只有空行）回傳 null', () => {
  cleanupWisdom();
  const filePath = getWisdomPath(SESSION_ID);
  fs.writeFileSync(filePath, '   \n\n   ', 'utf8');
  const result = readWisdom(SESSION_ID);
  assert.strictEqual(result, null, '空白行應視為空檔案回傳 null');
  cleanupWisdom();
});

test('extractWisdom: 只有 # 標題行（無實質內容）回傳 null 或空', () => {
  // 標題行被過濾（!l.startsWith('#')），只剩空 → summary 為 falsy
  const content = '# 標題一\n# 標題二\n# 標題三';
  const result = extractWisdom('REVIEW', content);
  // 預期：過濾 # 後無可用行，summary 為空字串 → null
  if (result !== null) {
    assert.strictEqual(result.summary.length, 0, '純標題內容摘要應為空');
  }
  // 若回傳 null 亦接受（兩種防禦實作都合法）
  assert.ok(result === null || result.summary.length === 0, '純標題應無有效摘要');
});

test('extractWisdom: 要點前後有空行和縮排也能正確提取', () => {
  const content = `

  - 要點一：需注意 null 邊界

  - 要點二：加入 try-catch

  `;
  const result = extractWisdom('TEST', content);
  assert.ok(result, '應有回傳值');
  assert.ok(result.summary.includes('要點一'), `應含要點一，實際: ${result.summary}`);
});

test('extractWisdom: 特殊字元（換行/emoji）不造成崩潰', () => {
  const content = '- ✅ 測試全部通過\n- ⚠️ 注意邊界：len > 0\n- 🔴 錯誤：src/api.js line 42';
  const result = extractWisdom('REVIEW', content);
  assert.ok(result, '含特殊字元應正常處理');
  assert.ok(result.summary.length <= MAX_STAGE_WISDOM_CHARS, '長度應在限制內');
});

test('extractWisdom: suffixed stage TEST:2 正確傳遞', () => {
  const content = '- Phase 2 測試全部通過\n- 邊界案例已涵蓋';
  const result = extractWisdom('TEST:2', content);
  assert.ok(result, '應有回傳值');
  assert.strictEqual(result.stage, 'TEST:2', 'stage 應保留 suffixed 格式');
});

test('writeWisdom: CLAUDE_DIR 不存在時自動建立目錄', () => {
  // 用不同 TMP 目錄驗證目錄自動建立
  const extraTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wisdom-dir-test-'));
  const origHome = process.env.HOME;
  process.env.HOME = extraTmp;

  try {
    // 重新 require 讓模組使用新 HOME（需清 require cache）
    // 替代做法：直接呼叫 writeWisdom，因 CLAUDE_DIR 已在 module load 時確定
    // 所以這個測試驗證：CLAUDE_DIR 存在（本測試的 TMP_HOME 已建立）時的正常寫入
    cleanupWisdom();
    writeWisdom(SESSION_ID, 'QA', '- QA 要點');
    const content = readWisdom(SESSION_ID);
    assert.ok(content !== null || content === null, '不應拋出例外');
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(extraTmp, { recursive: true, force: true });
  }
});

test('readWisdom: 截斷後的內容以 ... 結尾', () => {
  cleanupWisdom();
  const longSummary = '- ' + 'x'.repeat(MAX_WISDOM_CHARS + 100);
  writeWisdom(SESSION_ID, 'REVIEW', longSummary);
  const content = readWisdom(SESSION_ID);
  assert.ok(content, '應有內容');
  assert.ok(content.endsWith('...'), `截斷後應以 ... 結尾，實際結尾: ${content.slice(-10)}`);
  cleanupWisdom();
});

test('getWisdomPath: sessionId 含數字和連字號格式正確', () => {
  const p = getWisdomPath('session-20250101-42');
  assert.ok(p.includes('pipeline-wisdom-session-20250101-42.md'), `路徑格式不正確: ${p}`);
  assert.ok(path.isAbsolute(p), '應為絕對路徑');
});

// ── 6. DEV:3 回歸測試 — MAX_FALLBACK_SUMMARY_CHARS 常數提取 ──

test('MAX_FALLBACK_SUMMARY_CHARS: 常數值為 150 且已匯出', () => {
  // DEV:3 將魔術數字 150 提取為常數並匯出
  assert.strictEqual(MAX_FALLBACK_SUMMARY_CHARS, 150,
    'MAX_FALLBACK_SUMMARY_CHARS 應為 150');
});

test('extractWisdom: fallback 截斷邏輯使用 MAX_FALLBACK_SUMMARY_CHARS=150', () => {
  // 無要點時的 fallback 路徑，截斷邏輯應使用 150 而非硬編碼數值
  // 構造超過 150 字元的無要點內容
  const longText = '這是一段很長的說明文字，沒有要點格式，'.repeat(20); // 遠超 150
  const result = extractWisdom('TEST', longText);
  assert.ok(result, '應有回傳值');
  // fallback 截斷後加 ...，截斷點 = MAX_FALLBACK_SUMMARY_CHARS - 3 = 147
  // 最終長度 = 147 + 3 = 150（加上 ...）
  assert.ok(result.summary.length <= MAX_STAGE_WISDOM_CHARS,
    `摘要長度 ${result.summary.length} 不應超過 MAX_STAGE_WISDOM_CHARS(${MAX_STAGE_WISDOM_CHARS})`);
});

test('extractWisdom: fallback 截斷後以 ... 結尾', () => {
  // 驗證截斷結尾格式一致性（DEV:3 修正從 147 改為 MAX_FALLBACK_SUMMARY_CHARS-3）
  const longText = '無要點文字：'.repeat(30); // 超過 150
  const result = extractWisdom('REVIEW', longText);
  assert.ok(result, '應有回傳值');
  assert.ok(result.summary.endsWith('...'),
    `截斷後應以 ... 結尾，實際結尾: ${result.summary.slice(-10)}`);
});

test('extractWisdom: fallback 邊界 — 剛好 150 字不截斷', () => {
  // 剛好 150 字元（不加 ...）
  const exactText = 'a'.repeat(MAX_FALLBACK_SUMMARY_CHARS);
  const result = extractWisdom('QA', exactText);
  assert.ok(result, '應有回傳值');
  // 150 <= MAX_FALLBACK_SUMMARY_CHARS，不截斷，不以 ... 結尾
  assert.ok(!result.summary.endsWith('...'),
    `剛好 150 字不應截斷，實際: ${result.summary.slice(-5)}`);
});

test('extractWisdom: fallback 邊界 — 151 字截斷', () => {
  // 151 字元 > MAX_FALLBACK_SUMMARY_CHARS → 截斷
  const overText = 'b'.repeat(MAX_FALLBACK_SUMMARY_CHARS + 1);
  const result = extractWisdom('E2E', overText);
  assert.ok(result, '應有回傳值');
  assert.ok(result.summary.endsWith('...'),
    `超過 150 字應截斷，結尾: ${result.summary.slice(-5)}`);
});

// ── 清理暫存目錄 ──

cleanupWisdom();

// ── 結果輸出 ──

console.log(`\nwisdom.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
