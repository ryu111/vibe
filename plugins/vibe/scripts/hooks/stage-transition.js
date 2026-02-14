#!/usr/bin/env node
/**
 * stage-transition.js — SubagentStop hook
 *
 * Agent 完成後判斷下一步：前進或回退。
 * 品質階段（REVIEW/TEST/QA/E2E）失敗時，智慧回退到 DEV，每個階段最多 3 輪。
 * 強度：強建議（systemMessage）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { discoverPipeline, findNextStage } = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-discovery.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));

// 智慧回退配置
const MAX_RETRIES = parseInt(process.env.CLAUDE_PIPELINE_MAX_RETRIES || '3', 10);
const QUALITY_STAGES = ['REVIEW', 'TEST', 'QA', 'E2E'];
const VERDICT_REGEX = /<!-- PIPELINE_VERDICT:\s*(PASS|FAIL(?::(?:CRITICAL|HIGH|MEDIUM|LOW))?)\s*-->/;

// 純 API 框架 — 不需要瀏覽器 E2E 測試
const API_ONLY_FRAMEWORKS = ['express', 'fastify', 'hono', 'koa', 'nest'];

// 各階段專屬 context
const STAGE_CONTEXT = {
  QA: '📋 QA 重點：API/CLI 行為正確性驗證。用 curl 發送真實請求，驗證回應格式、HTTP status code、error handling。不要寫測試碼。',
  E2E_UI: '🌐 E2E 重點：瀏覽器使用者流程。用 agent-browser 操作 UI，驗證完整的使用者旅程。不重複 QA 已驗證的 API 場景。',
  E2E_API: '🌐 E2E 重點：跨步驟資料一致性驗證。重點測試多使用者互動、狀態依賴鏈（如 email 更新後能否用新 email 登入）、錯誤恢復流程。不重複 QA 已做過的基本 API 場景。',
};

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

/**
 * 從 agent transcript 中解析 PIPELINE_VERDICT 標記
 * @param {string} transcriptPath - JSONL transcript 路徑
 * @returns {{ verdict: string, severity: string|null } | null}
 */
function parseVerdict(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');

    // 從後往前搜尋（verdict 通常在最後幾行）
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        // 搜尋 assistant message 中的 verdict
        const text = JSON.stringify(entry);
        const match = text.match(VERDICT_REGEX);
        if (match) {
          const [, full] = match;
          if (full === 'PASS') return { verdict: 'PASS', severity: null };
          const parts = full.split(':');
          return { verdict: 'FAIL', severity: parts[1] || 'HIGH' };
        }
      } catch (_) { /* 跳過非 JSON 行 */ }
    }
  } catch (_) {}

  return null;
}

/**
 * 判斷是否需要回退
 * @returns {{ shouldRetry: boolean, reason: string }}
 */
function shouldRetryStage(currentStage, verdict, retryCount) {
  // 非品質階段 → 不回退
  if (!QUALITY_STAGES.includes(currentStage)) {
    return { shouldRetry: false, reason: '' };
  }

  // 沒有 verdict → 無法判斷，繼續前進
  if (!verdict) {
    return { shouldRetry: false, reason: '無法解析 agent 結論' };
  }

  // PASS → 不回退
  if (verdict.verdict === 'PASS') {
    return { shouldRetry: false, reason: '' };
  }

  // FAIL:MEDIUM/LOW → 不回退（只是建議）
  if (verdict.severity === 'MEDIUM' || verdict.severity === 'LOW') {
    return { shouldRetry: false, reason: `${verdict.severity} 等級問題不需回退` };
  }

  // FAIL:CRITICAL/HIGH → 回退（除非超過上限）
  if (retryCount >= MAX_RETRIES) {
    return { shouldRetry: false, reason: `已達回退上限（${MAX_RETRIES} 輪）` };
  }

  return { shouldRetry: true, reason: `${verdict.severity} 等級問題需要修復` };
}

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // 防迴圈：必須第一步檢查
    if (data.stop_hook_active) {
      process.exit(0);
    }

    const sessionId = data.session_id || 'unknown';
    const agentType = data.agent_type;
    const transcriptPath = data.agent_transcript_path;

    if (!agentType) {
      process.exit(0);
    }

    // 動態發現 pipeline
    const pipeline = discoverPipeline();
    const currentStage = pipeline.agentToStage[agentType];

    // 不認識的 agent → 不處理
    if (!currentStage) {
      process.exit(0);
    }

    // 讀取 state file
    const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
    let state = { completed: [], expectedStages: [] };
    if (fs.existsSync(statePath)) {
      try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      } catch (_) {}
    }

    // 初始化 stageResults 和 retries
    if (!state.stageResults) state.stageResults = {};
    if (!state.retries) state.retries = {};

    // 解析 agent 結論
    const verdict = parseVerdict(transcriptPath);
    state.stageResults[currentStage] = verdict || { verdict: 'UNKNOWN' };

    // 記錄完成的 agent
    if (!state.completed) state.completed = [];
    if (!state.completed.includes(agentType)) {
      state.completed.push(agentType);
    }
    state.lastTransition = new Date().toISOString();

    // 判斷回退
    const retryCount = state.retries[currentStage] || 0;
    const { shouldRetry, reason } = shouldRetryStage(currentStage, verdict, retryCount);

    // 查找下一步
    const nextStage = findNextStage(pipeline.stageOrder, pipeline.stageMap, currentStage);
    const currentLabel = pipeline.stageLabels[currentStage] || currentStage;

    // 已完成階段列表
    const completedStages = [];
    for (const agent of state.completed) {
      const stage = pipeline.agentToStage[agent];
      if (stage && !completedStages.includes(stage)) {
        completedStages.push(stage);
      }
    }
    const completedStr = completedStages.join(' → ');

    // ===== 自動 enforce pipeline =====
    // 當手動觸發 scope/architect 後，task-classifier 可能沒分類為 feature，
    // 導致 pipelineEnforced=false。若已完成 PLAN+ARCH 且下一步是 DEV，
    // 自動升級為 feature pipeline，確保 pipeline-guard 阻擋 Main Agent 直接寫碼。
    const DEV_OR_LATER = ['DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'];
    if (!state.pipelineEnforced && nextStage && DEV_OR_LATER.includes(nextStage)) {
      state.pipelineEnforced = true;
      if (!state.taskType || state.taskType === 'quickfix' || state.taskType === 'research') {
        state.taskType = 'feature';
      }
      if (!state.expectedStages || !state.expectedStages.includes('REVIEW')) {
        state.expectedStages = pipeline.stageOrder;
      }
    }

    // 讀取環境資訊（用於智慧跳過判斷）
    const envInfo = state.environment || {};
    const frameworkName = (envInfo.framework && envInfo.framework.name) || '';
    const isApiOnly = API_ONLY_FRAMEWORKS.includes(frameworkName);

    let message;

    if (shouldRetry) {
      // ===== 智慧回退：回到 DEV 修復 =====
      state.retries[currentStage] = retryCount + 1;

      // 記錄待重驗階段（DEV 完成後會讀取此標記，強制重跑品質檢查）
      state.pendingRetry = { stage: currentStage, severity: verdict.severity, round: retryCount + 1 };

      // Emit stage retry event
      emit(EVENT_TYPES.STAGE_RETRY, sessionId, {
        stage: currentStage,
        agentType,
        verdict: verdict.verdict,
        severity: verdict.severity,
        retryCount: retryCount + 1,
      });

      const devInfo = pipeline.stageMap['DEV'];
      const devPlugin = devInfo && devInfo.plugin ? `${devInfo.plugin}:` : '';
      const devAgent = devInfo ? devInfo.agent : 'developer';
      const devMethod = devInfo && devInfo.skill
        ? `使用 Skill 工具呼叫 ${devInfo.skill}`
        : `使用 Task 工具委派給 ${devPlugin}${devAgent} agent（subagent_type: "${devPlugin}${devAgent}"）`;

      // 回退後重新執行的 stage 資訊
      const retryInfo = pipeline.stageMap[currentStage];
      const retrySkill = retryInfo && retryInfo.skill ? retryInfo.skill : null;
      const retryAgent = retryInfo && retryInfo.agent ? retryInfo.agent : null;
      const retryPlugin = retryInfo && retryInfo.plugin ? `${retryInfo.plugin}:` : '';
      const retryMethod = retrySkill
        ? `使用 Skill 工具呼叫 ${retrySkill}`
        : `使用 Task 工具委派給 ${retryPlugin}${retryAgent} agent（subagent_type: "${retryPlugin}${retryAgent}"）`;

      message = `🔄 [Pipeline 回退] ${agentType} 完成（${currentLabel}階段），但發現 ${verdict.severity} 等級問題。
回退原因：${reason}
回退次數：${retryCount + 1}/${MAX_RETRIES}

你**必須**執行以下步驟：
1️⃣ 先回到 DEV 階段修復 ${verdict.severity} 等級問題 → ${devMethod}
2️⃣ 修復完成後重新執行 ${currentStage}（${currentLabel}）→ ${retryMethod}

⛔ Pipeline 自動模式：不要使用 AskUserQuestion，修復後直接重新執行品質檢查。
已完成：${completedStr}`;

    } else if (state.pendingRetry && currentStage === 'DEV') {
      // ===== 回退修復完成 → 強制重跑品質檢查 =====
      const retryTarget = state.pendingRetry.stage;
      const retrySeverity = state.pendingRetry.severity;
      const retryRound = state.pendingRetry.round;
      delete state.pendingRetry; // 消費標記

      const retryInfo = pipeline.stageMap[retryTarget];
      const retryLabel = pipeline.stageLabels[retryTarget] || retryTarget;
      const retryPlugin = retryInfo && retryInfo.plugin ? `${retryInfo.plugin}:` : '';
      const retryMethod = retryInfo && retryInfo.skill
        ? `使用 Skill 工具呼叫 ${retryInfo.skill}`
        : `使用 Task 工具委派給 ${retryPlugin}${retryInfo.agent} agent（subagent_type: "${retryPlugin}${retryInfo.agent}"）`;

      message = `🔄 [回退重驗] DEV 已完成 ${retrySeverity} 問題修復（第 ${retryRound} 輪）。
⚠️ 你**必須立即**重新執行 ${retryTarget}（${retryLabel}）驗證修復結果。
➡️ 執行方法：${retryMethod}

⛔ 這是回退流程的必要步驟 — 不可跳過，不可跳到其他階段。
⛔ Pipeline 自動模式：不要使用 AskUserQuestion。
已完成：${completedStr}`;

    } else {
      // ===== 正常前進 =====

      // 如果是品質階段失敗但超過上限，加警告
      let forcedNote = '';
      if (verdict && verdict.verdict === 'FAIL' && retryCount >= MAX_RETRIES) {
        forcedNote = `\n⚠️ 注意：${currentStage} 仍有 ${verdict.severity} 問題未修復（已達 ${MAX_RETRIES} 輪回退上限），強制繼續。`;
      }

      // 智慧跳過：找下一個適用的 stage
      let nextStageCandidate = nextStage;
      const skippedStages = [];
      while (nextStageCandidate) {
        // 純 API 專案跳過 E2E（瀏覽器測試無意義）
        if (nextStageCandidate === 'E2E' && isApiOnly) {
          skippedStages.push(`E2E（純 API 專案不需瀏覽器測試）`);
          nextStageCandidate = findNextStage(pipeline.stageOrder, pipeline.stageMap, nextStageCandidate);
          continue;
        }
        break;
      }

      if (nextStageCandidate) {
        // Emit stage complete event (with nextStage)
        emit(EVENT_TYPES.STAGE_COMPLETE, sessionId, {
          stage: currentStage,
          agentType,
          verdict: verdict?.verdict || 'UNKNOWN',
          nextStage: nextStageCandidate,
        });

        const nextLabel = pipeline.stageLabels[nextStageCandidate] || nextStageCandidate;
        const nextInfo = pipeline.stageMap[nextStageCandidate];
        const skillCmd = nextInfo && nextInfo.skill ? nextInfo.skill : null;
        const agentName = nextInfo && nextInfo.agent ? nextInfo.agent : null;

        const nextPlugin = nextInfo && nextInfo.plugin ? `${nextInfo.plugin}:` : '';
        const method = skillCmd
          ? `➡️ 執行方法：使用 Skill 工具呼叫 ${skillCmd}`
          : `➡️ 執行方法：使用 Task 工具委派給 ${nextPlugin}${agentName} agent（subagent_type: "${nextPlugin}${agentName}"）`;

        // 階段專屬 context
        let stageContext = '';
        if (nextStageCandidate === 'QA') {
          stageContext = `\n${STAGE_CONTEXT.QA}`;
        } else if (nextStageCandidate === 'E2E') {
          stageContext = isApiOnly ? `\n${STAGE_CONTEXT.E2E_API}` : `\n${STAGE_CONTEXT.E2E_UI}`;
        }

        // 跳過說明
        const skipNote = skippedStages.length > 0
          ? `\n⏭️ 已智慧跳過：${skippedStages.join('、')}`
          : '';

        message = `⛔ [Pipeline 指令] ${agentType} 已完成（${currentLabel}階段）。${forcedNote}
你**必須立即**執行下一階段：${nextStageCandidate}（${nextLabel}）。
${method}${stageContext}${skipNote}
這是 Pipeline 流程的必要步驟，不可跳過。
⛔ Pipeline 自動模式：不要使用 AskUserQuestion，完成後直接進入下一階段。
已完成：${completedStr}`;
      } else {
        // Emit pipeline complete event
        emit(EVENT_TYPES.PIPELINE_COMPLETE, sessionId, {
          finalStage: currentStage,
          completedStages,
        });

        // 解除 pipeline 鎖定 — 讓 pipeline-guard 放行
        state.pipelineEnforced = false;

        const skipNote = skippedStages.length > 0
          ? `\n⏭️ 已智慧跳過：${skippedStages.join('、')}`
          : '';
        message = `✅ [Pipeline 完成] ${agentType} 已完成（${currentLabel}階段）。${forcedNote}${skipNote}\n所有階段已完成：${completedStr}\n向使用者報告成果。`;
      }
    }

    // 清除委派標記（sub-agent 已完成，重新啟動 pipeline-guard 保護）
    state.delegationActive = false;

    // 寫入 state file
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // 輸出
    console.log(JSON.stringify({
      continue: true,
      systemMessage: message,
    }));
  } catch (err) {
    hookLogger.error('stage-transition', err);
  }
});
