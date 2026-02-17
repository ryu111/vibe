#!/usr/bin/env node
/**
 * stage-transition.js — SubagentStop hook
 *
 * v2.0.0 FSM 重構：
 * - 使用 transition(STAGE_DONE) 取代散落的 flag 操作
 * - 移除 autoEnforce()（enforcement 由 phase 隱式表達）
 * - skip-rules/message-builder 通過 adapter 存取新 state 結構
 *
 * 模組依賴：
 * - flow/verdict.js — parseVerdict()
 * - flow/retry-policy.js — shouldRetryStage()
 * - flow/skip-rules.js — resolveNextStage()
 * - flow/message-builder.js — buildXxxMessage()
 * - flow/state-machine.js — transition(), 衍生查詢
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
  PIPELINES, API_ONLY_FRAMEWORKS, MAX_RETRIES,
} = require(path.join(__dirname, '..', 'lib', 'registry.js'));
const {
  transition, readState, writeState,
  getPhase, getPipelineId, getStageIndex,
  getCompletedAgents, getStageResults, getRetries,
  getPendingRetry, getSkippedStages, getEnvironment,
  isOpenSpecEnabled, PHASES,
} = require(path.join(__dirname, '..', 'lib', 'flow', 'state-machine.js'));

// ────────────────── 工具函式 ──────────────────

/** git checkpoint + patch 快照 */
function autoCheckpoint(stage) {
  try {
    execSync(`git tag -f "vibe-pipeline/${stage.toLowerCase()}"`, { stdio: 'pipe', timeout: 5000 });
    const patchPath = path.join(os.homedir(), '.claude', `vibe-patch-${stage.toLowerCase()}.patch`);
    execSync(`git diff HEAD > "${patchPath}"`, { stdio: 'pipe', timeout: 5000 });
  } catch (_) {}
}

/** 清理 patch 快照（Pipeline 完成時） */
function cleanupPatches() {
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const files = fs.readdirSync(claudeDir);
    for (const f of files) {
      if (f.startsWith('vibe-patch-') && f.endsWith('.patch')) {
        try { fs.unlinkSync(path.join(claudeDir, f)); } catch (_) {}
      }
    }
  } catch (_) {}
}

/** 從 completedAgents 推導已完成階段列表 */
function deriveCompletedStages(completedAgents, agentToStage) {
  const stages = [];
  for (const agent of (completedAgents || [])) {
    const stage = agentToStage[agent];
    if (stage && !stages.includes(stage)) stages.push(stage);
  }
  return stages;
}

/** ARCH 完成後偵測 design-system.md → 設定 needsDesign */
function detectDesignNeed(state, currentStage) {
  if (currentStage !== 'ARCH' || !isOpenSpecEnabled(state)) return false;
  try {
    const changesDir = path.join(process.cwd(), 'openspec', 'changes');
    if (!fs.existsSync(changesDir)) return false;
    const dirs = fs.readdirSync(changesDir)
      .filter(d => d !== 'archive' && fs.statSync(path.join(changesDir, d)).isDirectory());
    for (const dir of dirs) {
      if (fs.existsSync(path.join(changesDir, dir, 'design-system.md'))) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

/**
 * 建立 skip-rules 和 message-builder 的 flat adapter
 * 這些純函式模組使用 flat state 結構，adapter 提供相容介面
 */
function createFlatAdapter(state) {
  return {
    pipelineId: getPipelineId(state),
    environment: getEnvironment(state),
    needsDesign: state.context?.needsDesign || false,
    skippedStages: [...getSkippedStages(state)],
    openspecEnabled: isOpenSpecEnabled(state),
    frontend: getEnvironment(state)?.frontend,
  };
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
    let state = readState(sessionId);
    if (!state) {
      // 無 state 時建立最小結構（手動觸發 agent 的情況）
      const { createInitialState } = require(path.join(__dirname, '..', 'lib', 'flow', 'state-machine.js'));
      state = createInitialState(sessionId);
    }

    // ──── Step 1: 解析 verdict ────
    const verdict = parseVerdict(transcriptPath);

    // ──── Step 2: 回退決策 ────
    const retries = getRetries(state);
    const retryCount = retries[currentStage] || 0;
    const { shouldRetry } = shouldRetryStage(currentStage, verdict, retryCount);

    // ──── Step 3: Pipeline 階段計算 ────
    const pipelineId = getPipelineId(state);
    const pipelineStages = (pipelineId && PIPELINES[pipelineId])
      ? PIPELINES[pipelineId].stages
      : pipeline.stageOrder;

    // 計算 stageIndex（只允許單調遞增）
    const currentIndex = pipelineStages.indexOf(currentStage);
    const existingIndex = getStageIndex(state);
    const newStageIndex = (currentIndex >= 0 && currentIndex >= existingIndex) ? currentIndex : existingIndex;

    // 查找下一步
    const nextResult = findNextStageInPipeline(pipelineStages, pipeline.stageMap, currentStage, newStageIndex);
    const completedAgents = getCompletedAgents(state);
    const allCompletedAgents = completedAgents.includes(agentType) ? completedAgents : [...completedAgents, agentType];
    const completedStages = deriveCompletedStages(allCompletedAgents, pipeline.agentToStage);
    const completedStr = completedStages.join(' → ');
    const currentLabel = pipeline.stageLabels[currentStage] || currentStage;

    // 偵測 design 需求
    const needsDesign = detectDesignNeed(state, currentStage);
    if (needsDesign && state.context) {
      state = { ...state, context: { ...state.context, needsDesign: true } };
    }

    // 環境判斷
    const envInfo = getEnvironment(state);
    const frameworkName = ((envInfo.framework && envInfo.framework.name) || '').toLowerCase();
    const isApiOnly = API_ONLY_FRAMEWORKS.includes(frameworkName);

    let message;

    // ──── 分支 A: 回退 ────
    if (shouldRetry) {
      const hasDev = pipelineStages.includes('DEV');
      const devInfo = pipeline.stageMap['DEV'];

      if (!hasDev || !devInfo) {
        message = mb.buildNoDevRetryMessage({ currentStage, verdict, completedStr });

        state = transition(state, {
          type: 'STAGE_DONE',
          stage: currentStage,
          agentType,
          verdict: verdict || { verdict: 'UNKNOWN' },
          nextStage: nextResult.stage,
          shouldRetry: false,
          isComplete: !nextResult.stage,
          stageIndex: newStageIndex,
          pendingRetry: null,
        });
      } else {
        emit(EVENT_TYPES.STAGE_RETRY, sessionId, {
          stage: currentStage, agentType,
          verdict: verdict?.verdict, severity: verdict?.severity,
          retryCount: retryCount + 1, retryTarget: 'DEV',
        });

        state = transition(state, {
          type: 'STAGE_DONE',
          stage: currentStage,
          agentType,
          verdict: verdict || { verdict: 'UNKNOWN' },
          shouldRetry: true,
          retryCount: retryCount + 1,
          stageIndex: newStageIndex,
          pendingRetry: { stage: currentStage, severity: verdict?.severity, round: retryCount + 1 },
        });

        message = mb.buildRetryMessage({
          currentStage, verdict, retryCount: retryCount + 1, maxRetries: MAX_RETRIES,
          devMethod: mb.buildDelegationMethod(pipeline.stageMap['DEV']), completedStr,
        });
      }

    // ──── 分支 B: 回退重驗 ────
    } else if (getPendingRetry(state) && currentStage === 'DEV') {
      const pending = getPendingRetry(state);
      const retryTarget = pending.stage;
      const retryRound = pending.round;

      state = transition(state, {
        type: 'STAGE_DONE',
        stage: currentStage,
        agentType,
        verdict: verdict || { verdict: 'UNKNOWN' },
        shouldRetry: false,
        isComplete: false,
        nextStage: retryTarget,
        stageIndex: newStageIndex,
        pendingRetry: null, // 消費 pendingRetry
      });

      const retryInfo = pipeline.stageMap[retryTarget];
      message = mb.buildRetryVerifyMessage({
        retryTarget, retryRound,
        retryMethod: mb.buildDelegationMethod(retryInfo),
        retryLabel: pipeline.stageLabels[retryTarget] || retryTarget,
        completedStr,
      });

    // ──── 分支 C: 正常前進 ────
    } else {
      let forcedNote = '';
      if (verdict && verdict.verdict === 'FAIL' && retryCount >= MAX_RETRIES) {
        forcedNote = `\n⚠️ 注意：${currentStage} 仍有 ${verdict.severity} 問題未修復（已達 ${MAX_RETRIES} 輪回退上限），強制繼續。`;
      }

      // 智慧跳過（使用 flat adapter）
      const flatState = createFlatAdapter(state);
      const resolved = resolveNextStage(
        nextResult.stage, nextResult.index,
        flatState, pipelineStages, pipeline.stageMap,
        findNextStageInPipeline
      );
      const skipNote = resolved.skipped.length > 0
        ? `\n⏭️ 已智慧跳過：${resolved.skipped.join('、')}`
        : '';

      // 收集 skip-rules 的 skippedStages 變更
      const newSkipped = flatState.skippedStages.filter(
        s => !getSkippedStages(state).includes(s)
      );

      if (resolved.stage) {
        emit(EVENT_TYPES.STAGE_COMPLETE, sessionId, {
          stage: currentStage, agentType,
          verdict: verdict?.verdict || 'UNKNOWN',
          nextStage: resolved.stage,
        });

        state = transition(state, {
          type: 'STAGE_DONE',
          stage: currentStage,
          agentType,
          verdict: verdict || { verdict: 'UNKNOWN' },
          nextStage: resolved.stage,
          shouldRetry: false,
          isComplete: false,
          stageIndex: resolved.index,
          skippedStages: newSkipped,
        });

        const nextInfo = pipeline.stageMap[resolved.stage];
        // message-builder 也用 flat adapter
        const mbState = createFlatAdapter(state);
        const stageContext = mb.buildStageContext(resolved.stage, currentStage, mbState, isApiOnly);

        message = mb.buildAdvanceMessage({
          agentType, nextStage: resolved.stage,
          nextLabel: pipeline.stageLabels[resolved.stage] || resolved.stage,
          method: mb.buildDelegationMethod(nextInfo),
          stageContext, skipNote, forcedNote, completedStr,
        });
      } else {
        // Pipeline 完成
        emit(EVENT_TYPES.PIPELINE_COMPLETE, sessionId, { finalStage: currentStage, completedStages });
        cleanupPatches();

        state = transition(state, {
          type: 'STAGE_DONE',
          stage: currentStage,
          agentType,
          verdict: verdict || { verdict: 'UNKNOWN' },
          shouldRetry: false,
          isComplete: true,
          stageIndex: newStageIndex,
          skippedStages: newSkipped,
        });

        message = mb.buildCompleteMessage({
          agentType, currentLabel, completedStr, forcedNote, skipNote,
        });
      }
    }

    // ──── 寫入 state + 輸出 ────
    writeState(sessionId, state);

    if (!shouldRetry) autoCheckpoint(currentStage);

    console.log(JSON.stringify({ continue: true, systemMessage: message }));
  } catch (err) {
    hookLogger.error('stage-transition', err);
  }
});
