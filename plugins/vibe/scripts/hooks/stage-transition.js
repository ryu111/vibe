#!/usr/bin/env node
/**
 * stage-transition.js — SubagentStop hook
 *
 * Agent 完成後判斷下一步：前進、回退、或完成。
 * v1.0.43 重構：拆分為 4 個純函式模組，此檔案為 thin orchestrator。
 *
 * 模組依賴：
 * - flow/verdict.js — parseVerdict()
 * - flow/retry-policy.js — shouldRetryStage()
 * - flow/skip-rules.js — resolveNextStage()
 * - flow/message-builder.js — buildXxxMessage()
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const { discoverPipeline, findNextStageInPipeline } = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-discovery.js'));
const { parseVerdict } = require(path.join(__dirname, '..', 'lib', 'flow', 'verdict.js'));
const { shouldRetryStage } = require(path.join(__dirname, '..', 'lib', 'flow', 'retry-policy.js'));
const { resolveNextStage } = require(path.join(__dirname, '..', 'lib', 'flow', 'skip-rules.js'));
const mb = require(path.join(__dirname, '..', 'lib', 'flow', 'message-builder.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const {
  PIPELINES, FRONTEND_FRAMEWORKS, API_ONLY_FRAMEWORKS,
  MAX_RETRIES, IMPL_STAGES,
} = require(path.join(__dirname, '..', 'lib', 'registry.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ────────────────── 工具函式 ──────────────────

/** git checkpoint（pipeline 階段完成時的回溯錨點） */
function autoCheckpoint(stage) {
  try {
    execSync(`git tag -f "vibe-pipeline/${stage.toLowerCase()}"`, { stdio: 'pipe', timeout: 5000 });
  } catch (_) {}
}

/** 從 state.completed 推導已完成階段列表 */
function getCompletedStages(completed, agentToStage) {
  const stages = [];
  for (const agent of (completed || [])) {
    const stage = agentToStage[agent];
    if (stage && !stages.includes(stage)) stages.push(stage);
  }
  return stages;
}

/** ARCH 完成後偵測 design-system.md → 設定 needsDesign */
function detectDesignNeed(state, currentStage) {
  if (currentStage !== 'ARCH' || !state.openspecEnabled) return;
  try {
    const changesDir = path.join(process.cwd(), 'openspec', 'changes');
    if (!fs.existsSync(changesDir)) return;
    const dirs = fs.readdirSync(changesDir)
      .filter(d => d !== 'archive' && fs.statSync(path.join(changesDir, d)).isDirectory());
    for (const dir of dirs) {
      if (fs.existsSync(path.join(changesDir, dir, 'design-system.md'))) {
        state.needsDesign = true;
        return;
      }
    }
  } catch (_) {}
}

/** auto-enforce：手動觸發 scope/architect 後自動升級為 enforced pipeline */
function autoEnforce(state, nextStage, completedStages) {
  if (state.pipelineEnforced || !nextStage) return;

  const pipelineId = state.pipelineId;
  let shouldEnforce = false;

  if (pipelineId && PIPELINES[pipelineId]) {
    shouldEnforce = PIPELINES[pipelineId].enforced;
    // 已完成 PLAN+ARCH 但 pipeline non-enforced → 升級
    if (!shouldEnforce && completedStages.includes('PLAN') && completedStages.includes('ARCH')) {
      shouldEnforce = true;
      const frameworkName = ((state.environment?.framework?.name) || '').toLowerCase();
      const isFrontend = FRONTEND_FRAMEWORKS.some(f => frameworkName.includes(f));
      state.pipelineId = isFrontend ? 'full' : 'standard';
      state.expectedStages = PIPELINES[state.pipelineId].stages;
    }
  } else {
    // 無 pipelineId（手動觸發）→ 若進入實作階段則 enforce
    shouldEnforce = IMPL_STAGES.includes(nextStage);
  }

  if (shouldEnforce) {
    state.pipelineEnforced = true;
    if (!state.pipelineId) {
      const frameworkName = ((state.environment?.framework?.name) || '').toLowerCase();
      const isFrontend = FRONTEND_FRAMEWORKS.some(f => frameworkName.includes(f));
      state.pipelineId = isFrontend ? 'full' : 'standard';
    }
    // 新/stale pipelineId → 必須同步 expectedStages
    state.expectedStages = PIPELINES[state.pipelineId].stages;
    if (!state.taskType || state.taskType === 'quickfix' || state.taskType === 'research') {
      state.taskType = 'feature';
    }
  }
}

// ────────────────── 主邏輯 ──────────────────

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // 防迴圈
    if (data.stop_hook_active) process.exit(0);

    const sessionId = data.session_id || 'unknown';
    const agentType = data.agent_type;
    const transcriptPath = data.agent_transcript_path;
    if (!agentType) process.exit(0);

    // 動態發現 pipeline
    const pipeline = discoverPipeline();
    const currentStage = pipeline.agentToStage[agentType];
    if (!currentStage) process.exit(0);

    // 讀取 state
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
    let state = { completed: [], expectedStages: [], pipelineId: null, stageIndex: 0 };
    if (fs.existsSync(statePath)) {
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
    }

    // 初始化欄位
    if (!state.stageResults) state.stageResults = {};
    if (!state.retries) state.retries = {};
    if (typeof state.stageIndex !== 'number') state.stageIndex = 0;
    if (!state.completed) state.completed = [];
    if (!state.skippedStages) state.skippedStages = [];

    // ──── Step 1: 解析 verdict + 記錄完成 ────
    const verdict = parseVerdict(transcriptPath);
    state.stageResults[currentStage] = verdict || { verdict: 'UNKNOWN' };
    if (!state.completed.includes(agentType)) state.completed.push(agentType);
    state.lastTransition = new Date().toISOString();

    // ──── Step 2: 回退決策 ────
    const retryCount = state.retries[currentStage] || 0;
    const { shouldRetry } = shouldRetryStage(currentStage, verdict, retryCount);

    // ──── Step 3: Pipeline 階段計算 ────
    const pipelineId = state.pipelineId || null;
    const pipelineStages = (pipelineId && PIPELINES[pipelineId])
      ? PIPELINES[pipelineId].stages
      : pipeline.stageOrder;

    // 更新 stageIndex（只允許單調遞增）
    const currentIndex = pipelineStages.indexOf(currentStage);
    if (currentIndex >= 0 && currentIndex >= (state.stageIndex || 0)) {
      state.stageIndex = currentIndex;
    }

    // 查找下一步
    const nextResult = findNextStageInPipeline(pipelineStages, pipeline.stageMap, currentStage, state.stageIndex);
    const completedStages = getCompletedStages(state.completed, pipeline.agentToStage);
    const completedStr = completedStages.join(' → ');
    const currentLabel = pipeline.stageLabels[currentStage] || currentStage;

    // auto-enforce + 偵測 design 需求
    autoEnforce(state, nextResult.stage, completedStages);
    detectDesignNeed(state, currentStage);

    // 環境判斷
    const envInfo = state.environment || {};
    const frameworkName = ((envInfo.framework && envInfo.framework.name) || '').toLowerCase();
    const isApiOnly = API_ONLY_FRAMEWORKS.includes(frameworkName);

    let message;

    // ──── 分支 A: 回退 ────
    if (shouldRetry) {
      const hasDev = pipelineStages.includes('DEV');
      const devInfo = pipeline.stageMap['DEV'];

      if (!hasDev || !devInfo) {
        message = mb.buildNoDevRetryMessage({ currentStage, verdict, completedStr });
        delete state.pendingRetry;
      } else {
        state.retries[currentStage] = retryCount + 1;
        state.pendingRetry = { stage: currentStage, severity: verdict.severity, round: retryCount + 1 };

        emit(EVENT_TYPES.STAGE_RETRY, sessionId, {
          stage: currentStage, agentType,
          verdict: verdict.verdict, severity: verdict.severity,
          retryCount: retryCount + 1, retryTarget: 'DEV',
        });

        message = mb.buildRetryMessage({
          currentStage, verdict, retryCount: retryCount + 1, maxRetries: MAX_RETRIES,
          devMethod: mb.buildDelegationMethod(devInfo), completedStr,
        });
      }

    // ──── 分支 B: 回退重驗 ────
    } else if (state.pendingRetry && currentStage === 'DEV') {
      const { stage: retryTarget, round: retryRound } = state.pendingRetry;
      delete state.pendingRetry;

      const retryInfo = pipeline.stageMap[retryTarget];
      message = mb.buildRetryVerifyMessage({
        retryTarget, retryRound,
        retryMethod: mb.buildDelegationMethod(retryInfo),
        retryLabel: pipeline.stageLabels[retryTarget] || retryTarget,
        completedStr,
      });

    // ──── 分支 C: 正常前進 ────
    } else {
      // 品質階段失敗但超過上限的警告
      let forcedNote = '';
      if (verdict && verdict.verdict === 'FAIL' && retryCount >= MAX_RETRIES) {
        forcedNote = `\n⚠️ 注意：${currentStage} 仍有 ${verdict.severity} 問題未修復（已達 ${MAX_RETRIES} 輪回退上限），強制繼續。`;
      }

      // 智慧跳過
      const resolved = resolveNextStage(
        nextResult.stage, nextResult.index,
        state, pipelineStages, pipeline.stageMap,
        findNextStageInPipeline
      );
      const skipNote = resolved.skipped.length > 0
        ? `\n⏭️ 已智慧跳過：${resolved.skipped.join('、')}`
        : '';

      if (resolved.stage) {
        state.stageIndex = resolved.index;

        emit(EVENT_TYPES.STAGE_COMPLETE, sessionId, {
          stage: currentStage, agentType,
          verdict: verdict?.verdict || 'UNKNOWN',
          nextStage: resolved.stage,
        });

        const nextInfo = pipeline.stageMap[resolved.stage];
        const stageContext = mb.buildStageContext(resolved.stage, currentStage, state, isApiOnly);

        message = mb.buildAdvanceMessage({
          agentType, nextStage: resolved.stage,
          nextLabel: pipeline.stageLabels[resolved.stage] || resolved.stage,
          method: mb.buildDelegationMethod(nextInfo),
          stageContext, skipNote, forcedNote, completedStr,
        });
      } else {
        // Pipeline 完成
        emit(EVENT_TYPES.PIPELINE_COMPLETE, sessionId, { finalStage: currentStage, completedStages });
        state.pipelineEnforced = false;

        message = mb.buildCompleteMessage({
          agentType, currentLabel, completedStr, forcedNote, skipNote,
        });
      }
    }

    // ──── 寫入 state + 輸出 ────
    state.delegationActive = false;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    if (!shouldRetry) autoCheckpoint(currentStage);

    console.log(JSON.stringify({ continue: true, systemMessage: message }));
  } catch (err) {
    hookLogger.error('stage-transition', err);
  }
});
