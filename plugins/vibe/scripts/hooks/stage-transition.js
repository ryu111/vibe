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
const { execSync } = require('child_process');

const { discoverPipeline, findNextStage } = require(path.join(__dirname, '..', 'lib', 'flow', 'pipeline-discovery.js'));
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
const { emit, EVENT_TYPES } = require(path.join(__dirname, '..', 'lib', 'timeline'));
const { FRONTEND_FRAMEWORKS } = require(path.join(__dirname, '..', 'lib', 'registry.js'));

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

// 階段完成後的附加提示（注入到下一階段指令中）
const POST_STAGE_HINTS = {
  ARCH: '🎨 設計提示：ARCH 完成。如果這是前端專案，接下來的 DESIGN 階段會產出設計系統和視覺化 mockup。',
  DESIGN: '🎨 設計提示：DESIGN 已產出 design-system.md 和 mockup.html。developer 請遵循設計系統的色彩(hex)、字體(Google Fonts)、間距(spacing tokens) 規範。',
  REVIEW: '🔒 安全提示：REVIEW 已完成程式碼品質審查。建議在 TEST 階段也關注安全相關測試（auth、input validation、injection）。如有 auth/crypto 相關變更，可在 pipeline 完成後執行 /vibe:security 深度掃描。',
  TEST: '📊 覆蓋率提示：TEST 已完成。進入 QA 前建議關注測試覆蓋率。pipeline 完成後可用 /vibe:coverage 取得詳細報告。',
};

/**
 * 自動建立 git checkpoint（pipeline 階段完成時的回溯錨點）
 * 使用 lightweight git tag，零 agent 介入
 */
function autoCheckpoint(stage, sessionId) {
  try {
    const tagName = `vibe-pipeline/${stage.toLowerCase()}`;
    // -f 確保重複執行不報錯（retry 場景同一 stage 會多次執行）
    execSync(`git tag -f "${tagName}"`, {
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch (_) {
    // 非 git repo 或 tag 失敗 → 靜默跳過
  }
}

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
    const DEV_OR_LATER = ['DESIGN', 'DEV', 'REVIEW', 'TEST', 'QA', 'E2E', 'DOCS'];
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

    // ARCH 完成後，偵測是否有設計產出（design-system.md）→ 設定 needsDesign
    if (currentStage === 'ARCH' && state.openspecEnabled) {
      try {
        const cwd = process.cwd();
        const changesDir = path.join(cwd, 'openspec', 'changes');
        if (fs.existsSync(changesDir)) {
          const activeDirs = fs.readdirSync(changesDir)
            .filter(d => d !== 'archive' && fs.statSync(path.join(changesDir, d)).isDirectory());
          for (const dir of activeDirs) {
            const designSystemPath = path.join(changesDir, dir, 'design-system.md');
            if (fs.existsSync(designSystemPath)) {
              state.needsDesign = true;
              break;
            }
          }
        }
      } catch (_) {}
    }

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

      message = `🔄 [Pipeline 回退] ${currentStage} FAIL:${verdict.severity}（${retryCount + 1}/${MAX_RETRIES}）
回退原因：${reason}
執行：${devMethod}
修復後 stage-transition 會指示重跑 ${currentStage}。禁止 AskUserQuestion。
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

      message = `🔄 [回退重驗] DEV 修復完成（第 ${retryRound} 輪）→ 重跑 ${retryTarget}（${retryLabel}）
執行：${retryMethod}
不可跳過，不可跳到其他階段。禁止 AskUserQuestion。
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
      if (!state.skippedStages) state.skippedStages = [];

      while (nextStageCandidate) {
        // 前端框架或明確標記 needsDesign → 不跳過 DESIGN
        // 否則跳過（純後端/CLI 專案不需視覺設計）
        if (nextStageCandidate === 'DESIGN') {
          const needsDesign = state.needsDesign === true;
          const isFrontend = FRONTEND_FRAMEWORKS.includes(frameworkName);
          if (!needsDesign && !isFrontend) {
            skippedStages.push('DESIGN（純後端/CLI 專案不需視覺設計）');
            if (!state.skippedStages.includes('DESIGN')) {
              state.skippedStages.push('DESIGN');
            }
            nextStageCandidate = findNextStage(pipeline.stageOrder, pipeline.stageMap, nextStageCandidate);
            continue;
          }
        }

        // 純 API 專案跳過 E2E（瀏覽器測試無意義）
        if (nextStageCandidate === 'E2E' && isApiOnly) {
          skippedStages.push('E2E（純 API 專案不需瀏覽器測試）');
          if (!state.skippedStages.includes('E2E')) {
            state.skippedStages.push('E2E');
          }
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

        // OpenSpec 上下文提示
        if (state.openspecEnabled) {
          if (nextStageCandidate === 'ARCH') {
            stageContext += '\n📋 OpenSpec：planner 已建立 proposal.md，architect 請讀取 openspec/changes/ 中的 proposal 後產出 design.md、specs/、tasks.md。';
          } else if (nextStageCandidate === 'DESIGN') {
            stageContext += '\n📋 OpenSpec：architect 已產出 design.md 和 proposal.md。designer 請讀取這兩份文件，產出 design-system.md（色彩/字體/間距規範）和 design-mockup.html（視覺化預覽）到 openspec/changes/ 中。';
          } else if (nextStageCandidate === 'DEV') {
            stageContext += '\n📋 OpenSpec：architect 已產出完整規格，developer 請依照 openspec/changes/ 中的 tasks.md checkbox 逐一實作並打勾。';
          } else if (nextStageCandidate === 'REVIEW') {
            stageContext += '\n📋 OpenSpec：請讀取 openspec/changes/ 中的 specs/ 和 design.md，對照審查實作是否符合規格。';
          } else if (nextStageCandidate === 'TEST') {
            stageContext += '\n📋 OpenSpec：請讀取 openspec/changes/ 中的 specs/，將每個 Scenario 的 WHEN/THEN 轉換為測試案例。';
          } else if (nextStageCandidate === 'DOCS') {
            stageContext += '\n📋 OpenSpec：所有實作已完成，doc-updater 請在更新文件後將 change 歸檔到 openspec/changes/archive/。';
          }
        }

        // 非 OpenSpec 模式下的設計系統 context 注入（DEV 階段）
        if (!state.openspecEnabled && nextStageCandidate === 'DEV') {
          try {
            const cwd = process.cwd();
            if (fs.existsSync(path.join(cwd, 'design-system', 'MASTER.md'))) {
              stageContext += '\n🎨 前端實作請參考 design-system/MASTER.md，確保色彩(hex)、字體(Google Fonts)、間距(spacing tokens) 與設計系統一致。';
            }
          } catch (_) {}
        }

        // 前一階段完成後的附加提示（安全、覆蓋率等）
        let postHint = POST_STAGE_HINTS[currentStage];
        // ARCH 階段完成時，若 DESIGN 被跳過，使用替代提示
        if (currentStage === 'ARCH' && state.skippedStages && state.skippedStages.includes('DESIGN')) {
          postHint = null; // 跳過 DESIGN 時不提示 DESIGN 階段
        }
        if (postHint) {
          stageContext += `\n${postHint}`;
        }

        // 跳過說明
        const skipNote = skippedStages.length > 0
          ? `\n⏭️ 已智慧跳過：${skippedStages.join('、')}`
          : '';

        message = `⛔ [Pipeline] ${agentType}✅ → ${nextStageCandidate}（${nextLabel}）${forcedNote}
${method}${stageContext}${skipNote}
禁止 AskUserQuestion。已完成：${completedStr}`;
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
        message = `✅ [Pipeline 完成] ${agentType} 已完成（${currentLabel}階段）。${forcedNote}${skipNote}
所有階段已完成：${completedStr}

📌 Pipeline 後續動作（依序執行）：
1️⃣ 執行 /vibe:verify 進行最終綜合驗證（Build → Types → Lint → Tests → Git 狀態）
2️⃣ 向使用者報告成果摘要
3️⃣ 使用 AskUserQuestion（multiSelect: true）提供後續選項，建議包含：
   - 提交並推送（commit + push）
   - 覆蓋率分析（/vibe:coverage）
   - 安全掃描（/vibe:security）
   - 知識進化（/vibe:evolve — 將此 session 產生的經驗進化為可重用組件）

⚠️ Pipeline 已解除自動模式，現在可以使用 AskUserQuestion。`;
      }
    }

    // 清除委派標記（sub-agent 已完成，重新啟動 pipeline-guard 保護）
    state.delegationActive = false;

    // 寫入 state file
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // 自動建立 git checkpoint（回退場景除外，因為回退後 tag 會被覆寫）
    if (!shouldRetry) {
      autoCheckpoint(currentStage, sessionId);
    }

    // 輸出
    console.log(JSON.stringify({
      continue: true,
      systemMessage: message,
    }));
  } catch (err) {
    hookLogger.error('stage-transition', err);
  }
});
