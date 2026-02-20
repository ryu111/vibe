#!/usr/bin/env node
/**
 * pipeline-controller.js — Pipeline v4 統一 API
 *
 * 所有 hook 的唯一邏輯入口。每個方法對應一個 hook 事件。
 * Hook 腳本只需：解析 stdin → 呼叫 controller → 輸出結果。
 *
 * API:
 * - classify(sessionId, prompt, options) — 快篩 + 分類
 * - canProceed(sessionId, toolName, toolInput) — 工具防護
 * - onDelegate(sessionId, agentType, toolInput) — 委派追蹤
 * - onStageComplete(sessionId, agentType, transcriptPath) — 階段完成
 * - onSessionStop(sessionId) — 閉環檢查
 *
 * @module flow/pipeline-controller
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Core modules
const ds = require('./dag-state.js');
const { getBaseStage, resolveAgent, validateDag, repairDag, enrichCustomDag, linearToDag, templateToDag, buildBlueprint } = require('./dag-utils.js');
const { shouldSkip } = require('./skip-predicates.js');
const { ensureV4 } = require('./state-migrator.js');
const { shouldStop } = require('./retry-policy.js');
const { parseRoute, validateRoute, enforcePolicy, inferRouteFromContent } = require('./route-parser.js');
const { writeReflection, cleanReflectionForStage } = require('./reflection.js');
const { buildNodeContext, formatNodeContext, buildPhaseScopeHint } = require('./node-context.js');
const { discoverPipeline } = require('./pipeline-discovery.js');

// Registry
const {
  STAGES, AGENT_TO_STAGE, NAMESPACED_AGENT_TO_STAGE,
  PIPELINES, PIPELINE_PRIORITY, PIPELINE_TO_TASKTYPE,
  MAX_RETRIES, QUALITY_STAGES,
  STAGE_CONTEXT, POST_STAGE_HINTS, OPENSPEC_CONTEXT,
  FRONTEND_FRAMEWORKS, API_ONLY_FRAMEWORKS,
  KNOWLEDGE_SKILLS,
} = require('../registry.js');

// Classifier（Layer 1 explicit + system-feedback + Layer 2 Main Agent 主動選擇）
const { classifyWithConfidence } = require('./classifier.js');

// Phase Parser（S3：phase-level D-R-T 循環）
const { parsePhasesFromTasks, generatePhaseDag } = require('./phase-parser.js');

// Wisdom Accumulation（S4：跨 Stage 知識傳遞）
const { extractWisdom, writeWisdom } = require('./wisdom.js');

// v4 Phase 4：Barrier 並行同步
const { createBarrierGroup, updateBarrier, mergeBarrierResults, mergeContextFiles, readBarrier, checkTimeout, deleteBarrier, sweepTimedOutGroups } = require('./barrier.js');

// Timeline（hoisted — 避免 20+ 處 inline require）
const { emit: tlEmit } = require('../timeline/index.js');
const { EVENT_TYPES } = require('../timeline/schema.js');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// 級聯跳過迴圈上限（pipeline 最多 9 階段，20 足夠任何 DAG）
const MAX_SKIP_ITERATIONS = 20;

// ────────────────── 工具函式 ──────────────────

/** 提取 short agent 名稱（去 plugin 前綴） */
function extractShortAgent(agentType) {
  return agentType.includes(':') ? agentType.split(':')[1] : agentType;
}

/** 讀取 state（自動遷移 v3 → v4，v2 或未知格式回傳 null；遷移後持久化） */
function loadState(sessionId) {
  const raw = ds.readState(sessionId);
  if (!raw) return null;
  const state = ensureV4(raw);
  // 遷移後持久化：確保磁碟上的 state 是 v4 格式
  // （classify 的 early-return 路徑不會寫回，導致下游讀到 v3 格式）
  if (state && raw.version !== 4) {
    ds.writeState(sessionId, state);
  }
  return state;
}

/**
 * 解析 suffixed stage：當 DAG 包含同 base name 的多個 stage（如 TEST、TEST:2）時，
 * 根據依賴滿足度選擇正確的目標。
 *
 * 核心邏輯：多個同名候選 → 優先選依賴已滿足且 DAG 位置最晚的 pending/active stage。
 * 這解決了 crash recovery 把早期 stage 重設為 pending 後造成的歧義。
 *
 * @param {Object} state - pipeline state
 * @param {string} baseStage - AGENT_TO_STAGE 映射結果（如 TEST）
 * @returns {string} 實際應追蹤的 stage ID
 */
function resolveSuffixedStage(state, baseStage) {
  if (!baseStage || !state?.dag) return baseStage;
  const dagStages = state.dagStages || Object.keys(state.dag);
  // 收集所有同 base name 的 stage
  const candidates = dagStages.filter(s => getBaseStage(s) === baseStage);
  if (candidates.length <= 1) return baseStage;
  // 多個同名 stage → 逆序找依賴已滿足且 pending/active 的
  for (let i = candidates.length - 1; i >= 0; i--) {
    const s = candidates[i];
    const st = state.stages?.[s]?.status;
    if (st && st !== 'pending' && st !== 'active') continue;
    const deps = state.dag[s]?.deps || state.dagDeps?.[s] || [];
    const allDepsMet = deps.every(d => state.stages?.[d]?.status === 'completed');
    if (allDepsMet) return s;
  }
  // fallback：第一個 pending/active
  for (const s of candidates) {
    const st = state.stages?.[s]?.status;
    if (!st || st === 'pending' || st === 'active') return s;
  }
  return baseStage;
}

/**
 * 讀取 transcript 最後一條 assistant 訊息的字元長度。
 *
 * 設計原則：
 * - 逆序掃描 JSONL（最後 20 行），找最後一條 assistant 訊息
 * - 計算其 content 的文字長度（字串 + 物件都支援）
 * - 效能上限：品質 stage transcript 通常 < 1MB，掃描 20 行 < 1ms
 *
 * @param {string} transcriptPath - JSONL 格式的 transcript 路徑
 * @returns {number} 最後 assistant 回應的字元長度（讀取失敗或無 assistant 訊息時回 0）
 */
function getLastAssistantResponseLength(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');
    // 逆序掃描最後 20 行（避免全文遍歷）
    const scanLines = lines.slice(-20);
    for (let i = scanLines.length - 1; i >= 0; i--) {
      if (!scanLines[i].trim()) continue;
      try {
        const entry = JSON.parse(scanLines[i]);
        if (entry.role !== 'assistant' && entry.type !== 'assistant') continue;
        // 計算 content 長度
        const msgContent = entry.message?.content || entry.content || '';
        if (typeof msgContent === 'string') return msgContent.length;
        if (Array.isArray(msgContent)) {
          // 陣列型 content：累加所有 text block
          return msgContent.reduce((acc, block) => {
            const txt = block?.text || block?.content || '';
            return acc + (typeof txt === 'string' ? txt.length : 0);
          }, 0);
        }
        return String(msgContent).length;
      } catch (_) {}
    }
    return 0;
  } catch (_) {
    return 0;
  }
}

/**
 * 檢查 transcript 是否有 assistant 訊息（表示 agent 確實執行過）
 * CRASH 判斷必須先確認 agent 有實際輸出，才能視為「輸出缺失」
 * @param {string} transcriptPath
 * @returns {boolean}
 */
function transcriptHasAssistantMessage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');
    // 逆序掃描：assistant 訊息通常在末段，大型 transcript 不需全文遍歷
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.role === 'assistant' || entry.type === 'assistant') return true;
      } catch (_) {}
    }
    return false;
  } catch (_) {
    return false;
  }
}

/** git checkpoint */
function autoCheckpoint(stage) {
  try {
    const base = getBaseStage(stage).toLowerCase();
    execSync(`git tag -f "vibe-pipeline/${base}"`, { stdio: 'pipe', timeout: 5000 });
    const patchPath = path.join(CLAUDE_DIR, `vibe-patch-${base}.patch`);
    execSync(`git diff HEAD > "${patchPath}"`, { stdio: 'pipe', timeout: 5000 });
  } catch (_) {}
}

/** 清理 patches */
function cleanupPatches() {
  try {
    const files = fs.readdirSync(CLAUDE_DIR);
    for (const f of files) {
      if (f.startsWith('vibe-patch-') && f.endsWith('.patch')) {
        try { fs.unlinkSync(path.join(CLAUDE_DIR, f)); } catch (_) {}
      }
    }
  } catch (_) {}
}

/** 組裝委派指令 */
function buildDelegationHint(stageId, stageMap) {
  const info = resolveAgent(stageId, stageMap);
  if (!info) return `委派 ${stageId}`;
  const prefix = info.plugin ? `${info.plugin}:` : '';
  if (info.skill) return `執行 ${info.skill}`;
  return `委派 ${prefix}${info.agent}`;
}

/** 組裝階段上下文（QA/E2E/OpenSpec 提示） */
function buildStageContext(nextStage, prevStage, state) {
  const parts = [];
  const env = state.environment || {};
  const frameworkName = ((env.framework?.name) || '').toLowerCase();
  const isApiOnly = API_ONLY_FRAMEWORKS.includes(frameworkName);

  if (nextStage === 'QA') parts.push(STAGE_CONTEXT.QA);
  else if (nextStage === 'E2E') parts.push(isApiOnly ? STAGE_CONTEXT.E2E_API : STAGE_CONTEXT.E2E_UI);

  if (state.openspecEnabled && OPENSPEC_CONTEXT[nextStage]) {
    parts.push(OPENSPEC_CONTEXT[nextStage]);
  }

  if (!state.openspecEnabled && nextStage === 'DEV') {
    try {
      if (fs.existsSync(path.join(process.cwd(), 'design-system', 'MASTER.md'))) {
        parts.push('🎨 前端實作請參考 design-system/MASTER.md');
      }
    } catch (_) {}
  }

  const postHint = POST_STAGE_HINTS[prevStage];
  if (postHint) {
    const designSkipped = ds.getSkippedStages(state).includes('DESIGN');
    if (!(prevStage === 'ARCH' && designSkipped)) parts.push(postHint);
  }

  return parts.length > 0 ? '\n' + parts.join('\n') : '';
}

/**
 * 根據環境偵測結果建構知識 skill 提示。
 * @param {object} state - pipeline state（含 environment）
 * @returns {string} 知識庫提示字串，無匹配時回空字串
 */
function buildKnowledgeHints(state) {
  const env = state.environment || {};
  const primary = (env.languages?.primary || '').toLowerCase();
  const secondary = (env.languages?.secondary || [])
    .filter(s => typeof s === 'string')
    .map(s => s.toLowerCase());
  const framework = (env.framework?.name || '').toLowerCase();

  const hints = new Set();

  // 語言匹配
  const allLangs = primary ? [primary, ...secondary] : secondary;
  for (const lang of allLangs) {
    const skill = KNOWLEDGE_SKILLS.languages[lang];
    if (skill) hints.add(skill);
  }

  // 框架匹配
  if (framework) {
    const skill = KNOWLEDGE_SKILLS.frameworks[framework];
    if (skill) hints.add(skill);
  }

  // 有任何語言/框架匹配時，自動加入通用 skills（從 registry 讀取）
  if (hints.size > 0) {
    for (const s of (KNOWLEDGE_SKILLS.common || [])) hints.add(s);
  }

  return hints.size > 0
    ? `可用知識庫：${[...hints].join(' ')}`
    : '';
}

/**
 * 組裝 context_file 提示（FAIL 回退時告知 DEV 詳細報告在哪）
 */
function buildContextFileHint(sessionId, stage) {
  const base = getBaseStage(stage);
  return `📄 context_file: ~/.claude/pipeline-context-${sessionId}-${base}.md`;
}

/**
 * 更新 state.retryHistory[stage]（追加本輪記錄）
 */
function addRetryHistory(state, stage, routeResult, retryCount) {
  const retryHistory = { ...(state.retryHistory || {}) };
  const stageHistory = [...(retryHistory[stage] || [])];
  stageHistory.push({
    verdict: routeResult?.verdict || 'FAIL',
    severity: routeResult?.severity || 'MEDIUM',
    round: retryCount + 1,
  });
  retryHistory[stage] = stageHistory;
  return { ...state, retryHistory };
}

/**
 * emit BARRIER_CRASH_GUARD 事件（barrier sibling crashed，阻擋下游）
 */
function emitBarrierCrashGuard(sessionId, stage, blockedDownstream, pendingCrashedSiblings) {
  try {
    tlEmit(EVENT_TYPES.BARRIER_CRASH_GUARD, sessionId, { stage, blockedDownstream, pendingCrashedSiblings });
  } catch (_) {}
}

/**
 * emit STAGE_CRASH_RECOVERY 事件（Stop hook 自動回收 crashed stage）
 */
function emitStageCrashRecovery(sessionId, stage, verdict, blockCount, source) {
  try {
    tlEmit(EVENT_TYPES.STAGE_CRASH_RECOVERY, sessionId, { stage, verdict, blockCount, source });
  } catch (_) {}
}

/**
 * emit ROUTE_FALLBACK 事件（parseRoute 回退到 v3 VERDICT 解析）
 */
function emitRouteFallback(sessionId, stage) {
  try {
    tlEmit(EVENT_TYPES.ROUTE_FALLBACK, sessionId, { stage, source: 'verdict-fallback' });
  } catch (_) {}
}

/**
 * emit ROUTE_FALLBACK 事件（content-inference 推斷）
 */
function emitRouteInference(sessionId, stage, inferred) {
  try {
    tlEmit(EVENT_TYPES.ROUTE_FALLBACK, sessionId, {
      stage,
      source: 'content-inference',
      verdict: inferred?.verdict,
    });
  } catch (_) {}
}

/**
 * emit RETRY_EXHAUSTED 事件（達到 maxRetries）
 */
function emitRetryExhausted(sessionId, stage, retryCount) {
  try {
    tlEmit(EVENT_TYPES.RETRY_EXHAUSTED, sessionId, { stage, retryCount });
  } catch (_) {}
}

/**
 * emit BARRIER_WAITING 事件
 */
function emitBarrierWaiting(sessionId, group, completedCount, totalCount, completedStages, siblings) {
  try {
    const waitingStages = (siblings || []).filter(s => !completedStages.includes(s));
    tlEmit(EVENT_TYPES.BARRIER_WAITING, sessionId, {
      barrierGroup: group,
      completedCount,
      totalCount,
      completedStages,
      waitingStages,
    });
  } catch (_) {}
}

/**
 * emit BARRIER_RESOLVED 事件
 */
function emitBarrierResolved(sessionId, group, verdict, next, mergedResult) {
  try {
    tlEmit(EVENT_TYPES.BARRIER_RESOLVED, sessionId, {
      barrierGroup: group,
      verdict,
      next: next || null,
      severity: mergedResult?.severity || null,
    });
  } catch (_) {}
}

/**
 * emit AGENT_CRASH 事件
 */
function emitAgentCrash(sessionId, stage, crashCount, willRetry) {
  try {
    tlEmit(EVENT_TYPES.AGENT_CRASH, sessionId, { stage, crashCount, willRetry });
  } catch (_) {}
}

/**
 * 最低品質完整性保證：如果 DAG 含 DEV 且任務不是 fix（單一 DEV），
 * 則確保至少有 REVIEW + TEST 品質把關。
 *
 * 背景：pipeline-architect 偶爾只產出 `{ DEV: { deps: [] } }` 的不完整 DAG，
 * 導致 pipeline 在 DEV 完成後直接結束，跳過品質階段。
 * 此函式作為安全網，在接受 DAG 前強制補齊必要的品質節點。
 *
 * 例外：
 * - DAG 只有 DEV（fix 模式）→ 不補（單階段 fix 是合法設計）
 * - DAG 已有 REVIEW 或 TEST → 不重複補
 * - DAG 無 DEV → 不補（PLAN/ARCH/DOCS 等純非實作 pipeline）
 *
 * @param {Object} dag - 已驗證合法的 DAG 物件
 * @returns {Object} 修正後的 DAG（可能新增 REVIEW/TEST 節點）
 */
function ensureQualityStagesIfDev(dag) {
  if (!dag) return dag;

  const stageIds = Object.keys(dag);
  const devStages = stageIds.filter(s => getBaseStage(s) === 'DEV');

  // 無 DEV → 不修正
  if (devStages.length === 0) return dag;

  // 只有 DEV（fix 模式）→ 允許不補品質階段
  if (stageIds.length === 1 && devStages.length === 1) return dag;

  const hasReview = stageIds.some(s => getBaseStage(s) === 'REVIEW');
  const hasTest = stageIds.some(s => getBaseStage(s) === 'TEST');

  // 已有品質階段 → 不修正
  if (hasReview && hasTest) return dag;

  // 需要補齊：找最後一個 DEV stage（作為 REVIEW/TEST 的依賴）
  const lastDevStage = devStages[devStages.length - 1];
  const patched = { ...dag };

  if (!hasReview) {
    patched.REVIEW = { deps: [lastDevStage] };
  }
  if (!hasTest) {
    patched.TEST = { deps: [lastDevStage] };
  }

  try {
    const hookLogger = require('../hook-logger.js');
    const added = [];
    if (!hasReview) added.push('REVIEW');
    if (!hasTest) added.push('TEST');
    hookLogger.error('pipeline-controller', new Error(
      `pipeline-architect 產出的 DAG 缺少品質階段，自動補齊：新增 ${added.join(' + ')} → deps=[${lastDevStage}]`
    ));
  } catch (_) {}

  return patched;
}

/** 偵測 design 需求（ARCH 完成後） */
function detectDesignNeed(state, stageId) {
  if (getBaseStage(stageId) !== 'ARCH' || !state.openspecEnabled) return false;
  try {
    const changesDir = path.join(process.cwd(), 'openspec', 'changes');
    if (!fs.existsSync(changesDir)) return false;
    const dirs = fs.readdirSync(changesDir)
      .filter(d => d !== 'archive' && fs.statSync(path.join(changesDir, d)).isDirectory());
    for (const dir of dirs) {
      if (fs.existsSync(path.join(changesDir, dir, 'design-system.md'))) return true;
    }
  } catch (_) {}
  return false;
}

// ────────────────── 1. classify ──────────────────

/**
 * LLM-first 分類（UserPromptSubmit hook）
 *
 * @returns {Promise<{ output: Object }>} — 要寫到 stdout 的 JSON
 */
async function classify(sessionId, prompt, options = {}) {
  const result = await classifyWithConfidence(prompt);
  const pipelineId = result.pipeline;
  const stages = PIPELINES[pipelineId]?.stages || [];
  const taskType = PIPELINE_TO_TASKTYPE[pipelineId] || 'quickfix';

  let state = loadState(sessionId);

  // Barrier 超時巡檢（每次 UserPromptSubmit 時檢查，靜默失敗不影響分類邏輯）
  // 條件：pipeline active + 非 cancelled → 才有 barrier group 需要巡檢
  const barrierWarnings = [];
  if (state && ds.isActive(state) && !state?.meta?.cancelled) {
    try {
      const sweepResult = sweepTimedOutGroups(sessionId);
      if (sweepResult.timedOut.length > 0) {
        for (const { group, timedOutStages } of sweepResult.timedOut) {
          // 更新 pipeline state：將超時 stage 標記為失敗
          for (const stageId of timedOutStages) {
            if (state.stages?.[stageId]) {
              state = ds.markStageFailed(state, stageId);
            }
          }
          barrierWarnings.push(
            `[Barrier 超時] group=${group} — ${timedOutStages.join(', ')} 未在時限內完成，已強制 FAIL。` +
            `下一次委派時將觸發路由決策。`
          );
          // 發射 BARRIER_RESOLVED Timeline 事件
          emitBarrierResolved(sessionId, group, 'FAIL', null, { severity: 'HIGH' });
        }
        // 超時 stages 已更新，寫回 state
        ds.writeState(sessionId, state);
      }
    } catch (_) {
      // 巡檢失敗靜默，不影響分類邏輯
    }
  }

  // system-feedback → 靜默忽略（hook 輸出 / 系統通知不觸發 pipeline）
  if (result.source === 'system') {
    return { output: null };
  }

  // ACTIVE → 忽略非顯式分類（防止 stop hook feedback 覆寫進行中的 pipeline）
  if (ds.isActive(state) && result.source !== 'explicit') {
    return { output: null };
  }

  // CANCELLED → 忽略非顯式分類（防止 cancel 後的 stop hook feedback 循環）
  if (state?.meta?.cancelled && result.source !== 'explicit') {
    return { output: null };
  }

  // COMPLETE → 允許新 pipeline
  if (state && ds.isComplete(state)) {
    if (result.source === 'explicit') {
      // 顯式 [pipeline:xxx]：保留前一個 classification 供 reclassification 追蹤
      state = ds.resetKeepingClassification(state);
    } else {
      // 非顯式新任務：完全重設
      state = ds.reset(state);
    }
    ds.writeState(sessionId, state);
  }

  // 未初始化 → 建立
  if (!state) {
    state = ds.createInitialState(sessionId, {});
    ds.writeState(sessionId, state);
  }

  // 已分類 + 同一 pipeline → 不重複（none 除外：每次都需注入 systemMessage）
  const existingPipelineId = ds.getPipelineId(state);
  if (existingPipelineId === pipelineId && existingPipelineId && pipelineId !== 'none') {
    return { output: null };
  }

  // 升級判斷：只允許升級，降級被忽略（使用者可用 [pipeline:xxx] 覆寫）
  if (existingPipelineId && existingPipelineId !== pipelineId && result.source !== 'explicit') {
    const isUpgrade = (PIPELINE_PRIORITY[pipelineId] || 0) > (PIPELINE_PRIORITY[existingPipelineId] || 0);
    if (!isUpgrade) return { output: null };
  }

  // 設定分類
  state = ds.classify(state, {
    pipelineId,
    taskType,
    source: result.source,
    confidence: result.confidence,
    matchedRule: result.matchedRule,
  });
  ds.writeState(sessionId, state);

  // Main Agent 主動選擇：注入 pipeline 選擇表（systemMessage 強制）
  if (stages.length === 0 || pipelineId === 'none') {
    const kh = buildKnowledgeHints(state);
    const contextParts = [];
    if (kh) contextParts.push(kh);
    if (barrierWarnings.length > 0) contextParts.push(barrierWarnings.join('\n'));
    return {
      output: {
        systemMessage:
          '你是 Pipeline 路由器。分析使用者需求，選擇最合適的工作流。\n\n' +
          '| Pipeline | 適用場景 | 使用方式 |\n' +
          '|----------|---------|--------|\n' +
          '| chat | 問答、研究、解釋、查詢、trivial | 直接回答，不呼叫 pipeline |\n' +
          '| fix | hotfix、一行修改、改設定/常量 | /vibe:pipeline [pipeline:fix] |\n' +
          '| quick-dev | bugfix + 補測試、小改動（2-5 檔案） | /vibe:pipeline [pipeline:quick-dev] |\n' +
          '| standard | 新功能（無 UI）、大重構 | /vibe:pipeline [pipeline:standard] |\n' +
          '| full | 新功能（含 UI） | /vibe:pipeline [pipeline:full] |\n' +
          '| test-first | TDD 工作流 | /vibe:pipeline [pipeline:test-first] |\n' +
          '| ui-only | 純 UI/樣式調整 | /vibe:pipeline [pipeline:ui-only] |\n' +
          '| review-only | 程式碼審查 | /vibe:pipeline [pipeline:review-only] |\n' +
          '| docs-only | 純文件更新 | /vibe:pipeline [pipeline:docs-only] |\n' +
          '| security | 安全修復 | /vibe:pipeline [pipeline:security] |\n\n' +
          '判斷原則：\n' +
          '- 偏向使用 pipeline（寧可多走品質流程也不要漏）\n' +
          '- 不確定時用 AskUserQuestion 問使用者選擇 pipeline\n' +
          '- 複合任務：分解後依序執行（第一個完成 → 開始第二個）',
        ...(contextParts.length > 0 ? { additionalContext: contextParts.join('\n') } : {}),
      },
    };
  }

  // 已知模板 → 立即建 DAG（不論 explicit 或 regex/LLM 來源）
  // pipeline-architect 只用於未知模板或自訂 DAG
  // test-first 使用語意化後綴（TEST:verify），deduplicateStages 作為安全網保留
  if (PIPELINES[pipelineId] && stages.length > 0) {
    // v4 Phase 4：已知模板改用 templateToDag（含 barrier/onFail/next）
    const dag = templateToDag(pipelineId, stages);
    const blueprint = buildBlueprint(dag);
    state = ds.setDag(state, dag, blueprint, PIPELINES[pipelineId]?.enforced);

    // 跳過判斷
    for (const stageId of Object.keys(dag)) {
      const skip = shouldSkip(stageId, state);
      if (skip.skip) {
        state = ds.markStageSkipped(state, stageId, skip.reason);
      }
    }
    ds.writeState(sessionId, state);

    const ready = ds.getReadyStages(state);
    const pipeline = discoverPipeline();
    const firstHint = ready.map(s => buildDelegationHint(s, pipeline.stageMap)).join(' + ');
    const stageStr = stages.join(' → ');
    const sourceLabel = result.source === 'explicit' ? `[${pipelineId}]` : pipelineId;

    // 多階段 pipeline：在初始指令中列出前 3 步（避免 token 浪費），防止模型在中途停止
    const MAX_STEPS_DISPLAY = 3;
    const totalSteps = blueprint ? blueprint.length : 0;
    const allSteps = blueprint
      ? blueprint.slice(0, MAX_STEPS_DISPLAY).map((b, i) => {
          const stageNames = b.stages.join(' + ');
          const skillHints = b.stages.map(s => buildDelegationHint(s, pipeline.stageMap)).join(' + ');
          return `${i + 1}. ${stageNames}${b.parallel ? '（並行）' : ''}：${skillHints}`;
        }).join('\n') +
        (totalSteps > MAX_STEPS_DISPLAY ? `\n... 共 ${totalSteps} 步` : '')
      : '';
    const multiStageWarning = stages.length > 1
      ? `\n⚠️ 禁止中途停止。你必須按順序完成所有 ${stages.length} 個階段。\n${allSteps}\n先從第一步開始：`
      : '';

    const kh = buildKnowledgeHints(state);
    const contextParts = [];
    if (kh) contextParts.push(kh);
    if (barrierWarnings.length > 0) contextParts.push(barrierWarnings.join('\n'));
    return {
      output: {
        systemMessage:
          `⛔ Pipeline ${sourceLabel}（${stageStr}）已建立。${multiStageWarning}\n` +
          `➡️ ${firstHint}`,
        ...(contextParts.length > 0 ? { additionalContext: contextParts.join('\n') } : {}),
      },
    };
  }

  // 未知模板 → 指示呼叫 /vibe:pipeline skill（讓 Agent 動態生成 DAG）
  const kh = buildKnowledgeHints(state);
  const contextParts = [];
  if (kh) contextParts.push(kh);
  if (barrierWarnings.length > 0) contextParts.push(barrierWarnings.join('\n'));
  return {
    output: {
      systemMessage:
        `⛔ 任務需要自訂 Pipeline。呼叫 /vibe:pipeline skill 啟動 pipeline-architect 分析需求並產出執行計劃。`,
      ...(contextParts.length > 0 ? { additionalContext: contextParts.join('\n') } : {}),
    },
  };
}

// ────────────────── 2. canProceed ──────────────────

/**
 * 工具防護（PreToolUse hook）
 *
 * 統一入口：載入 state 後代理到 guard-rules.evaluate()。
 * 消除 canProceed/evaluate 邏輯重複（v1.0.56/57 根因）。
 *
 * @returns {{ decision: 'allow'|'block', message?: string, reason?: string }}
 */
function canProceed(sessionId, toolName, toolInput) {
  const { evaluate } = require('../sentinel/guard-rules.js');
  const state = loadState(sessionId);
  return evaluate(toolName, toolInput, state);
}

// ────────────────── 3. onDelegate ──────────────────

/**
 * 委派追蹤（PreToolUse Task hook）
 *
 * @returns {{ allow: boolean, message?: string }}
 */
function onDelegate(sessionId, agentType, toolInput) {
  let state = loadState(sessionId);
  if (!state) return { allow: true };

  const shortAgent = extractShortAgent(agentType);
  const stage = resolveSuffixedStage(state, AGENT_TO_STAGE[shortAgent] || '');

  // pendingRetry 防護：只允許 DEV
  const phase = ds.derivePhase(state);
  if (phase === ds.PHASES.RETRYING && stage && getBaseStage(stage) !== 'DEV') {
    const pending = ds.getPendingRetry(state);
    const target = pending?.stages?.[0]?.id || '?';
    return {
      allow: false,
      message: `⛔ 回退中：必須先委派 DEV 修復 ${target}，不可委派 ${shortAgent}。\n`,
    };
  }

  // 標記 stage active + 重設阻擋計數
  if (stage && state.dag && state.stages[stage]) {
    state = ds.markStageActive(state, stage, shortAgent);
    if (state.meta?.pipelineCheckBlocks) {
      state.meta.pipelineCheckBlocks = 0;
    }

    // v4（任務 3.4）：push stage 到 activeStages，供 guard 判斷「委派中」狀態
    const activeStages = [...(state.activeStages || [])];
    if (!activeStages.includes(stage)) {
      activeStages.push(stage);
    }
    state = { ...state, activeStages };

    ds.writeState(sessionId, state);
  }

  return { allow: true, stage, shortAgent };
}

// ────────────────── 4. onStageComplete ──────────────────

/**
 * 階段完成（SubagentStop hook）
 *
 * @returns {{ systemMessage: string, continue?: boolean }}
 */
function onStageComplete(sessionId, agentType, transcriptPath, lastAssistantMessage = '') {
  const pipeline = discoverPipeline();
  const shortAgent = extractShortAgent(agentType);

  // 偵測是否為 pipeline-architect
  if (shortAgent === 'pipeline-architect') {
    return handlePipelineArchitectComplete(sessionId, transcriptPath, pipeline);
  }

  // 正常 stage agent（支援 suffixed stage 如 TEST:2）
  const baseStage = pipeline.agentToStage[agentType] || AGENT_TO_STAGE[shortAgent];
  if (!baseStage) return { systemMessage: '' };

  let state = loadState(sessionId);
  if (!state) return { systemMessage: '' };
  const currentStage = resolveSuffixedStage(state, baseStage);

  // Design 需求偵測
  if (detectDesignNeed(state, currentStage)) {
    state = { ...state, needsDesign: true };
  }

  // ── v4：解析 PIPELINE_ROUTE（fallback 到 v3 PIPELINE_VERDICT）──
  const { parsed: routeParsed, source: routeSource } = parseRoute(transcriptPath);

  // 洩漏感知 compact 建議（在 systemMessage 末尾附加）
  let leakCompactHint = '';

  // Timeline emit：記錄 fallback 事件
  let routeResult = null;
  if (routeSource === 'verdict-fallback') {
    emitRouteFallback(sessionId, currentStage);
  }
  if (routeSource === 'content-inference') {
    emitRouteInference(sessionId, currentStage, routeParsed);
  }

  // Schema Validation
  const { route: validatedRoute, warnings: routeWarnings } = validateRoute(routeParsed);
  if (routeWarnings.length > 0) {
    const hookLogger = require('../hook-logger.js');
    hookLogger.error('route-parser', new Error(`route warnings: ${routeWarnings.join('; ')}`));
  }

  // Phase 2：從 PIPELINE_ROUTE.context_file 存入 state.stages[currentStage].contextFile
  if (validatedRoute?.context_file) {
    state = ds.setStageContextFile(state, currentStage, validatedRoute.context_file);
  }

  // 取得重試歷史
  const retries = ds.getRetries(state);
  const retryCount = retries[currentStage] || 0;
  const retryHistory = state.retryHistory?.[currentStage] || [];

  // Policy Enforcement
  const { route: enforcedRoute, enforced: policyEnforced, reason: policyReason } = enforcePolicy(validatedRoute, state, currentStage);
  routeResult = enforcedRoute;

  if (policyReason) {
    const hookLogger = require('../hook-logger.js');
    hookLogger.error('route-parser', new Error(`policy enforced: ${policyReason}`));
  }

  // 對於達上限的 emit RETRY_EXHAUSTED
  if (routeResult?._retryExhausted) {
    emitRetryExhausted(sessionId, currentStage, retryCount);
  }

  // shouldStop 決策（使用 routeResult 的 verdict）
  const verdictForStop = validatedRoute
    ? { verdict: validatedRoute.verdict, severity: validatedRoute.severity }
    : null;
  const stopResult = shouldStop(currentStage, verdictForStop, retryCount, retryHistory);

  // 判斷是否需要回退：
  // - route 明確指向 DEV，且 shouldStop 說繼續 → 回退
  // - FAIL 且 shouldStop 說停止 → 強制前進（上限/停滯）
  const shouldRouteTodev = routeResult?.route === 'DEV' && !stopResult.stop;
  const isQualityFail = routeResult?.verdict === 'FAIL' && QUALITY_STAGES.includes(getBaseStage(currentStage));

  // ── 分支 A: 回退 ──
  if (shouldRouteTodev || (isQualityFail && !stopResult.stop && !validatedRoute)) {
    // FAIL 時寫入反思記憶
    writeReflection(sessionId, currentStage, routeResult, retryCount);

    // 更新 retryHistory
    state = addRetryHistory(state, currentStage, routeResult, retryCount);

    // 檢查 DAG 中是否有 DEV
    const hasDev = state.dag && Object.keys(state.dag).some(s => getBaseStage(s) === 'DEV');

    if (!hasDev) {
      // 無 DEV → 強制繼續
      state = ds.markStageCompleted(state, currentStage, routeResult);
      // v4（任務 3.4）：從 activeStages 移除已完成的 stage
      if (state.activeStages) {
        state = { ...state, activeStages: state.activeStages.filter(s => s !== currentStage) };
      }
      ds.writeState(sessionId, state);
      autoCheckpoint(currentStage);

      const ready = ds.getReadyStages(state);
      if (ready.length > 0) {
        const hints = ready.map(s => buildDelegationHint(s, pipeline.stageMap)).join(' + ');
        return { systemMessage: `⚠️ ${currentStage} FAIL 但無 DEV 可回退，強制繼續。\n➡️ ${hints}` };
      }
      // 無更多階段 → 強制完成（保留 FAIL 資訊）
      const completeMsg = buildCompleteOutput(state, currentStage, pipeline);
      return {
        systemMessage: `⚠️ ${currentStage} FAIL 但無 DEV 可回退，強制繼續。\n` + completeMsg.systemMessage,
      };
    }

    // 有 DEV → 回退
    state = ds.markStageFailed(state, currentStage, routeResult);
    state = ds.setPendingRetry(state, {
      stages: [{ id: currentStage, severity: routeResult?.severity, round: retryCount + 1 }],
    });
    // v4（任務 3.4）：從 activeStages 移除失敗的 stage（等待 DEV 修復）
    if (state.activeStages) {
      state = { ...state, activeStages: state.activeStages.filter(s => s !== currentStage) };
    }
    // M-4 修正：回退時清除 barrier state（跨 barrier 回退需重跑 barrier group）
    deleteBarrier(sessionId);
    ds.writeState(sessionId, state);

    // systemMessage 只含路由指令，不含品質報告內容
    // 詳細報告已寫入 context_file（~/.claude/pipeline-context-{sid}-{stage}.md）
    const contextHint = buildContextFileHint(sessionId, currentStage);

    // Phase 2：生成 DEV Node Context（含 retryContext）
    // H-2 修復：回退應找對應 phase 的 DEV（如 REVIEW:2 → DEV:2），而非第一個 DEV
    const devStageId = resolvePhaseDevStageId(currentStage, state.dag);
    const devHint = buildDelegationHint(devStageId, pipeline.stageMap);
    let devNodeContextStr = '';
    try {
      const devNodeCtx = buildNodeContext(state.dag, state, devStageId, sessionId);
      devNodeContextStr = '\n' + formatNodeContext(devNodeCtx);
    } catch (_) {}

    return {
      systemMessage:
        `🔄 ${currentStage} FAIL（${retryCount + 1}/${MAX_RETRIES}）\n` +
        `➡️ ${devHint}` +
        (contextHint ? `\n${contextHint}` : '') +
        devNodeContextStr,
    };
  }

  // ── 分支 B: 回退重驗（DEV 完成後重跑失敗的 stage）──
  const pendingRetry = ds.getPendingRetry(state);
  if (pendingRetry?.stages?.length > 0 && getBaseStage(currentStage) === 'DEV') {
    state = ds.markStageCompleted(state, currentStage, routeResult);
    // v4（任務 3.4）：從 activeStages 移除已完成的 DEV stage
    if (state.activeStages) {
      state = { ...state, activeStages: state.activeStages.filter(s => s !== currentStage) };
    }

    // 重設所有 failed stages 為 pending
    for (const retry of pendingRetry.stages) {
      state = ds.resetStageToPending(state, retry.id);
    }
    state = ds.clearPendingRetry(state);
    ds.writeState(sessionId, state);
    autoCheckpoint(currentStage);

    const retryTargets = pendingRetry.stages.map(r => r.id);
    const hints = retryTargets.map(s => buildDelegationHint(s, pipeline.stageMap)).join(' + ');

    // Phase 2：為每個重跑 stage 生成 Node Context
    let retryNodeContextStr = '';
    if (retryTargets.length > 0 && state.dag) {
      try {
        const firstRetryStage = retryTargets[0];
        const retryNodeCtx = buildNodeContext(state.dag, state, firstRetryStage, sessionId);
        retryNodeContextStr = '\n' + formatNodeContext(retryNodeCtx);
      } catch (_) {}
    }

    return {
      systemMessage: `🔄 DEV 修復完成 → 重跑 ${retryTargets.join(' + ')}\n➡️ ${hints}${retryNodeContextStr}`,
    };
  }

  // ── 分支 BARRIER: 並行節點同步 ──
  if (routeResult?.route === 'BARRIER') {
    const barrierGroup = routeResult.barrierGroup || 'default';
    const dagNode = state.dag?.[currentStage] || {};
    const barrierConfig = dagNode.barrier || {};
    const total = barrierConfig.total || 2;
    const next = barrierConfig.next || null;
    const siblings = barrierConfig.siblings || [currentStage];

    // 確保 barrier group 存在
    createBarrierGroup(sessionId, barrierGroup, total, next, siblings);

    // 更新 barrier state（加入此 stage 的結果）
    const { allComplete, mergedResult } = updateBarrier(sessionId, barrierGroup, currentStage, routeResult);

    // 更新 stage 狀態
    if (routeResult.verdict === 'FAIL') {
      state = ds.markStageFailed(state, currentStage, routeResult);
    } else {
      state = ds.markStageCompleted(state, currentStage, routeResult);
    }
    if (state.activeStages) {
      state = { ...state, activeStages: state.activeStages.filter(s => s !== currentStage) };
    }

    // M-1 修正：若尚未收齊，檢查是否超時；超時則強制填入缺席 stages 為 FAIL
    let resolvedMergedResult = mergedResult;
    let timeoutWarning = '';
    if (!allComplete) {
      const barrierState = readBarrier(sessionId);
      const isTimedOut = barrierState ? checkTimeout(barrierState, barrierGroup) : false;

      if (isTimedOut) {
        // 超時 → 將未完成的 siblings 標記為 FAIL，強制解鎖 barrier
        const timedOutStages = (barrierState?.groups?.[barrierGroup]?.siblings || siblings)
          .filter(s => !barrierState?.groups?.[barrierGroup]?.completed?.includes(s));
        for (const ts of timedOutStages) {
          updateBarrier(sessionId, barrierGroup, ts, {
            verdict: 'FAIL',
            route: 'BARRIER',
            severity: 'HIGH',
            hint: `Barrier 超時 — agent 未回應（${barrierGroup}）`,
          });
        }
        // 強制完成 barrier（幂等 — currentStage 已被加入，此次觸發合併）
        const forceResult = updateBarrier(sessionId, barrierGroup, currentStage, routeResult);
        if (forceResult.allComplete && forceResult.mergedResult) {
          resolvedMergedResult = forceResult.mergedResult;
          timeoutWarning = `⚠️ Barrier ${barrierGroup} 超時（${timedOutStages.join(', ')} 未回應），已強制標記為 FAIL。\n`;
        } else {
          // 仍未解鎖（不應發生），返回警告
          ds.writeState(sessionId, state);
          return {
            systemMessage: `⚠️ Barrier ${barrierGroup} 超時且強制解鎖失敗，請手動檢查。`,
          };
        }
      } else {
        // 未超時 → 等待其他 stage
        ds.writeState(sessionId, state);
        // M-2 修正：從 barrier state 讀取實際的 completed 資訊
        const barrierStateNow = readBarrier(sessionId);
        const groupData = barrierStateNow?.groups?.[barrierGroup];
        const completedCount = groupData?.completed?.length || 1;
        const completedStages = groupData?.completed || [currentStage];
        emitBarrierWaiting(sessionId, barrierGroup, completedCount, total, completedStages, siblings);
        // 不發出 systemMessage（Main Agent 不需要動作）
        return { systemMessage: '' };
      }
    }

    // 全到齊（正常完成或超時強制解鎖）→ 合併結果，繼續路由
    emitBarrierResolved(sessionId, barrierGroup, resolvedMergedResult?.verdict || 'PASS', next, resolvedMergedResult);

    if (resolvedMergedResult?.verdict === 'FAIL') {
      // FAIL → 走回退邏輯（複用分支 A 的邏輯）
      writeReflection(sessionId, currentStage, resolvedMergedResult, retryCount);
      state = addRetryHistory(state, currentStage, resolvedMergedResult, retryCount);

      // 合併 context files（如果有多個 FAIL 的報告）
      let mergedContextFile = resolvedMergedResult.context_file || null;
      if (!mergedContextFile && resolvedMergedResult.context_files?.length > 0) {
        const fakeFailResults = resolvedMergedResult.context_files.map(f => ({ context_file: f }));
        mergedContextFile = mergeContextFiles(fakeFailResults, sessionId);
      }

      const hasDev = state.dag && Object.keys(state.dag).some(s => getBaseStage(s) === 'DEV');
      if (!hasDev) {
        // 無 DEV → 強制繼續
        const ready = ds.getReadyStages(state);
        if (ready.length > 0) {
          ds.writeState(sessionId, state);
          const hints = ready.map(s => buildDelegationHint(s, pipeline.stageMap)).join(' + ');
          return { systemMessage: `${timeoutWarning}⚠️ Barrier ${barrierGroup} FAIL 但無 DEV 可回退，強制繼續。\n➡️ ${hints}` };
        }
        state = { ...state, pipelineActive: false, activeStages: [] };
        ds.writeState(sessionId, state);
        const completeMsg = buildCompleteOutput(state, currentStage, pipeline);
        return {
          systemMessage: `${timeoutWarning}⚠️ Barrier ${barrierGroup} FAIL 但無 DEV 可回退。\n` + completeMsg.systemMessage,
        };
      }

      // 有 DEV → 回退
      // H-4 修正：使用 resolvedMergedResult._failedStages 設定 pendingRetry，
      //          並對所有 FAIL stages 呼叫 markStageFailed（而非只標記 currentStage）。
      const failedStages = resolvedMergedResult._failedStages || [currentStage];

      // 對所有非 currentStage 的失敗 stage 也標記為 failed
      for (const fStage of failedStages) {
        if (fStage !== currentStage && state.stages?.[fStage]) {
          state = ds.markStageFailed(state, fStage, resolvedMergedResult);
        }
      }

      state = ds.setPendingRetry(state, {
        stages: failedStages.map(id => ({
          id,
          severity: resolvedMergedResult.severity,
          round: retryCount + 1,
        })),
      });
      // H-1 修正：回退到 DEV 時清除 barrier state，
      // 確保 DEV 修復後重跑品質階段時 barrier 計數器是全新狀態
      deleteBarrier(sessionId);
      ds.writeState(sessionId, state);

      // M-1 修復：使用 resolvePhaseDevStageId 取得 phase-aware DEV stage
      // 確保 barrier FAIL 回退時指向正確的 DEV:N（如 REVIEW:2 FAIL → DEV:2）
      const barrierDevStageId = resolvePhaseDevStageId(currentStage, state.dag);
      const devHint = buildDelegationHint(barrierDevStageId, pipeline.stageMap);
      const contextHint = mergedContextFile
        ? `📄 context_file: ${mergedContextFile}`
        : buildContextFileHint(sessionId, currentStage);

      return {
        systemMessage:
          `${timeoutWarning}🔄 Barrier ${barrierGroup} FAIL（${retryCount + 1}/${MAX_RETRIES}）\n` +
          `➡️ ${devHint}` +
          (contextHint ? `\n${contextHint}` : ''),
      };
    }

    // PASS → 用 getReadyStages() 取得完整就緒清單（處理菱形依賴 M-1 + 最終 DOCS M-2）
    // barrier.next 僅作向後相容參考，實際路由以 getReadyStages() 為準
    const passReadyStages = ds.getReadyStages(state);

    if (passReadyStages.length === 0 && ds.isComplete(state)) {
      // 無更多 ready stages 且全部完成 → COMPLETE
      state = { ...state, pipelineActive: false, activeStages: [] };
      cleanupPatches();
      ds.writeState(sessionId, state);
      autoCheckpoint(currentStage);
      return buildCompleteOutput(state, currentStage, pipeline);
    }

    ds.writeState(sessionId, state);
    autoCheckpoint(currentStage);

    if (passReadyStages.length > 0) {
      // 有 ready stages（可能是 barrier.next、多個並行 DEV、或 DOCS）
      const passHints = passReadyStages.map(s => buildDelegationHint(s, pipeline.stageMap));
      // 單一 stage 時只顯示 hint（避免「委派 developer DEV:2 → DEV:2」重複）
      // 多個並行 stage 時顯示 hint1 + hint2 → stage1 + stage2（並行）
      const passAction = passReadyStages.length > 1
        ? `${passHints.join(' + ')} → ${passReadyStages.join(' + ')}（並行）`
        : passHints[0];
      const passNodeCtx = (() => {
        try {
          const ctx = buildNodeContext(state.dag, state, passReadyStages[0], sessionId);
          return '\n' + formatNodeContext(ctx);
        } catch (_) { return ''; }
      })();
      return {
        systemMessage: `✅ Barrier ${barrierGroup} 完成（全部 PASS）\n➡️ ${passAction}${passNodeCtx}`,
      };
    }

    // 沒有 ready stages 也沒完成 → 等待其他 active stages
    const activeAfterBarrier = ds.getActiveStages(state);
    if (activeAfterBarrier.length > 0) {
      return { systemMessage: `✅ Barrier ${barrierGroup} 完成。等待 ${activeAfterBarrier.join(', ')} 完成...` };
    }

    return { systemMessage: `✅ Barrier ${barrierGroup} 完成。` };
  }

  // ── 分支 CRASH 處理：品質 stage 無 PIPELINE_ROUTE 輸出（crash）──
  // 條件：
  // 1. QUALITY stage（只有品質 agent 需要強制輸出 PIPELINE_ROUTE）
  // 2. transcript 確實存在且有 assistant 訊息（agent 有實際執行，但無路由輸出）
  //    - transcript 不存在 → 視為正常完成（測試/legacy 場景，進分支 C）
  //    - transcript 只有 user 訊息 → 非真實 crash（同上）
  //    - transcript 有 assistant 訊息但無路由 → 真正的 crash
  // 3. 未解析到任何路由（validatedRoute=null 且 source='none'，非 fallback）
  // IMPL stages（PLAN/ARCH/DEV/DOCS）無 PIPELINE_ROUTE 時一律視為 PASS 正常前進
  //
  // M-6 補充：對極早期崩潰（agent 幾乎無輸出）的偵測
  // transcriptHasAssistantMessage=false 時不觸發 CRASH（進分支 C 視為正常 PASS）
  // 但仍需記錄 warning，方便診斷非預期完成
  const isQualityStage = QUALITY_STAGES.includes(getBaseStage(currentStage));
  const hasAssistantMsg = transcriptHasAssistantMessage(transcriptPath);
  if (isQualityStage && !validatedRoute && routeSource === 'none' && !hasAssistantMsg) {
    // 極早期崩潰（無 assistant 訊息）：記錄 warning，繼續進分支 C
    try {
      const hookLogger = require('../hook-logger.js');
      hookLogger.error('pipeline-controller', new Error(
        `${currentStage} quality stage 無 PIPELINE_ROUTE 且 transcript 無 assistant 訊息，` +
        `視為正常完成（極早期崩潰或測試場景）。transcriptPath: ${transcriptPath || 'N/A'}`
      ));
      tlEmit(EVENT_TYPES.AGENT_CRASH, sessionId, {
        stage: currentStage,
        crashCount: 0,
        willRetry: false,
        note: 'early-crash: no assistant message, treating as PASS',
      });
    } catch (_) {}
  }

  const isQualityCrash = !validatedRoute && routeSource === 'none' &&
    isQualityStage && hasAssistantMsg;
  if (isQualityCrash) {
    const crashes = { ...(state.crashes || {}) };
    crashes[currentStage] = (crashes[currentStage] || 0) + 1;
    state = { ...state, crashes };
    const crashCount = crashes[currentStage];
    const MAX_CRASHES = 3;
    const willRetry = crashCount < MAX_CRASHES;

    emitAgentCrash(sessionId, currentStage, crashCount, willRetry);

    if (willRetry) {
      // 重設 stage 為 pending，重新委派
      state = ds.resetStageToPending(state, currentStage);
      if (state.activeStages) {
        state = { ...state, activeStages: state.activeStages.filter(s => s !== currentStage) };
      }
      ds.writeState(sessionId, state);

      const retryHint = buildDelegationHint(currentStage, pipeline.stageMap);
      return {
        systemMessage:
          `⛔ ${currentStage} agent 無 PIPELINE_ROUTE 輸出（第 ${crashCount}/${MAX_CRASHES} 次）。你必須立即重新委派。\n` +
          `⛔ 不要輸出文字，直接呼叫：${retryHint}\n` +
          `📌 委派 prompt 結尾加上：「最終輸出必須以 <!-- PIPELINE_ROUTE: {...} --> 結尾」`,
      };
    }

    // 達到 crash 上限 → 強制終止（行 1146 已 emit willRetry=false 事件）
    state = ds.markStageCompleted(state, currentStage, null);
    if (state.activeStages) {
      state = { ...state, activeStages: state.activeStages.filter(s => s !== currentStage) };
    }
    state = { ...state, pipelineActive: false, activeStages: [] };
    ds.writeState(sessionId, state);
    return {
      systemMessage: `⛔ ${currentStage} crash 達 ${crashCount} 次上限，Pipeline 異常終止。自動模式已解除。`,
    };
  }

  // ── 分支 C: 正常前進 ──
  // PASS 後清理反思記憶
  cleanReflectionForStage(sessionId, currentStage);
  state = ds.markStageCompleted(state, currentStage, routeResult);

  // Phase 2（soft 引入）：從 activeStages 移除已完成的 stage
  if (state.activeStages) {
    state = { ...state, activeStages: state.activeStages.filter(s => s !== currentStage) };
  }

  // ── Wisdom Accumulation（S4）──
  // 品質 stage PASS 時，從 context_file 提取學習筆記並追加到 pipeline-wisdom-{sid}.md
  // FAIL 不提取（避免寫入不正確的建議）
  const WISDOM_STAGES = new Set(['REVIEW', 'TEST', 'QA', 'E2E', 'SECURITY']);
  if (WISDOM_STAGES.has(getBaseStage(currentStage))) {
    const contextFile = state.stages?.[currentStage]?.contextFile;
    if (contextFile) {
      try {
        const contextContent = fs.existsSync(contextFile)
          ? fs.readFileSync(contextFile, 'utf8')
          : null;
        if (contextContent) {
          const wisdom = extractWisdom(currentStage, contextContent);
          if (wisdom) writeWisdom(sessionId, currentStage, wisdom.summary);
        }
      } catch (_) {
        // 非關鍵路徑，靜默忽略
      }
    }
  }

  // Token 效率：品質 stage 完成時偵測回應長度
  // 優先使用 last_assistant_message（ECC SubagentStop 直接提供），fallback 到 transcript 解析
  // > 500 chars → emit TRANSCRIPT_LEAK_WARNING，累加 leakAccumulated
  if (isQualityStage) {
    const responseLen = lastAssistantMessage.length || getLastAssistantResponseLength(transcriptPath);
    const LEAK_THRESHOLD = 500;
    if (responseLen > LEAK_THRESHOLD) {
      try {
        tlEmit(EVENT_TYPES.TRANSCRIPT_LEAK_WARNING, sessionId, {
          stage: currentStage,
          responseLength: responseLen,
          threshold: LEAK_THRESHOLD,
        });
      } catch (_) {}
      const prevLeak = state.leakAccumulated || 0;
      const newLeak = prevLeak + responseLen;
      state = { ...state, leakAccumulated: newLeak };

      // 單次洩漏 > 1000 chars 或累積 > 1500 chars：在 systemMessage 注入 compact 建議
      if (responseLen > 1000 || newLeak > 1500) {
        leakCompactHint = `\n⚠️ 品質 Agent 回應過長（本次 ${responseLen} 字元，累積 ${newLeak} 字元）。建議在下次委派前執行 /compact 回收 context。`;
      }
    }
  }

  // 級聯跳過：反覆檢查 ready stages 是否需要 skip，直到穩定
  let readyStages = ds.getReadyStages(state);
  let skipIter = MAX_SKIP_ITERATIONS;
  while (readyStages.length > 0 && skipIter-- > 0) {
    let anySkipped = false;
    for (const stageId of readyStages) {
      const skip = shouldSkip(stageId, state);
      if (skip.skip) {
        state = ds.markStageSkipped(state, stageId, skip.reason);
        anySkipped = true;
      }
    }
    if (!anySkipped) break;
    readyStages = ds.getReadyStages(state);
  }

  // Barrier-crash 防護：當 barrier sibling 在 pending+crashed 狀態時，
  // 排除 barrier 下游 stage，強制先重跑 crashed sibling
  if (state.dag?.[currentStage]?.barrier) {
    const barrier = state.dag[currentStage].barrier;
    const siblings = barrier.siblings || [];
    const pendingCrashedSiblings = siblings.filter(s =>
      s !== currentStage &&
      ((state.stages?.[s]?.status || 'pending') === 'pending') &&
      ((state.crashes?.[s] || 0) > 0)
    );
    if (pendingCrashedSiblings.length > 0 && barrier.next) {
      readyStages = readyStages.filter(s => s !== barrier.next);
      emitBarrierCrashGuard(sessionId, currentStage, barrier.next, pendingCrashedSiblings);
    }
  }
  if (skipIter <= 0 && readyStages.length > 0) {
    const hookLogger = require('../hook-logger.js');
    hookLogger.error('pipeline-controller', new Error(
      `級聯跳過迴圈超過 ${MAX_SKIP_ITERATIONS} 次上限，剩餘 ready: ${readyStages.join(',')}`
    ));
  }

  // 檢查是否完成：若完成，合併 pipelineActive=false 到同一次寫入
  if (ds.isComplete(state)) {
    // v4（任務 3.4）：最後一個 stage 完成 → pipelineActive = false（guard 解除）
    state = { ...state, pipelineActive: false, activeStages: [] };
    cleanupPatches();
    ds.writeState(sessionId, state);
    autoCheckpoint(currentStage);
    // 若當前 stage 為 FAIL 但因 enforcePolicy（如無 DEV in DAG）強制前進至完成，
    // 在完成訊息前加入 FAIL 警告
    const completionMsg = buildCompleteOutput(state, currentStage, pipeline);
    const isFailStage = verdictForStop && verdictForStop.verdict === 'FAIL';
    if (isFailStage) {
      const failSuffix = policyEnforced && policyReason
        ? `（${policyReason}）`
        : '（FAIL 但強制繼續）';
      return {
        systemMessage: `⚠️ ${currentStage} FAIL${failSuffix}\n` + completionMsg.systemMessage,
      };
    }
    return completionMsg;
  }

  ds.writeState(sessionId, state);
  autoCheckpoint(currentStage);

  if (readyStages.length === 0) {
    // 沒有 ready stages 但也沒完成 → 等待其他 active stages
    const active = ds.getActiveStages(state);
    if (active.length > 0) {
      return { systemMessage: (`✅ ${currentStage} 完成。等待 ${active.join(', ')} 完成...` + leakCompactHint) || null };
    }
    // 理論上不該發生
    return { systemMessage: (`✅ ${currentStage} 完成。` + leakCompactHint) || null };
  }

  // 有 ready stages → 發出委派指令
  const stageContext = readyStages.map(s => buildStageContext(s, currentStage, state)).join('');
  const hints = readyStages.map(s => buildDelegationHint(s, pipeline.stageMap));
  const parallel = readyStages.length > 1;
  const label = parallel
    ? `${readyStages.join(' + ')}（並行）`
    : readyStages[0];

  // 品質階段完成後：精簡提示（Phase 0：不重複報告內容，context_file 已有詳細資訊）
  const qualityWarning = QUALITY_STAGES.includes(getBaseStage(currentStage))
    ? '\n⚠️ 如有問題，必須透過 /vibe:dev 委派修復。'
    : '';

  // 下一階段是品質 stage → 提醒 Main Agent 在委派 prompt 中強調 PIPELINE_ROUTE
  const nextIsQuality = readyStages.some(s => QUALITY_STAGES.includes(getBaseStage(s)));
  const routeReminder = nextIsQuality
    ? '\n📌 委派 prompt 結尾加上：「最終輸出必須以 <!-- PIPELINE_ROUTE: {...} --> 結尾」'
    : '';

  // Phase 2：為第一個 ready stage 生成 Node Context
  // 並行時只生成第一個（各 stage 的 Node Context 格式相同，agent 可從 context 判斷自己的 stage）
  let nodeContextStr = '';
  if (readyStages.length > 0 && state.dag) {
    try {
      const firstStage = readyStages[0];
      const nodeCtx = buildNodeContext(state.dag, state, firstStage, sessionId);
      nodeContextStr = '\n' + formatNodeContext(nodeCtx);
    } catch (_) {}
  }

  // M-2：為 suffixed ready stage 注入 phase 任務範圍（buildPhaseScopeHint）
  let phaseScopeStr = '';
  if (readyStages.length > 0) {
    try {
      const firstStage = readyStages[0];
      const scopeHint = buildPhaseScopeHint(firstStage, state);
      if (scopeHint) phaseScopeStr = `\n${scopeHint}`;
    } catch (_) {}
  }

  // S3.9：suffixed stage 完成時建議 Main Agent 更新 TaskList 進度
  const phaseCompletionHint = buildPhaseCompletionHint(currentStage, routeResult?.verdict || 'PASS');
  const phaseHintStr = phaseCompletionHint ? `\n${phaseCompletionHint}` : '';

  const mainMsg =
    `✅ ${currentStage} 完成 → 立即呼叫 ${label}\n` +
    `⛔ 你必須立即呼叫以下 Skill，不要輸出文字：${hints.join(' + ')}${stageContext}${qualityWarning}${routeReminder}${phaseHintStr}${phaseScopeStr}${nodeContextStr}`;

  return {
    systemMessage: (mainMsg + leakCompactHint) || null,
  };
}

/** 處理 pipeline-architect agent 完成 */
function handlePipelineArchitectComplete(sessionId, transcriptPath, pipeline) {
  let state = loadState(sessionId);
  if (!state) state = ds.createInitialState(sessionId);

  // pipeline-architect 被使用者明確呼叫 → 若分類為 none 則重分類為 custom
  const currentPid = ds.getPipelineId(state);
  if (!currentPid || currentPid === 'none') {
    state = ds.classify(state, {
      pipelineId: 'custom',
      taskType: 'feature',
      source: 'pipeline-architect',
    });
  }

  // 從 transcript 解析 DAG
  let dag = null;
  let blueprint = null;
  let enforced = true;
  let rationale = '';

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const dagMatch = content.match(/<!-- PIPELINE_DAG_START -->\s*([\s\S]*?)\s*<!-- PIPELINE_DAG_END -->/);
      if (dagMatch) {
        const parsed = JSON.parse(dagMatch[1]);
        dag = parsed.dag;
        blueprint = parsed.blueprint || null;
        enforced = parsed.enforced !== false;
        rationale = parsed.rationale || '';
      }
    } catch (_) {}
  }

  // DAG 驗證 + 修復鏈
  if (dag) {
    let validation = validateDag(dag);

    // Phase 1: 驗證失敗 → 嘗試修復
    if (!validation.valid) {
      const repair = repairDag(dag);
      if (repair) {
        // 修復成功 → 重新驗證
        const revalidation = validateDag(repair.dag);
        if (revalidation.valid) {
          dag = repair.dag;
          validation = revalidation;
          rationale += (rationale ? ' | ' : '') + `DAG 自動修復：${repair.fixes.join('; ')}`;
          try {
            const hookLogger = require('../hook-logger.js');
            hookLogger.error('pipeline-controller', new Error(
              `pipeline-architect DAG 自動修復成功：${repair.fixes.join('; ')}`
            ));
          } catch (_) {}
        }
      }
    }

    if (!validation.valid) {
      // 修復也失敗 → 降級為 quick-dev 安全模板（含品質把關）
      dag = {
        DEV:    { deps: [] },
        REVIEW: { deps: ['DEV'] },
        TEST:   { deps: ['DEV'] },
      };
      blueprint = [
        { step: 1, stages: ['DEV'], parallel: false },
        { step: 2, stages: ['REVIEW', 'TEST'], parallel: true },
      ];
      rationale = `DAG 驗證失敗（${validation.errors.join('; ')}），降級為 quick-dev`;
    } else {
      // Phase 2: DAG 合法 → 品質保障 + v4 metadata 注入
      dag = ensureQualityStagesIfDev(dag);

      // S3.7：整合 phase-level D-R-T 循環
      // 當 tasks.md 有 ≥ 2 個 phase 時，用 phase DAG 覆蓋 pipeline-architect 產出的 DAG
      const phaseResult = tryGeneratePhaseDag(state);
      if (phaseResult && Object.keys(phaseResult.dag).length > 0) {
        dag = phaseResult.dag;
        rationale += (rationale ? ' | ' : '') + `Phase-level D-R-T（${countPhaseCount(phaseResult.dag)} phases）`;
        // M-3：直接使用 tryGeneratePhaseDag 已解析的 phases，避免 extractPhaseInfo 重複 I/O
        const phaseInfoFromResult = {};
        for (const phase of phaseResult.phases) {
          phaseInfoFromResult[phase.index] = { name: phase.name, tasks: phase.tasks };
        }
        state = { ...state, phaseInfo: phaseInfoFromResult };
      } else {
        dag = enrichCustomDag(dag);
      }

      if (!blueprint && dag) {
        blueprint = buildBlueprint(dag);
      }
    }
  } else {
    // 無法解析 → 安全模板（quick-dev：DEV + REVIEW + TEST）
    dag = {
      DEV:    { deps: [] },
      REVIEW: { deps: ['DEV'] },
      TEST:   { deps: ['DEV'] },
    };
    blueprint = [
      { step: 1, stages: ['DEV'], parallel: false },
      { step: 2, stages: ['REVIEW', 'TEST'], parallel: true },
    ];
    rationale = 'DAG 解析失敗，降級為 quick-dev';
  }

  // 設定 DAG
  state = ds.setDag(state, dag, blueprint, enforced);

  // 跳過判斷
  for (const stageId of Object.keys(dag)) {
    const skip = shouldSkip(stageId, state);
    if (skip.skip) {
      state = ds.markStageSkipped(state, stageId, skip.reason);
    }
  }

  // S3.8：如果是 phase-level DAG，儲存 phase 資訊到 state（供 node-context 使用）
  // M-3：若已由 tryGeneratePhaseDag 路徑注入 phaseInfo，則跳過重複 I/O 的 extractPhaseInfo
  if (!state.phaseInfo) {
    const phaseInfo = extractPhaseInfo(dag);
    if (phaseInfo) {
      state = { ...state, phaseInfo };
    }
  }

  ds.writeState(sessionId, state);

  // 計算第一批
  const ready = ds.getReadyStages(state);
  const stageCount = Object.keys(dag).length;
  const skippedCount = ds.getSkippedStages(state).length;
  const parallelGroups = blueprint ? blueprint.filter(b => b.parallel).length : 0;

  const hints = ready.map(s => buildDelegationHint(s, pipeline.stageMap));

  // S3.8：phase 進度摘要（供 Main Agent 用 TaskCreate 建立 todos）
  const phaseProgressMsg = buildPhaseProgressSummary(state, dag);

  return {
    systemMessage:
      `⛔ Pipeline 已建立（${stageCount} 階段` +
      (skippedCount > 0 ? `，${skippedCount} 跳過` : '') +
      (parallelGroups > 0 ? `，${parallelGroups} 組並行` : '') +
      `）。\n` +
      (rationale ? `📋 ${rationale}\n` : '') +
      phaseProgressMsg +
      `➡️ ${hints.join(' + ')}`,
  };
}

// ────────────────── S3 Phase-Level 輔助函式 ──────────────────

/**
 * 找到活躍 openspec/changes 下第一個存在的 tasks.md 路徑（排除 archive/）。
 *
 * 目錄依名稱降序排列（最新優先）。
 * 供 tryGeneratePhaseDag 和 extractPhaseInfo 共用，消除重複的目錄遍歷邏輯。
 *
 * @returns {string[]|null} tasks.md 路徑陣列（依優先順序），或 null（changesDir 不存在）
 */
function findActiveTasksMd() {
  try {
    const changesDir = path.join(process.cwd(), 'openspec', 'changes');
    if (!fs.existsSync(changesDir)) return null;

    const dirs = fs.readdirSync(changesDir)
      .filter(d => d !== 'archive' && fs.statSync(path.join(changesDir, d)).isDirectory())
      .sort()   // 確定性排序
      .reverse(); // 最新的在前

    const tasksPaths = [];
    for (const dir of dirs) {
      const tasksPath = path.join(changesDir, dir, 'tasks.md');
      if (fs.existsSync(tasksPath)) {
        tasksPaths.push(tasksPath);
      }
    }
    return tasksPaths.length > 0 ? tasksPaths : null;
  } catch (_) {
    return null;
  }
}

/**
 * 嘗試從 openspec/changes 的 tasks.md 生成 phase DAG。
 *
 * 讀取活躍 change 的 tasks.md，解析 phase 結構，
 * 如果有 ≥ 2 個 phase 則生成 phase-level DAG。
 *
 * M-3 修復：同時返回 phases 資料，供呼叫端直接建立 phaseInfo，
 * 避免 extractPhaseInfo 重複讀取 tasks.md（I/O 最佳化）。
 *
 * @param {Object} state - pipeline state（含 classification.pipelineId）
 * @returns {{ dag: Object, phases: Array }|null} dag + phases，或 null（退化）
 */
function tryGeneratePhaseDag(state) {
  const pipelineId = ds.getPipelineId(state) || 'standard';
  const tasksPaths = findActiveTasksMd();
  if (!tasksPaths) return null;

  try {
    for (const tasksPath of tasksPaths) {
      const content = fs.readFileSync(tasksPath, 'utf8');
      const phases = parsePhasesFromTasks(content);
      if (phases.length < 2) continue;

      const phaseDag = generatePhaseDag(phases, pipelineId);
      if (Object.keys(phaseDag).length > 0) {
        // 返回 dag 和 phases（供呼叫端直接建立 phaseInfo）
        return { dag: phaseDag, phases };
      }
    }
  } catch (_) {}
  return null;
}

/**
 * 從 currentStage 提取 phase suffix，在 DAG 中找到對應的 DEV:N stage。
 *
 * 用於 FAIL 回退路徑：確保 REVIEW:2 FAIL → 回退到 DEV:2，而非 DEV:1。
 * Branch A（非 barrier）和 Barrier FAIL 分支共用此邏輯。
 *
 * @param {string} currentStage - 失敗的 stage ID（如 'REVIEW:2', 'TEST:3'）
 * @param {Object} dag - pipeline DAG（可為 null）
 * @returns {string} DEV stage ID（如 'DEV:2', 'DEV:1', 'DEV'）
 */
function resolvePhaseDevStageId(currentStage, dag) {
  // 嘗試從 currentStage 提取 phase suffix（如 REVIEW:2 → ':2'）
  const suffixMatch = currentStage.match(/:(\d+)$/);
  if (suffixMatch && dag) {
    const phaseSuffix = `:${suffixMatch[1]}`;
    const samePhaseDevKey = `DEV${phaseSuffix}`;
    if (dag[samePhaseDevKey]) return samePhaseDevKey;
  }
  // fallback：找第一個 DEV（非 phase DAG 或 DEV:N 不存在）
  return Object.keys(dag || {}).find(s => getBaseStage(s) === 'DEV') || 'DEV';
}

/**
 * 計算 phase-level DAG 中的 phase 數量。
 * 計算有多少個 DEV:N stage（每個代表一個 phase）。
 *
 * @param {Object} dag
 * @returns {number}
 */
function countPhaseCount(dag) {
  if (!dag) return 0;
  return Object.keys(dag).filter(s => getBaseStage(s) === 'DEV' && s.includes(':')).length;
}

/**
 * 從 phase-level DAG 提取 phase 資訊（供 node-context 使用）。
 *
 * @param {Object} dag
 * @returns {Object|null} phaseInfo 物件，或 null（非 phase DAG）
 */
function extractPhaseInfo(dag) {
  if (!dag) return null;
  // M-2 修復：與 countPhaseCount 保持一致，用 getBaseStage 判斷而非 startsWith
  const devStages = Object.keys(dag).filter(s => getBaseStage(s) === 'DEV' && s.includes(':'));
  if (devStages.length === 0) return null;

  // 嘗試從 openspec/changes 讀取 phase 名稱和 tasks（使用共用 findActiveTasksMd 避免重複 I/O 邏輯）
  const tasksPaths = findActiveTasksMd();
  if (!tasksPaths) return null;

  const phaseData = {};
  try {
    for (const tasksPath of tasksPaths) {
      const content = fs.readFileSync(tasksPath, 'utf8');
      const phases = parsePhasesFromTasks(content);

      for (const phase of phases) {
        phaseData[phase.index] = {
          name: phase.name,
          tasks: phase.tasks,
        };
      }
      if (Object.keys(phaseData).length > 0) break;
    }
  } catch (_) {}

  return Object.keys(phaseData).length > 0 ? phaseData : null;
}

/**
 * 建立 phase 進度摘要訊息（S3.8：供 Main Agent 用 TaskCreate 建立 todos）。
 *
 * 格式：
 *   Pipeline: standard (N phases)
 *    Phase 1: 標題 [DEV:1 ⏳] [REVIEW:1 ⏳] [TEST:1 ⏳]
 *    Phase 2: 標題 [DEV:2 ⏳] [REVIEW:2 ⏳] [TEST:2 ⏳]
 *
 * @param {Object} state - pipeline state（含 phaseInfo + stages）
 * @param {Object} dag - phase DAG
 * @returns {string} 進度摘要字串，非 phase DAG 時返回空字串
 */
function buildPhaseProgressSummary(state, dag) {
  if (!dag) return '';
  // M-2 修復：與 countPhaseCount 保持一致，用 getBaseStage 判斷而非 startsWith
  const devStages = Object.keys(dag).filter(s => getBaseStage(s) === 'DEV' && s.includes(':'));
  if (devStages.length === 0) return '';

  const phaseInfo = state?.phaseInfo || {};
  const pipelineId = ds.getPipelineId(state) || 'pipeline';
  const phaseCount = devStages.length;

  const lines = [`📌 Pipeline: ${pipelineId} (${phaseCount} phases)`];

  for (const devStageId of devStages.sort()) {
    const idxMatch = devStageId.match(/^DEV:(\d+)$/);
    if (!idxMatch) continue;
    const idx = parseInt(idxMatch[1], 10);
    const info = phaseInfo[idx];
    const phaseName = info?.name || `Phase ${idx}`;

    // 收集此 phase 的所有 stages
    const phaseStages = Object.keys(dag).filter(s => {
      const match = s.match(/:(\d+)$/);
      return match && parseInt(match[1], 10) === idx;
    });

    const stageStatus = phaseStages
      .sort()
      .map(s => `[${s} ⏳]`)
      .join(' ');

    lines.push(` ${phaseName}: ${stageStatus}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * 建立 phase 完成建議訊息（S3.9：onStageComplete 時同步 TaskUpdate）。
 *
 * @param {string} stageId - 已完成的 stage ID（如 'REVIEW:1'）
 * @param {string} verdict - PASS 或 FAIL
 * @returns {string} 建議訊息，非 suffixed stage 返回空字串
 */
function buildPhaseCompletionHint(stageId, verdict) {
  const suffixMatch = stageId.match(/^([A-Z]+):(\d+)$/);
  if (!suffixMatch) return '';

  const baseStage = suffixMatch[1];
  const phaseIdx = suffixMatch[2];
  const verdictEmoji = verdict === 'PASS' ? '✅' : '❌';

  return `📌 Phase ${phaseIdx} 的 ${baseStage} 完成（${verdict} ${verdictEmoji}），建議更新 TaskList 進度`;
}

/** 組裝完成輸出 */
function buildCompleteOutput(state, completedStage, pipeline) {
  const completed = ds.getCompletedStages(state);
  const skipped = ds.getSkippedStages(state);
  const pipelineId = ds.getPipelineId(state) || 'pipeline';

  return {
    systemMessage:
      `✅ Pipeline [${pipelineId}] 完成！\n` +
      `已完成：${completed.join(', ')}` +
      (skipped.length > 0 ? `\n⏭️ 跳過：${skipped.join(', ')}` : '') +
      `\n\nPipeline 自動模式已解除，可以直接操作。`,
  };
}

// ────────────────── 5. onSessionStop ──────────────────

/**
 * 閉環檢查（Stop hook）
 *
 * v4 簡化：從 pipelineActive 判斷是否需要阻擋，不再使用 enforced + derivePhase。
 *
 * @returns {{ continue: boolean, stopReason?: string, systemMessage?: string } | null}
 */
function onSessionStop(sessionId) {
  let state = loadState(sessionId);
  if (!state) return null;
  if (!state.dag) return null;

  // v4：pipelineActive=false → 放行（包含 IDLE、COMPLETE、已取消）
  if (!ds.isActive(state)) return null;

  const ready = ds.getReadyStages(state);
  const active = ds.getActiveStages(state);
  const failed = Object.entries(state.stages)
    .filter(([, s]) => s.status === ds.STAGE_STATUS.FAILED)
    .map(([id]) => id);
  const readySet = new Set(ready);
  const pending = Object.entries(state.stages)
    .filter(([id, s]) => s.status === ds.STAGE_STATUS.PENDING && !readySet.has(id))
    .map(([id]) => id);

  const missing = [...failed, ...active, ...ready, ...pending];
  if (missing.length === 0) return null;

  // 連續阻擋計數
  const blockCount = (state.meta?.pipelineCheckBlocks || 0) + 1;
  state.meta = state.meta || {};
  state.meta.pipelineCheckBlocks = blockCount;
  ds.writeState(sessionId, state);

  // ── Crash Recovery：自動回收 crashed+pending 的階段 ──
  // Agent crash 產生明確的 crashes 計數器，無需等 blockCount
  // 累積 — 有 crash 就立即回收（-p 模式只有一次 Stop 事件）
  {
    const crashedPending = Object.entries(state.stages)
      .filter(([id, s]) => s.status === ds.STAGE_STATUS.PENDING && (state.crashes?.[id] || 0) > 0);

    if (crashedPending.length > 0) {
      let recovered = 0;
      for (const [stageId] of crashedPending) {
        // 嘗試從 context_file 推斷 verdict
        const ctxPath = path.join(CLAUDE_DIR, `pipeline-context-${sessionId}-${stageId}.md`);
        let inferredVerdict = null;

        if (fs.existsSync(ctxPath)) {
          try {
            const content = fs.readFileSync(ctxPath, 'utf8');
            if (content.trim().length > 0) {
              inferredVerdict = inferRouteFromContent([content], stageId);
            }
          } catch (_) { /* ignore read errors */ }
        }

        // 從 retryHistory 取最近 verdict 作為 fallback
        if (!inferredVerdict && state.retryHistory?.[stageId]?.length > 0) {
          const last = state.retryHistory[stageId][state.retryHistory[stageId].length - 1];
          inferredVerdict = { verdict: last.verdict || 'FAIL', route: 'NEXT', _crashRecovered: true };
        }

        // 最終 fallback：標記為 FAIL
        if (!inferredVerdict) {
          inferredVerdict = { verdict: 'FAIL', route: 'NEXT', _crashRecovered: true };
        }

        inferredVerdict._crashRecovered = true;

        state = ds.markStageCompleted(state, stageId, inferredVerdict);
        recovered++;

        emitStageCrashRecovery(sessionId, stageId, inferredVerdict, blockCount,
          fs.existsSync(ctxPath) ? 'context_file' : 'retryHistory_fallback');
      }

      if (recovered > 0) {
        ds.writeState(sessionId, state);

        // 重新檢查：是否所有 stage 都已完成
        const stillMissing = Object.entries(state.stages)
          .filter(([, s]) => s.status !== ds.STAGE_STATUS.COMPLETED && s.status !== ds.STAGE_STATUS.SKIPPED);

        if (stillMissing.length === 0) {
          state.pipelineActive = false;
          ds.writeState(sessionId, state);
          return null; // pipeline 完成，放行
        }
      }
    }
  }

  // 超過 5 次 → 放行（避免無限迴圈；使用者可用 /vibe:cancel）
  if (blockCount > 5) return null;

  const cancelHint = blockCount >= 3
    ? `（連續 ${blockCount} 次，輸入 /vibe:cancel 可取消）`
    : '';

  const pipeline = discoverPipeline();
  const hints = missing.slice(0, 3).map(s => {
    const info = resolveAgent(s, pipeline.stageMap);
    const label = STAGES[getBaseStage(s)]?.label || s;
    if (info?.skill) return `${info.skill}`;
    if (info?.agent) return `委派 ${info.agent}`;
    return s;
  }).join('、');

  return {
    continue: false,
    stopReason: `Pipeline 未完成 — 缺 ${missing.length} 個階段${cancelHint}`,
    systemMessage:
      `⛔ 禁止停止！Pipeline 缺 ${missing.join(', ')} 尚未完成。\n` +
      `你必須立即呼叫 Skill 工具：${hints}\n` +
      `不要輸出文字，直接呼叫工具。`,
  };
}

// ────────────────── Exports ──────────────────

module.exports = {
  classify,
  canProceed,
  onDelegate,
  onStageComplete,
  onSessionStop,
  // 暴露用於測試
  loadState,
  buildDelegationHint,
  buildStageContext,
  buildKnowledgeHints,
  extractShortAgent,
  MAX_SKIP_ITERATIONS,
  resolvePhaseDevStageId,
};
