#!/usr/bin/env node
/**
 * pipeline-controller.js — Pipeline v3 統一 API
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
const { getBaseStage, resolveAgent, validateDag, linearToDag, buildBlueprint } = require('./dag-utils.js');
const { shouldSkip } = require('./skip-predicates.js');
const { ensureV3 } = require('./state-migrator.js');
const { parseVerdict } = require('./verdict.js');
const { shouldRetryStage } = require('./retry-policy.js');
const { discoverPipeline } = require('./pipeline-discovery.js');

// Registry
const {
  STAGES, AGENT_TO_STAGE, NAMESPACED_AGENT_TO_STAGE,
  PIPELINES, PIPELINE_PRIORITY, PIPELINE_TO_TASKTYPE,
  MAX_RETRIES, QUALITY_STAGES,
  STAGE_CONTEXT, POST_STAGE_HINTS, OPENSPEC_CONTEXT,
  FRONTEND_FRAMEWORKS, API_ONLY_FRAMEWORKS,
} = require('../registry.js');

// Classifier（LLM-first — Layer 1 explicit + Layer 2 LLM）
const { classifyWithConfidence } = require('./classifier.js');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// 級聯跳過迴圈上限（pipeline 最多 9 階段，20 足夠任何 DAG）
const MAX_SKIP_ITERATIONS = 20;

// ────────────────── 工具函式 ──────────────────

/** 提取 short agent 名稱（去 plugin 前綴） */
function extractShortAgent(agentType) {
  return agentType.includes(':') ? agentType.split(':')[1] : agentType;
}

/** 讀取 state（自動遷移 v2→v3） */
function loadState(sessionId) {
  const raw = ds.readState(sessionId);
  if (!raw) return null;
  return ensureV3(raw);
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

  // COMPLETE → reset
  if (state && ds.isComplete(state)) {
    state = ds.reset(state);
    ds.writeState(sessionId, state);
  }

  // 未初始化 → 建立
  if (!state) {
    state = ds.createInitialState(sessionId, {});
    ds.writeState(sessionId, state);
  }

  // 已取消 → 只有顯式 [pipeline:xxx] 才能重新啟動
  if (state && ds.isCancelled(state)) {
    if (result.source !== 'explicit') {
      return { output: null }; // 非顯式分類被抑制
    }
    // 顯式指定 → 重設取消狀態，允許重新分類
    state = ds.reset(state);
    ds.writeState(sessionId, state);
  }

  // 已分類 + 同一 pipeline → 不重複
  const existingPipelineId = ds.getPipelineId(state);
  if (existingPipelineId === pipelineId && existingPipelineId) {
    return { output: null }; // 不輸出
  }

  // 升級判斷
  if (existingPipelineId && existingPipelineId !== pipelineId) {
    const isUpgrade = (PIPELINE_PRIORITY[pipelineId] || 0) > (PIPELINE_PRIORITY[existingPipelineId] || 0);
    if (!isUpgrade) {
      // 降級：檢查 stale
      const last = state.meta?.lastTransition ? new Date(state.meta.lastTransition).getTime() : 0;
      const isStale = (Date.now() - last) > 10 * 60 * 1000;
      if (!isStale) return { output: null };
      // stale → reset + 重分類
      state = ds.reset(state);
    }
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

  // trivial/research → additionalContext
  if (stages.length === 0 || pipelineId === 'none') {
    return {
      output: { additionalContext: `[分類] ${pipelineId} — 直接回答` },
    };
  }

  // 已知模板 → 立即建 DAG（不論 explicit 或 regex/LLM 來源）
  // pipeline-architect 只用於未知模板、自訂 DAG、或重複 stage（如 test-first [TEST,DEV,TEST]）
  const hasUniqueStages = new Set(stages).size === stages.length;
  if (PIPELINES[pipelineId] && stages.length > 0 && hasUniqueStages) {
    const dag = linearToDag(stages);
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

    return {
      output: {
        systemMessage:
          `⛔ Pipeline ${sourceLabel}（${stageStr}）已建立。\n` +
          `➡️ ${firstHint}`,
      },
    };
  }

  // 未知模板 → 指示呼叫 /vibe:pipeline skill（讓 Agent 動態生成 DAG）
  return {
    output: {
      systemMessage:
        `⛔ 任務需要自訂 Pipeline。呼叫 /vibe:pipeline skill 啟動 pipeline-architect 分析需求並產出執行計劃。`,
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
  const stage = AGENT_TO_STAGE[shortAgent] || '';

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
function onStageComplete(sessionId, agentType, transcriptPath) {
  const pipeline = discoverPipeline();
  const shortAgent = extractShortAgent(agentType);

  // 偵測是否為 pipeline-architect
  if (shortAgent === 'pipeline-architect') {
    return handlePipelineArchitectComplete(sessionId, transcriptPath, pipeline);
  }

  // 正常 stage agent
  const currentStage = pipeline.agentToStage[agentType] || AGENT_TO_STAGE[shortAgent];
  if (!currentStage) return { systemMessage: '' };

  let state = loadState(sessionId);
  if (!state) return { systemMessage: '' };

  // Design 需求偵測
  if (detectDesignNeed(state, currentStage)) {
    state = { ...state, needsDesign: true };
  }

  // 解析 verdict
  const verdict = parseVerdict(transcriptPath);

  // 回退決策
  const retries = ds.getRetries(state);
  const retryCount = retries[currentStage] || 0;
  const { shouldRetry } = shouldRetryStage(currentStage, verdict, retryCount);

  // ── 分支 A: 回退 ──
  if (shouldRetry) {
    // 檢查 DAG 中是否有 DEV
    const hasDev = state.dag && Object.keys(state.dag).some(s => getBaseStage(s) === 'DEV');

    if (!hasDev) {
      // 無 DEV → 強制繼續
      state = ds.markStageCompleted(state, currentStage, verdict);
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
    state = ds.markStageFailed(state, currentStage, verdict);
    state = ds.setPendingRetry(state, {
      stages: [{ id: currentStage, severity: verdict?.severity, round: retryCount + 1 }],
    });
    ds.writeState(sessionId, state);

    const devHint = buildDelegationHint('DEV', pipeline.stageMap);
    return {
      systemMessage:
        `🔄 ${currentStage} FAIL:${verdict?.severity}（${retryCount + 1}/${MAX_RETRIES}）\n` +
        `➡️ ${devHint}`,
    };
  }

  // ── 分支 B: 回退重驗（DEV 完成後重跑失敗的 stage）──
  const pendingRetry = ds.getPendingRetry(state);
  if (pendingRetry?.stages?.length > 0 && getBaseStage(currentStage) === 'DEV') {
    state = ds.markStageCompleted(state, currentStage, verdict);

    // 重設所有 failed stages 為 pending
    for (const retry of pendingRetry.stages) {
      state = ds.resetStageToPending(state, retry.id);
    }
    state = ds.clearPendingRetry(state);
    ds.writeState(sessionId, state);
    autoCheckpoint(currentStage);

    const retryTargets = pendingRetry.stages.map(r => r.id);
    const hints = retryTargets.map(s => buildDelegationHint(s, pipeline.stageMap)).join(' + ');
    return {
      systemMessage: `🔄 DEV 修復完成 → 重跑 ${retryTargets.join(' + ')}\n➡️ ${hints}`,
    };
  }

  // ── 分支 C: 正常前進 ──
  state = ds.markStageCompleted(state, currentStage, verdict);

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
  if (skipIter <= 0 && readyStages.length > 0) {
    const hookLogger = require('../hook-logger.js');
    hookLogger.error('pipeline-controller', new Error(
      `級聯跳過迴圈超過 ${MAX_SKIP_ITERATIONS} 次上限，剩餘 ready: ${readyStages.join(',')}`
    ));
  }

  ds.writeState(sessionId, state);
  autoCheckpoint(currentStage);

  // 檢查是否完成
  if (ds.isComplete(state)) {
    cleanupPatches();
    return buildCompleteOutput(state, currentStage, pipeline);
  }

  if (readyStages.length === 0) {
    // 沒有 ready stages 但也沒完成 → 等待其他 active stages
    const active = ds.getActiveStages(state);
    if (active.length > 0) {
      return { systemMessage: `✅ ${currentStage} 完成。等待 ${active.join(', ')} 完成...` };
    }
    // 理論上不該發生
    return { systemMessage: `✅ ${currentStage} 完成。` };
  }

  // 有 ready stages → 發出委派指令
  const stageContext = readyStages.map(s => buildStageContext(s, currentStage, state)).join('');
  const hints = readyStages.map(s => buildDelegationHint(s, pipeline.stageMap));
  const parallel = readyStages.length > 1;
  const label = parallel
    ? `${readyStages.join(' + ')}（並行）`
    : readyStages[0];

  return {
    systemMessage:
      `✅ ${currentStage} → ${label}\n` +
      `➡️ ${hints.join(' + ')}${stageContext}`,
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

  // DAG 驗證
  if (dag) {
    const validation = validateDag(dag);
    if (!validation.valid) {
      // 非法 DAG → 降級為 DEV 安全模板
      dag = { DEV: { deps: [] } };
      blueprint = [{ step: 1, stages: ['DEV'], parallel: false }];
      rationale = `DAG 驗證失敗（${validation.errors.join('; ')}），降級為 DEV`;
    }
  } else {
    // 無法解析 → 安全模板
    dag = { DEV: { deps: [] } };
    blueprint = [{ step: 1, stages: ['DEV'], parallel: false }];
    rationale = 'DAG 解析失敗，降級為 DEV';
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

  ds.writeState(sessionId, state);

  // 計算第一批
  const ready = ds.getReadyStages(state);
  const stageCount = Object.keys(dag).length;
  const skippedCount = ds.getSkippedStages(state).length;
  const parallelGroups = blueprint ? blueprint.filter(b => b.parallel).length : 0;

  const hints = ready.map(s => buildDelegationHint(s, pipeline.stageMap));

  return {
    systemMessage:
      `⛔ Pipeline 已建立（${stageCount} 階段` +
      (skippedCount > 0 ? `，${skippedCount} 跳過` : '') +
      (parallelGroups > 0 ? `，${parallelGroups} 組並行` : '') +
      `）。\n` +
      (rationale ? `📋 ${rationale}\n` : '') +
      `➡️ ${hints.join(' + ')}`,
  };
}

/** 組裝完成輸出 */
function buildCompleteOutput(state, completedStage, pipeline) {
  const completed = ds.getCompletedStages(state);
  const skipped = ds.getSkippedStages(state);
  const completedStr = completed.join(' → ');

  return {
    systemMessage:
      `✅ Pipeline 完成！\n` +
      `已完成：${completedStr}` +
      (skipped.length > 0 ? `\n⏭️ 跳過：${skipped.join(', ')}` : '') +
      `\n\n📌 後續動作：\n` +
      `1️⃣ 執行 /vibe:verify 最終驗證\n` +
      `2️⃣ 向使用者報告成果\n` +
      `3️⃣ AskUserQuestion（multiSelect: true）提供選項\n` +
      `⚠️ Pipeline 自動模式已解除。`,
  };
}

// ────────────────── 5. onSessionStop ──────────────────

/**
 * 閉環檢查（Stop hook）
 *
 * @returns {{ continue: boolean, stopReason?: string, systemMessage?: string } | null}
 */
function onSessionStop(sessionId) {
  const state = loadState(sessionId);
  if (!state) return null;
  if (!state.dag) return null;

  const phase = ds.derivePhase(state);

  // COMPLETE / IDLE → 放行
  if (phase === ds.PHASES.COMPLETE || phase === ds.PHASES.IDLE) return null;

  // enforced + 有遺漏 → 阻擋
  if (!state.enforced) return null;

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

  // 連續阻擋計數（使用者可見提示，不在 systemMessage 中提及 cancel）
  const blockCount = (state.meta?.pipelineCheckBlocks || 0) + 1;
  state.meta = state.meta || {};
  state.meta.pipelineCheckBlocks = blockCount;
  ds.writeState(sessionId, state);

  const cancelHint = blockCount >= 3
    ? `（連續 ${blockCount} 次，輸入 /vibe:cancel 可取消）`
    : '';

  const pipeline = discoverPipeline();
  const hints = missing.slice(0, 3).map(s => {
    const info = resolveAgent(s, pipeline.stageMap);
    const label = STAGES[getBaseStage(s)]?.label || s;
    if (info?.skill) return `- ${label}：${info.skill}`;
    if (info?.agent) return `- ${label}：委派 ${info.agent}`;
    return `- ${label}`;
  }).join('\n');

  return {
    continue: false,
    stopReason: `Pipeline 未完成 — 缺 ${missing.length} 個階段${cancelHint}`,
    systemMessage:
      `⛔ Pipeline 未完成！缺：${missing.join(', ')}\n${hints}\n` +
      `必須使用 Skill/Task 委派下一階段。禁止純文字回覆。`,
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
  extractShortAgent,
  MAX_SKIP_ITERATIONS,
};
