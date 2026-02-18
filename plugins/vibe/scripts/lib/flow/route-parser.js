#!/usr/bin/env node
/**
 * route-parser.js — PIPELINE_ROUTE 協議解析器（v4）
 *
 * 從 Sub-agent 的 transcript JSONL 解析結構化路由指令。
 * 取代 v3 的 PIPELINE_VERDICT regex 解析。
 *
 * 流程：
 * 1. parseRoute：從 transcript 解析 PIPELINE_ROUTE JSON
 *    - 掃描最後 30 行 assistant message（JSONL 格式）
 *    - 找不到 PIPELINE_ROUTE 時 fallback 到 v3 PIPELINE_VERDICT
 * 2. validateRoute：Schema Validation（必填欄位、合法值、補完缺漏）
 * 3. enforcePolicy：Policy Enforcement（防止邏輯矛盾、無限循環）
 *
 * @module flow/route-parser
 */
'use strict';

const fs = require('fs');
const { PIPELINE_ROUTE_REGEX, VERDICT_REGEX, QUALITY_STAGES, MAX_RETRIES } = require('../registry.js');

// 合法的路由值
const VALID_VERDICTS = new Set(['PASS', 'FAIL']);
const VALID_ROUTES = new Set(['NEXT', 'DEV', 'BARRIER', 'COMPLETE', 'ABORT']);
const VALID_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

// 掃描最後幾行 transcript（PIPELINE_ROUTE 通常在最後）
const SCAN_LAST_LINES = 30;

// ────────────────── 1. parseRoute ──────────────────

/**
 * 從 JSONL transcript 解析最後的 PIPELINE_ROUTE 標記。
 *
 * 策略：
 * - 掃描最後 SCAN_LAST_LINES 行
 * - 每行嘗試 JSON.parse，提取 assistant message 的文字內容
 * - 用 PIPELINE_ROUTE_REGEX 從文字中提取 JSON
 * - 找到後立即 return（取最後一次出現）
 * - 找不到則 fallback 到 v3 PIPELINE_VERDICT
 *
 * @param {string} transcriptPath - JSONL transcript 路徑
 * @returns {{ parsed: Object|null, source: 'route'|'verdict-fallback'|'none' }}
 */
function parseRoute(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { parsed: null, source: 'none' };
  }

  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch (_) {
    return { parsed: null, source: 'none' };
  }

  const lines = content.trim().split('\n');
  const startIdx = Math.max(0, lines.length - SCAN_LAST_LINES);
  const recentLines = lines.slice(startIdx);

  // 從後往前掃描，優先取最後出現的
  let lastRouteJson = null;
  let lastVerdictRaw = null;

  for (let i = recentLines.length - 1; i >= 0; i--) {
    const line = recentLines[i];
    if (!line.trim()) continue;

    let text = line;

    // 嘗試從 JSONL 條目提取文字
    try {
      const entry = JSON.parse(line);
      const entryText = extractTextFromEntry(entry);
      if (entryText) text = entryText;
    } catch (_) {
      // 非 JSON 行，直接用原始文字搜尋
    }

    // 搜尋 PIPELINE_ROUTE
    if (lastRouteJson === null) {
      const routeMatch = text.match(PIPELINE_ROUTE_REGEX);
      if (routeMatch) {
        try {
          lastRouteJson = JSON.parse(routeMatch[1]);
        } catch (_) {
          // JSON 解析失敗，繼續往前找
        }
      }
    }

    // 搜尋 v3 PIPELINE_VERDICT（fallback 用）
    if (lastVerdictRaw === null) {
      const verdictMatch = text.match(VERDICT_REGEX);
      if (verdictMatch) {
        lastVerdictRaw = verdictMatch[1];
      }
    }

    // 兩者都找到就停止
    if (lastRouteJson !== null && lastVerdictRaw !== null) break;
  }

  // PIPELINE_ROUTE 優先
  if (lastRouteJson !== null) {
    return { parsed: lastRouteJson, source: 'route' };
  }

  // Fallback：將 PIPELINE_VERDICT 轉換為 ROUTE 格式
  if (lastVerdictRaw !== null) {
    const converted = convertVerdictToRoute(lastVerdictRaw);
    return { parsed: converted, source: 'verdict-fallback' };
  }

  // 第三層 Fallback：從 transcript 內容推斷路由
  // 品質 stage agent 有時完成了審查/測試工作但忘記輸出 PIPELINE_ROUTE 標記，
  // 此時 transcript 中仍包含可推斷的內容（如 "0 CRITICAL" / "20/20 通過"）
  const inferred = inferRouteFromContent(recentLines);
  if (inferred) {
    return { parsed: inferred, source: 'content-inference' };
  }

  return { parsed: null, source: 'none' };
}

// ────────────────── 1b. inferRouteFromContent ──────────────────

/**
 * 從 transcript 最近的 assistant messages 推斷路由。
 *
 * 當 PIPELINE_ROUTE 和 PIPELINE_VERDICT 都找不到時，掃描 agent 輸出文字內容，
 * 使用確定性 regex 提取語意信號（PASS/FAIL + severity）。
 *
 * 信號優先序：
 * 1. 強 FAIL 信號：明確 CRITICAL/HIGH 問題計數 > 0
 * 2. 強 PASS 信號：明確 0 CRITICAL + 0 HIGH / "全部通過" / "PASS"
 * 3. 弱 PASS 信號：agent 有大量輸出（做了實質工作）但無 FAIL 信號
 * 4. 無法推斷 → null
 *
 * @param {string[]} recentLines - parseRoute 已切好的最近 SCAN_LAST_LINES 行
 * @returns {Object|null} RouteResult（{ verdict, route, ... }）或 null
 */
function inferRouteFromContent(recentLines) {
  if (!recentLines || recentLines.length === 0) return null;

  // 收集所有 assistant text
  const assistantTexts = [];
  for (const line of recentLines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // assistant message
      if (entry.role === 'assistant' || entry.type === 'assistant') {
        const text = extractTextFromEntry(entry);
        if (text) assistantTexts.push(text);
      }
    } catch (_) {
      // 非 JSON 行，直接檢查
      assistantTexts.push(line);
    }
  }

  if (assistantTexts.length === 0) return null;

  const combined = assistantTexts.join('\n');

  // ── 強 FAIL 信號：CRITICAL/HIGH 問題計數 > 0 ──
  // 匹配 "CRITICAL: 2" / "CRITICAL：2" / "3 個 CRITICAL" 等
  const criticalCount = extractIssueCount(combined, 'CRITICAL');
  const highCount = extractIssueCount(combined, 'HIGH');

  if (criticalCount > 0) {
    return {
      verdict: 'FAIL',
      route: 'DEV',
      severity: 'CRITICAL',
      hint: `推斷：${criticalCount} CRITICAL issue(s)`,
      _inferred: true,
    };
  }

  if (highCount > 0) {
    return {
      verdict: 'FAIL',
      route: 'DEV',
      severity: 'HIGH',
      hint: `推斷：${highCount} HIGH issue(s)`,
      _inferred: true,
    };
  }

  // ── 強 PASS 信號 ──
  const passPatterns = [
    /0\s*(?:個\s*)?CRITICAL/i,
    /CRITICAL\s*[:：]\s*0/i,
    /0\s*(?:個\s*)?HIGH/i,
    /HIGH\s*[:：]\s*0/i,
    /全部通過/,
    /all\s+pass/i,
    /測試通過/,
    /\d+\/\d+\s*(?:測試)?通過/,  // "20/20 通過" / "20/20 測試通過"
    /整體評估\s*[:：]\s*(?:良好|通過|合格|無|沒有)/,
    /無\s*(?:嚴重|重大)\s*問題/,
    /(?:審查|review)\s*完成/i,
    /tester\s*測試撰寫完成/i,
    /code\s*reviewer\s*審查完成/i,
  ];

  for (const pat of passPatterns) {
    if (pat.test(combined)) {
      return {
        verdict: 'PASS',
        route: 'NEXT',
        _inferred: true,
      };
    }
  }

  // ── 弱 PASS 信號：agent 有大量輸出但無 FAIL 信號 ──
  // 200 字元以上的 assistant 輸出 + 無 CRITICAL/HIGH 關鍵字 → 推斷為 PASS
  if (combined.length > 200 && !hasFAILSignal(combined)) {
    return {
      verdict: 'PASS',
      route: 'NEXT',
      _inferred: true,
    };
  }

  return null;
}

/**
 * 從文字中提取指定嚴重程度的問題計數
 *
 * 匹配模式：
 * - "CRITICAL: 2" / "CRITICAL：2"
 * - "2 個 CRITICAL" / "2 CRITICAL"
 * - "🔴 CRITICAL" 區塊後有 "#### [C-1]" 子標題（計數 C-N 標題數）
 *
 * @param {string} text - 掃描文字
 * @param {string} severity - 'CRITICAL' | 'HIGH'
 * @returns {number} 問題計數（0 = 找不到或明確為 0）
 */
function extractIssueCount(text, severity) {
  // 模式 1：明確計數 "SEVERITY: N" / "SEVERITY：N"
  const countAfter = new RegExp(`${severity}\\s*[:：]\\s*(\\d+)`, 'i');
  const m1 = text.match(countAfter);
  if (m1) return parseInt(m1[1], 10);

  // 模式 2："N 個 SEVERITY" / "N SEVERITY"
  const countBefore = new RegExp(`(\\d+)\\s*(?:個\\s*)?${severity}`, 'i');
  const m2 = text.match(countBefore);
  if (m2) return parseInt(m2[1], 10);

  // 模式 3：存在 "### 🔴 CRITICAL" 區塊標題（有區塊 = 至少 1 個問題）
  const sectionHeader = severity === 'CRITICAL'
    ? /###\s*🔴\s*CRITICAL/
    : /###\s*🟠\s*HIGH/;
  if (sectionHeader.test(text)) return 1;

  return 0;
}

/**
 * 檢查文字中是否有 FAIL 語意信號（用於弱 PASS 判斷的排除條件）
 */
function hasFAILSignal(text) {
  const failPatterns = [
    /\bCRITICAL\b/i,     // 任何 CRITICAL 提及（不含 "0 CRITICAL"）
    /\bfail/i,            // "fail" / "failed" / "failure"
    /測試失敗/,
    /嚴重問題/,
    /安全漏洞/,
  ];

  for (const pat of failPatterns) {
    if (pat.test(text)) {
      // 排除 "0 CRITICAL" / "CRITICAL: 0" 的 false positive
      if (/CRITICAL/i.test(pat.source)) {
        if (/0\s*(?:個\s*)?CRITICAL/i.test(text) || /CRITICAL\s*[:：]\s*0/i.test(text)) {
          continue; // "0 CRITICAL" 不算 FAIL
        }
      }
      return true;
    }
  }
  return false;
}

/**
 * 從 JSONL 條目提取文字內容（assistant message）
 */
function extractTextFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  // SubagentStop JSONL 結構：entry.message.content[].text
  const content = entry.message?.content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
    if (textParts) return textParts;
  }

  // 有時候直接是 text 字串
  if (typeof entry.text === 'string') return entry.text;

  // content 直接是字串
  if (typeof entry.message?.content === 'string') return entry.message.content;

  // 也試試整個 JSON 字串化（用於巢狀結構中的 HTML 註解搜尋）
  // C-1 修正：此 fallback 路徑必須回傳**含 <!-- --> 包裹的完整字串**，
  //          而非 routeMatch[1]（只有 JSON 內容），因為外層 parseRoute
  //          會對回傳值再次執行 PIPELINE_ROUTE_REGEX.match()，
  //          必須含有 <!-- PIPELINE_ROUTE: ... --> 標記才能匹配。
  const json = JSON.stringify(entry);
  const routeMatch = json.match(PIPELINE_ROUTE_REGEX);
  if (routeMatch) {
    // 回傳完整的原始標記字串（routeMatch[0] 是完整匹配，含 <!-- -->）
    return routeMatch[0];
  }

  return null;
}

/**
 * 將 v3 PIPELINE_VERDICT 字串轉換為 v4 ROUTE 格式
 *
 * 回退相容性：保留 v3 shouldRetryStage 的 severity 規則：
 * - PASS → route='NEXT'
 * - FAIL:CRITICAL/HIGH → route='DEV'（觸發回退）
 * - FAIL:MEDIUM/LOW → route='NEXT'（不回退，只是警告）
 * - FAIL（無 severity） → route='DEV'（視為嚴重）
 *
 * @param {string} raw - e.g. 'PASS' | 'FAIL:HIGH' | 'FAIL:CRITICAL'
 * @returns {Object} RouteResult
 */
function convertVerdictToRoute(raw) {
  if (raw === 'PASS') {
    return { verdict: 'PASS', route: 'NEXT' };
  }

  const parts = raw.split(':');
  const verdict = parts[0] || 'FAIL';
  const severity = parts[1] || null;
  const normalizedSeverity = VALID_SEVERITIES.has(severity) ? severity : 'HIGH';

  // MEDIUM/LOW 不觸發回退（與 v3 shouldRetryStage 行為一致）
  const needsRetry = normalizedSeverity !== 'MEDIUM' && normalizedSeverity !== 'LOW';

  return {
    verdict,
    route: needsRetry ? 'DEV' : 'NEXT',
    severity: normalizedSeverity,
  };
}

// ────────────────── 2. validateRoute ──────────────────

/**
 * Schema Validation：驗證並補完 PIPELINE_ROUTE 物件。
 *
 * 補完規則：
 * - FAIL 缺 severity → 補 MEDIUM
 * - route 不合法 → 修正（PASS→NEXT，FAIL→DEV）
 * - BARRIER 缺 barrierGroup → 補 default
 *
 * @param {Object|null} parsed - parseRoute 回傳的 parsed 物件
 * @returns {{ route: Object|null, warnings: string[] }}
 */
function validateRoute(parsed) {
  const warnings = [];

  if (!parsed || typeof parsed !== 'object') {
    return { route: null, warnings: ['route is null or not an object'] };
  }

  const route = { ...parsed };

  // 驗證 verdict
  if (!VALID_VERDICTS.has(route.verdict)) {
    warnings.push(`invalid verdict: ${route.verdict}, defaulting to PASS`);
    route.verdict = 'PASS';
  }

  // 驗證 route
  if (!VALID_ROUTES.has(route.route)) {
    const defaultRoute = route.verdict === 'PASS' ? 'NEXT' : 'DEV';
    warnings.push(`invalid route: ${route.route}, defaulting to ${defaultRoute}`);
    route.route = defaultRoute;
  }

  // FAIL 缺 severity → 補 MEDIUM
  if (route.verdict === 'FAIL' && !VALID_SEVERITIES.has(route.severity)) {
    warnings.push(`FAIL missing valid severity, defaulting to MEDIUM`);
    route.severity = 'MEDIUM';
  }

  // PASS 不應有 severity（清理，不觸發警告）
  if (route.verdict === 'PASS' && route.severity) {
    delete route.severity;
  }

  // BARRIER route 必須有 barrierGroup
  if (route.route === 'BARRIER' && !route.barrierGroup) {
    warnings.push('BARRIER route missing barrierGroup, defaulting to "default"');
    route.barrierGroup = 'default';
  }

  // hint 長度限制（截斷超過 200 字的 hint）
  if (route.hint && typeof route.hint === 'string' && route.hint.length > 200) {
    route.hint = route.hint.slice(0, 200);
    warnings.push('hint truncated to 200 chars');
  }

  // M-1 修正：sanitize hint 中的 `-->` 序列
  // PIPELINE_ROUTE_REGEX 使用 `[\s\S]*?` 非貪婪匹配，但若 hint 字串包含 `-->`，
  // 會提前截斷 HTML 註解，導致 JSON 不完整。替換為 `→`（Unicode 箭頭）。
  if (route.hint && typeof route.hint === 'string' && route.hint.includes('-->')) {
    route.hint = route.hint.replace(/-->/g, '→');
    warnings.push('hint contained "-->" which was replaced with "→" to avoid regex issues');
  }

  return { route, warnings };
}

// ────────────────── 3. enforcePolicy ──────────────────

/**
 * Policy Enforcement：防止路由邏輯矛盾和無限循環。
 *
 * 規則：
 * 1. PASS + route=DEV → 強制改為 NEXT（邏輯矛盾）
 * 2. retries >= maxRetries → 強制改為 NEXT（防無限循環）
 * 3. DAG 中無 DEV stage → route=DEV 強制改為 NEXT
 * 4. 並行節點 → route 必須是 BARRIER（此規則在 Phase 4 才完整實作）
 *
 * @param {Object} route - validateRoute 回傳的 route 物件
 * @param {Object} state - pipeline state（含 dag / retries）
 * @param {string} stage - 當前階段 ID
 * @returns {{ route: Object, enforced: boolean, reason?: string }}
 */
function enforcePolicy(route, state, stage) {
  if (!route) return { route, enforced: false };

  const enforced = { ...route };
  let reason = null;

  // 規則 1：PASS + route=DEV → 邏輯矛盾，強制 NEXT
  if (enforced.verdict === 'PASS' && enforced.route === 'DEV') {
    reason = 'PASS verdict cannot route to DEV, forcing NEXT';
    enforced.route = 'NEXT';
  }

  // 規則 2：retries >= maxRetries → 強制 NEXT（達到回退上限）
  const retryCount = (state?.retries?.[stage] || 0);
  if (enforced.route === 'DEV' && retryCount >= MAX_RETRIES) {
    reason = `retry limit reached (${retryCount}/${MAX_RETRIES}), forcing NEXT`;
    enforced.route = 'NEXT';
    // 同時標記上限達到
    enforced._retryExhausted = true;
  }

  // 規則 3：DAG 中無 DEV stage → route=DEV 強制改為 NEXT
  if (enforced.route === 'DEV') {
    const dag = state?.dag || {};
    const hasDev = Object.keys(dag).some(s => {
      // 使用 split(':')[0] 取得 base stage（與 getBaseStage 慣例一致）
      const base = s.split(':')[0];
      return base === 'DEV';
    });
    if (!hasDev) {
      reason = 'no DEV stage in DAG, forcing NEXT';
      enforced.route = 'NEXT';
    }
  }

  // 規則 4：並行節點（stage 有 barrier 配置）→ 強制 route=BARRIER
  // H-1 修正：agent 輸出 route=NEXT 時，若 DAG 節點有 barrier 配置，
  //          且該 barrier group 的其他 siblings 有在 active/pending 狀態
  //          （即確實是並行執行場景），才強制改為 BARRIER。
  //
  // 設計考量：
  // - 只有在確實並行場景才強制（避免破壞線性執行的 REVIEW/TEST 回退邏輯）
  // - 判斷依據：barrier.siblings 中是否有其他 stage 也在 active/pending（需等待）
  // - 若 siblings 全部已完成或只剩自己 → 不強制（視為線性完成，走正常路由）
  if (state?.dag?.[stage]?.barrier && enforced.route !== 'BARRIER') {
    const barrierConfig = state.dag[stage].barrier;
    const siblings = barrierConfig.siblings || [];
    const otherSiblings = siblings.filter(s => s !== stage);

    // 檢查是否有其他 siblings 確實在 active 狀態（正在並行執行中）
    // 注意：pending 狀態的 sibling 代表尚未開始，不算並行執行
    //       只有 active 狀態才代表該 sibling 也正在執行（真正的並行場景）
    const stages = state?.stages || {};
    const hasActiveSiblings = otherSiblings.some(s => {
      const status = stages[s]?.status;
      return status === 'active';
    });

    if (hasActiveSiblings) {
      reason = `stage ${stage} has barrier config with active siblings, forcing BARRIER route`;
      enforced.route = 'BARRIER';
      // 若 barrierGroup 尚未設定，從 barrier 配置取得
      if (!enforced.barrierGroup) {
        enforced.barrierGroup = barrierConfig.group || 'default';
      }
    }
  }

  return {
    route: enforced,
    enforced: reason !== null,
    reason: reason || undefined,
  };
}

// ────────────────── Exports ──────────────────

module.exports = {
  parseRoute,
  validateRoute,
  enforcePolicy,
  inferRouteFromContent,
  // 內部工具（供測試用）
  convertVerdictToRoute,
  extractTextFromEntry,
  extractIssueCount,
  hasFAILSignal,
};
