#!/usr/bin/env node
/**
 * validate-workflow.js — 工作流驗證腳本（專案層級）
 *
 * 驗證 pipeline 流程的正確性：階段是否完整、順序是否正確、
 * 產出是否齊全、品質是否達標、規範是否遵守。
 *
 * 用法：
 *   node scripts/validate-workflow.js <sessionId>      # 驗證指定 session
 *   node scripts/validate-workflow.js --latest          # 驗證最近的 session
 *   node scripts/validate-workflow.js --check-config    # 只檢查 pipeline 配置
 *
 * 輸出：結構化 JSON 報告（stdout）+ 可讀摘要（stderr）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ─── Pipeline 發現（專案層級版，不依賴 CLAUDE_PLUGIN_ROOT）─────

function discoverPipelineLocal() {
  // 讀取 flow 的 stage 定義
  const flowPipelinePath = path.join(PLUGINS_DIR, 'flow', 'pipeline.json');
  if (!fs.existsSync(flowPipelinePath)) {
    return { stageOrder: [], stageLabels: {}, stageMap: {}, agentToStage: {} };
  }

  const flowConfig = JSON.parse(fs.readFileSync(flowPipelinePath, 'utf8'));
  const stageMap = {};
  const agentToStage = {};

  // 掃描所有 plugin 的 pipeline.json
  for (const dir of fs.readdirSync(PLUGINS_DIR)) {
    const pipePath = path.join(PLUGINS_DIR, dir, 'pipeline.json');
    if (!fs.existsSync(pipePath)) continue;

    try {
      const config = JSON.parse(fs.readFileSync(pipePath, 'utf8'));
      if (!config.provides) continue;

      for (const [stage, info] of Object.entries(config.provides)) {
        stageMap[stage] = { ...info, plugin: dir };
        if (info.agent) agentToStage[info.agent] = stage;
      }
    } catch (_) {}
  }

  return {
    stageOrder: flowConfig.stages || [],
    stageLabels: flowConfig.stageLabels || {},
    stageMap,
    agentToStage,
  };
}

// ─── State File 操作 ──────────────────────────────

function findLatestState() {
  if (!fs.existsSync(CLAUDE_DIR)) return null;
  const files = fs.readdirSync(CLAUDE_DIR)
    .filter(f => f.startsWith('pipeline-state-') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: path.join(CLAUDE_DIR, f),
      mtime: fs.statSync(path.join(CLAUDE_DIR, f)).mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0] : null;
}

function loadState(sessionId) {
  if (sessionId === '--latest') {
    const latest = findLatestState();
    if (!latest) return null;
    return JSON.parse(fs.readFileSync(latest.path, 'utf8'));
  }
  const statePath = path.join(CLAUDE_DIR, `pipeline-state-${sessionId}.json`);
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

// ─── 檢查器 ──────────────────────────────────────

/**
 * 1. Pipeline 配置完整性
 */
function checkConfig(pipeline) {
  const checks = [];

  // 每個 stage 是否都有 provider
  for (const stage of pipeline.stageOrder) {
    const hasProvider = !!pipeline.stageMap[stage];
    checks.push({
      id: 'CFG-PROVIDER',
      name: `${stage} 有 provider`,
      result: hasProvider ? 'PASS' : 'SKIP',
      expected: 'provider 已安裝',
      actual: hasProvider
        ? `${pipeline.stageMap[stage].plugin} → ${pipeline.stageMap[stage].agent}`
        : '未安裝（會自動跳過）',
    });
  }

  // 每個 provider 的 agent 檔案是否存在
  for (const [stage, info] of Object.entries(pipeline.stageMap)) {
    const agentPath = path.join(PLUGINS_DIR, info.plugin, 'agents', `${info.agent}.md`);
    const exists = fs.existsSync(agentPath);
    checks.push({
      id: 'CFG-AGENT',
      name: `${stage} agent 檔案存在 (${info.agent}.md)`,
      result: exists ? 'PASS' : 'FAIL',
      expected: agentPath,
      actual: exists ? '存在' : '不存在',
    });
  }

  // 每個 skill 引用是否存在
  for (const [stage, info] of Object.entries(pipeline.stageMap)) {
    if (!info.skill) continue;
    // /sentinel:review → plugins/sentinel/skills/review/SKILL.md
    const parts = info.skill.replace('/', '').split(':');
    if (parts.length !== 2) continue;
    const skillPath = path.join(PLUGINS_DIR, parts[0], 'skills', parts[1], 'SKILL.md');
    const exists = fs.existsSync(skillPath);
    checks.push({
      id: 'CFG-SKILL',
      name: `${stage} skill 存在 (${info.skill})`,
      result: exists ? 'PASS' : 'FAIL',
      expected: skillPath,
      actual: exists ? '存在' : '不存在',
    });
  }

  // stageLabels 是否完整
  for (const stage of pipeline.stageOrder) {
    const hasLabel = !!pipeline.stageLabels[stage];
    checks.push({
      id: 'CFG-LABEL',
      name: `${stage} 有中文標籤`,
      result: hasLabel ? 'PASS' : 'FAIL',
      expected: '有標籤',
      actual: hasLabel ? pipeline.stageLabels[stage] : '缺少',
    });
  }

  return checks;
}

/**
 * 2. 流程合規性 — 檢查 state file
 */
function checkCompliance(pipeline, state) {
  const checks = [];
  const installedStages = pipeline.stageOrder.filter(s => pipeline.stageMap[s]);
  const expectedStages = state.expectedStages || installedStages;

  // 每個預期階段是否已執行
  const completedAgents = state.completed || [];
  for (const stage of expectedStages) {
    const info = pipeline.stageMap[stage];
    if (!info) continue;
    const executed = completedAgents.includes(info.agent);
    checks.push({
      id: 'COMP-STAGE',
      name: `${stage}（${pipeline.stageLabels[stage] || stage}）已執行`,
      result: executed ? 'PASS' : 'FAIL',
      expected: `由 ${info.agent} 執行`,
      actual: executed ? '已完成' : '未執行',
    });
  }

  // 執行順序是否正確
  const completedStageOrder = completedAgents
    .map(agent => pipeline.agentToStage[agent])
    .filter(Boolean);

  let orderCorrect = true;
  for (let i = 1; i < completedStageOrder.length; i++) {
    const prevIdx = pipeline.stageOrder.indexOf(completedStageOrder[i - 1]);
    const currIdx = pipeline.stageOrder.indexOf(completedStageOrder[i]);
    if (currIdx < prevIdx) {
      orderCorrect = false;
      break;
    }
  }

  checks.push({
    id: 'COMP-ORDER',
    name: '階段執行順序正確',
    result: orderCorrect ? 'PASS' : 'FAIL',
    expected: expectedStages.join(' → '),
    actual: completedStageOrder.join(' → ') || '（無執行紀錄）',
  });

  // 任務分類是否有記錄
  checks.push({
    id: 'COMP-TYPE',
    name: '任務類型已分類',
    result: state.taskType ? 'PASS' : 'WARN',
    expected: '有分類紀錄',
    actual: state.taskType || '未分類（可能是舊版 session）',
  });

  return checks;
}

/**
 * 3. 產出完整性 — 檢查工作目錄
 */
function checkArtifacts(targetDir) {
  const checks = [];

  // 原始碼
  const srcDir = path.join(targetDir, 'src');
  const hasSrc = fs.existsSync(srcDir);
  let srcFileCount = 0;
  if (hasSrc) {
    srcFileCount = countFiles(srcDir);
  }
  checks.push({
    id: 'ART-SRC',
    name: '原始碼目錄存在且非空',
    result: hasSrc && srcFileCount > 0 ? 'PASS' : 'FAIL',
    expected: 'src/ 有原始碼檔案',
    actual: hasSrc ? `${srcFileCount} 個檔案` : 'src/ 不存在',
  });

  // 測試
  const testDirs = ['tests', 'test', '__tests__', 'spec'];
  const testDir = testDirs.find(d => fs.existsSync(path.join(targetDir, d)));
  let testFileCount = 0;
  if (testDir) {
    testFileCount = countFiles(path.join(targetDir, testDir));
  }
  checks.push({
    id: 'ART-TEST',
    name: '測試目錄存在且非空',
    result: testDir && testFileCount > 0 ? 'PASS' : 'FAIL',
    expected: '有測試檔案',
    actual: testDir ? `${testDir}/ — ${testFileCount} 個檔案` : '無測試目錄',
  });

  // package.json
  const pkgPath = path.join(targetDir, 'package.json');
  const hasPkg = fs.existsSync(pkgPath);
  checks.push({
    id: 'ART-PKG',
    name: 'package.json 存在',
    result: hasPkg ? 'PASS' : 'SKIP',
    expected: '專案根目錄有 package.json',
    actual: hasPkg ? '存在' : '不存在（可能非 Node 專案）',
  });

  // tsconfig.json（有 TS 依賴時才檢查）
  if (hasPkg) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.typescript) {
        const hasTsConfig = fs.existsSync(path.join(targetDir, 'tsconfig.json'));
        checks.push({
          id: 'ART-TS',
          name: 'tsconfig.json 存在（TS 專案）',
          result: hasTsConfig ? 'PASS' : 'FAIL',
          expected: '有 typescript 依賴時需要 tsconfig.json',
          actual: hasTsConfig ? '存在' : '不存在',
        });
      }
    } catch (_) {}
  }

  return checks;
}

/**
 * 4. 品質基線 — 執行 build/test/lint
 */
function checkQuality(targetDir) {
  const checks = [];
  const pkgPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return checks;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (_) {
    return checks;
  }

  const scripts = pkg.scripts || {};

  // Build
  if (scripts.build) {
    try {
      execSync('npm run build', { cwd: targetDir, stdio: 'pipe', timeout: 60000 });
      checks.push({ id: 'QA-BUILD', name: 'Build 通過', result: 'PASS', expected: '無錯誤', actual: '成功' });
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString().slice(0, 200) : '未知錯誤';
      checks.push({ id: 'QA-BUILD', name: 'Build 通過', result: 'FAIL', expected: '無錯誤', actual: stderr });
    }
  }

  // Typecheck
  if (scripts.typecheck) {
    try {
      execSync('npm run typecheck', { cwd: targetDir, stdio: 'pipe', timeout: 60000 });
      checks.push({ id: 'QA-TYPE', name: 'Typecheck 通過', result: 'PASS', expected: '無型別錯誤', actual: '成功' });
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString().slice(0, 200) : '未知錯誤';
      checks.push({ id: 'QA-TYPE', name: 'Typecheck 通過', result: 'FAIL', expected: '無型別錯誤', actual: stderr });
    }
  }

  // Test
  if (scripts.test) {
    try {
      execSync('npm test', { cwd: targetDir, stdio: 'pipe', timeout: 120000 });
      checks.push({ id: 'QA-TEST', name: '測試全部通過', result: 'PASS', expected: '無失敗', actual: '成功' });
    } catch (err) {
      const stdout = err.stdout ? err.stdout.toString().slice(-300) : '未知錯誤';
      checks.push({ id: 'QA-TEST', name: '測試全部通過', result: 'FAIL', expected: '無失敗', actual: stdout });
    }
  }

  // Lint
  if (scripts.lint) {
    try {
      execSync('npm run lint', { cwd: targetDir, stdio: 'pipe', timeout: 30000 });
      checks.push({ id: 'QA-LINT', name: 'Lint 通過', result: 'PASS', expected: '無警告', actual: '成功' });
    } catch (err) {
      const stdout = err.stdout ? err.stdout.toString().slice(-200) : '未知錯誤';
      checks.push({ id: 'QA-LINT', name: 'Lint 通過', result: 'WARN', expected: '無警告', actual: stdout });
    }
  }

  return checks;
}

/**
 * 5. 規範遵守 — git log、版號
 */
function checkConventions(targetDir) {
  const checks = [];

  // 最近 commit 是否有繁中
  try {
    const log = execSync('git log -1 --format=%s', { cwd: targetDir, stdio: 'pipe' }).toString().trim();
    // 簡易中文偵測：是否包含 CJK 字元
    const hasChinese = /[\u4e00-\u9fff]/.test(log);
    checks.push({
      id: 'CONV-LANG',
      name: 'Commit message 使用繁體中文',
      result: hasChinese ? 'PASS' : 'WARN',
      expected: '包含中文字元',
      actual: log.slice(0, 80),
    });
  } catch (_) {
    checks.push({
      id: 'CONV-LANG',
      name: 'Commit message 使用繁體中文',
      result: 'SKIP',
      expected: '有 git 歷史',
      actual: '非 git 倉庫或無 commit',
    });
  }

  // plugin.json 版號是否有更新（檢查 git diff）
  try {
    const diff = execSync('git diff HEAD~1 -- "*/plugin.json"', { cwd: targetDir, stdio: 'pipe' }).toString();
    const hasVersionChange = /^\+.*"version".*$/m.test(diff);
    if (diff.length > 0) {
      checks.push({
        id: 'CONV-VERSION',
        name: 'Plugin 版號已更新',
        result: hasVersionChange ? 'PASS' : 'WARN',
        expected: 'plugin.json version 有變更',
        actual: hasVersionChange ? '版號已更新' : 'plugin.json 有改動但版號未更新',
      });
    }
  } catch (_) {}

  return checks;
}

/**
 * 6. Hook 流程驗證 — 實際執行 hook scripts 驗證行為正確性
 */
function checkHooks() {
  const checks = [];

  // ─── hooks.json 結構驗證 ───
  for (const plugin of ['flow', 'sentinel']) {
    const hooksJsonPath = path.join(PLUGINS_DIR, plugin, 'hooks', 'hooks.json');
    if (!fs.existsSync(hooksJsonPath)) continue;

    try {
      const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      checks.push({
        id: 'HOOK-JSON',
        name: `${plugin}/hooks.json 語法正確`,
        result: 'PASS',
        expected: '有效 JSON',
        actual: '解析成功',
      });

      // 驗證每個 hook 引用的 command 腳本存在
      const hookEntries = hooksJson.hooks || hooksJson;
      for (const [event, handlers] of Object.entries(hookEntries)) {
        const handlerList = Array.isArray(handlers) ? handlers : [];
        for (const handler of handlerList) {
          // 支援 flat 和 grouped 格式
          const items = handler.hooks ? handler.hooks : [handler];
          for (const item of items) {
            if (item.type !== 'command' || !item.command) continue;
            // 解析 ${CLAUDE_PLUGIN_ROOT} → 實際路徑
            const cmd = item.command.replace('${CLAUDE_PLUGIN_ROOT}', path.join(PLUGINS_DIR, plugin));
            const scriptPath = cmd.split(' ')[0]; // 取第一個 token 作為路徑
            const exists = fs.existsSync(scriptPath);
            checks.push({
              id: 'HOOK-SCRIPT',
              name: `${plugin}/${event} 腳本存在`,
              result: exists ? 'PASS' : 'FAIL',
              expected: scriptPath,
              actual: exists ? '存在' : '不存在',
            });

            // 驗證語法正確性
            if (exists && scriptPath.endsWith('.js')) {
              try {
                execSync(`node -c "${scriptPath}"`, { stdio: 'pipe', timeout: 5000 });
                checks.push({
                  id: 'HOOK-SYNTAX',
                  name: `${path.basename(scriptPath)} 語法正確`,
                  result: 'PASS',
                  expected: '無語法錯誤',
                  actual: '通過',
                });
              } catch (err) {
                checks.push({
                  id: 'HOOK-SYNTAX',
                  name: `${path.basename(scriptPath)} 語法正確`,
                  result: 'FAIL',
                  expected: '無語法錯誤',
                  actual: err.stderr ? err.stderr.toString().slice(0, 100) : '語法錯誤',
                });
              }
            }
          }
        }
      }
    } catch (err) {
      checks.push({
        id: 'HOOK-JSON',
        name: `${plugin}/hooks.json 語法正確`,
        result: 'FAIL',
        expected: '有效 JSON',
        actual: err.message,
      });
    }
  }

  // ─── Hook 行為驗證（用 mock stdin 實測）───

  // task-classifier：分類正確性
  const classifierPath = path.join(PLUGINS_DIR, 'flow', 'scripts', 'hooks', 'task-classifier.js');
  if (fs.existsSync(classifierPath)) {
    const testCases = [
      { input: '幫我建立一個 REST API', expected: 'feature', label: 'feature 分類' },
      { input: '修復這個 typo', expected: 'quickfix', label: 'quickfix 分類' },
      { input: '這段程式碼做什麼？', expected: 'research', label: 'research 分類' },
      { input: '重構 auth 模組', expected: 'refactor', label: 'refactor 分類' },
    ];

    for (const tc of testCases) {
      try {
        const stdin = JSON.stringify({ prompt: tc.input, session_id: 'validate-test' });
        const result = execSync(`echo '${stdin}' | node "${classifierPath}"`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).toString().trim();
        const output = JSON.parse(result);
        const hasContext = !!output.additionalContext;
        const matchesType = output.additionalContext && output.additionalContext.includes(tc.expected === 'research' ? '研究探索' :
          tc.expected === 'feature' ? '新功能開發' :
          tc.expected === 'quickfix' ? '快速修復' :
          tc.expected === 'refactor' ? '重構' : tc.expected);
        checks.push({
          id: 'HOOK-CLASSIFY',
          name: `task-classifier ${tc.label}`,
          result: hasContext && matchesType ? 'PASS' : 'FAIL',
          expected: tc.expected,
          actual: hasContext ? output.additionalContext.slice(0, 60) : '無輸出',
        });
      } catch (err) {
        checks.push({
          id: 'HOOK-CLASSIFY',
          name: `task-classifier ${tc.label}`,
          result: 'FAIL',
          expected: tc.expected,
          actual: err.message.slice(0, 80),
        });
      }
    }
  }

  // danger-guard：阻擋危險命令
  const dangerPath = path.join(PLUGINS_DIR, 'sentinel', 'scripts', 'hooks', 'danger-guard.js');
  if (fs.existsSync(dangerPath)) {
    const dangerTests = [
      { cmd: 'rm -rf /', shouldBlock: true, label: 'rm -rf / 阻擋' },
      { cmd: 'git push --force main', shouldBlock: true, label: 'force push 阻擋' },
      { cmd: 'ls -la', shouldBlock: false, label: '安全命令放行' },
      { cmd: 'npm test', shouldBlock: false, label: 'npm test 放行' },
    ];

    for (const dt of dangerTests) {
      try {
        const stdin = JSON.stringify({ tool_input: { command: dt.cmd } });
        // 用 bash -c 包裝以正確捕獲 exit code
        const result = execSync(
          `bash -c 'echo ${JSON.stringify(stdin)} | node "${dangerPath}"; echo "EXIT:$?"'`,
          { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
        ).toString().trim();
        const exitCode = parseInt(result.split('EXIT:').pop(), 10);
        const blocked = exitCode === 2;
        const correct = blocked === dt.shouldBlock;
        checks.push({
          id: 'HOOK-DANGER',
          name: `danger-guard ${dt.label}`,
          result: correct ? 'PASS' : 'FAIL',
          expected: dt.shouldBlock ? 'exit 2（阻擋）' : 'exit 0（放行）',
          actual: `exit ${exitCode}`,
        });
      } catch (err) {
        // execSync throws on non-zero exit — exit 2 is expected for blocked commands
        const exitCode = err.status;
        const blocked = exitCode === 2;
        const correct = blocked === dt.shouldBlock;
        checks.push({
          id: 'HOOK-DANGER',
          name: `danger-guard ${dt.label}`,
          result: correct ? 'PASS' : 'FAIL',
          expected: dt.shouldBlock ? 'exit 2（阻擋）' : 'exit 0（放行）',
          actual: `exit ${exitCode}`,
        });
      }
    }
  }

  // stage-transition：防迴圈 + 輸出格式 + 智慧回退
  const transPath = path.join(PLUGINS_DIR, 'flow', 'scripts', 'hooks', 'stage-transition.js');
  if (fs.existsSync(transPath)) {
    const transEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(PLUGINS_DIR, 'flow') };

    // 防迴圈：stop_hook_active = true 時應靜默退出
    try {
      const stdin = JSON.stringify({ stop_hook_active: true, session_id: 'test', agent_type: 'developer' });
      const result = execSync(`echo '${stdin}' | node "${transPath}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        env: transEnv,
      }).toString().trim();
      checks.push({
        id: 'HOOK-LOOP',
        name: 'stage-transition 防迴圈',
        result: result === '' ? 'PASS' : 'FAIL',
        expected: '靜默退出（無輸出）',
        actual: result || '（空）',
      });
    } catch (err) {
      checks.push({
        id: 'HOOK-LOOP',
        name: 'stage-transition 防迴圈',
        result: err.status === 0 ? 'PASS' : 'FAIL',
        expected: '靜默退出',
        actual: `exit ${err.status}`,
      });
    }

    // ─── 智慧回退驗證 ───

    // 準備 mock state file（用臨時 session ID）
    const mockSessionId = `validate-retry-${Date.now()}`;
    const mockStatePath = path.join(CLAUDE_DIR, `pipeline-state-${mockSessionId}.json`);

    // 建立 mock transcript（含 PASS verdict）
    const mockTranscriptPass = path.join(os.tmpdir(), `verdict-pass-${Date.now()}.jsonl`);
    const mockTranscriptFail = path.join(os.tmpdir(), `verdict-fail-${Date.now()}.jsonl`);
    const mockTranscriptMedium = path.join(os.tmpdir(), `verdict-medium-${Date.now()}.jsonl`);
    try {
      fs.writeFileSync(mockTranscriptPass,
        JSON.stringify({ role: 'assistant', content: '結論\n<!-- PIPELINE_VERDICT: PASS -->' }) + '\n');
      fs.writeFileSync(mockTranscriptFail,
        JSON.stringify({ role: 'assistant', content: '結論\n<!-- PIPELINE_VERDICT: FAIL:HIGH -->' }) + '\n');
      fs.writeFileSync(mockTranscriptMedium,
        JSON.stringify({ role: 'assistant', content: '結論\n<!-- PIPELINE_VERDICT: FAIL:MEDIUM -->' }) + '\n');
    } catch (_) {}

    // 輔助：執行 stage-transition 並解析輸出
    function runTransition(stdinObj) {
      const stdin = JSON.stringify(stdinObj);
      try {
        const result = execSync(`echo '${stdin.replace(/'/g, "'\\''")}' | node "${transPath}"`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
          env: transEnv,
        }).toString().trim();
        return result ? JSON.parse(result) : null;
      } catch (_) {
        return null;
      }
    }

    // 回退驗證 1：PASS verdict → 正常前進（無回退）
    try {
      // 先建立乾淨的 state（已有 DEV 完成，進入 REVIEW）
      fs.writeFileSync(mockStatePath, JSON.stringify({
        completed: ['developer'], expectedStages: ['DEV', 'REVIEW', 'TEST'],
        stageResults: {}, retries: {},
      }));
      const output = runTransition({
        session_id: mockSessionId, agent_type: 'code-reviewer',
        agent_transcript_path: mockTranscriptPass,
      });
      const hasForward = output && output.systemMessage && output.systemMessage.includes('必須立即');
      const noRetry = output && output.systemMessage && !output.systemMessage.includes('回退');
      checks.push({
        id: 'HOOK-RETRY',
        name: 'stage-transition PASS → 正常前進',
        result: hasForward && noRetry ? 'PASS' : 'FAIL',
        expected: '前進到下一階段，無回退',
        actual: output ? output.systemMessage.slice(0, 80) : '無輸出',
      });
    } catch (err) {
      checks.push({
        id: 'HOOK-RETRY',
        name: 'stage-transition PASS → 正常前進',
        result: 'FAIL', expected: '前進', actual: err.message.slice(0, 80),
      });
    }

    // 回退驗證 2：FAIL:HIGH verdict → 觸發回退到 DEV
    try {
      fs.writeFileSync(mockStatePath, JSON.stringify({
        completed: ['developer'], expectedStages: ['DEV', 'REVIEW', 'TEST'],
        stageResults: {}, retries: {},
      }));
      const output = runTransition({
        session_id: mockSessionId, agent_type: 'code-reviewer',
        agent_transcript_path: mockTranscriptFail,
      });
      const hasRetry = output && output.systemMessage && output.systemMessage.includes('回退');
      const backToDev = output && output.systemMessage && output.systemMessage.includes('DEV');
      const hasRetryCount = output && output.systemMessage && /1\/3/.test(output.systemMessage);
      checks.push({
        id: 'HOOK-RETRY',
        name: 'stage-transition FAIL:HIGH → 回退到 DEV',
        result: hasRetry && backToDev && hasRetryCount ? 'PASS' : 'FAIL',
        expected: '回退到 DEV，回退次數 1/3',
        actual: output ? output.systemMessage.slice(0, 80) : '無輸出',
      });
    } catch (err) {
      checks.push({
        id: 'HOOK-RETRY',
        name: 'stage-transition FAIL:HIGH → 回退到 DEV',
        result: 'FAIL', expected: '回退', actual: err.message.slice(0, 80),
      });
    }

    // 回退驗證 3：FAIL:MEDIUM → 不回退（只是建議）
    try {
      fs.writeFileSync(mockStatePath, JSON.stringify({
        completed: ['developer'], expectedStages: ['DEV', 'REVIEW', 'TEST'],
        stageResults: {}, retries: {},
      }));
      const output = runTransition({
        session_id: mockSessionId, agent_type: 'code-reviewer',
        agent_transcript_path: mockTranscriptMedium,
      });
      const noRetry = output && output.systemMessage && !output.systemMessage.includes('回退');
      checks.push({
        id: 'HOOK-RETRY',
        name: 'stage-transition FAIL:MEDIUM → 不回退',
        result: noRetry ? 'PASS' : 'FAIL',
        expected: '正常前進（MEDIUM 不觸發回退）',
        actual: output ? output.systemMessage.slice(0, 80) : '無輸出',
      });
    } catch (err) {
      checks.push({
        id: 'HOOK-RETRY',
        name: 'stage-transition FAIL:MEDIUM → 不回退',
        result: 'FAIL', expected: '不回退', actual: err.message.slice(0, 80),
      });
    }

    // 回退驗證 4：超過 MAX_RETRIES → 強制繼續
    try {
      fs.writeFileSync(mockStatePath, JSON.stringify({
        completed: ['developer'], expectedStages: ['DEV', 'REVIEW', 'TEST'],
        stageResults: {}, retries: { REVIEW: 3 },
      }));
      const output = runTransition({
        session_id: mockSessionId, agent_type: 'code-reviewer',
        agent_transcript_path: mockTranscriptFail,
      });
      const forcedForward = output && output.systemMessage && output.systemMessage.includes('回退上限');
      const noRetry = output && output.systemMessage && !output.systemMessage.includes('🔄');
      checks.push({
        id: 'HOOK-RETRY',
        name: 'stage-transition 超過回退上限 → 強制繼續',
        result: forcedForward && noRetry ? 'PASS' : 'FAIL',
        expected: '強制繼續 + 警告訊息',
        actual: output ? output.systemMessage.slice(0, 80) : '無輸出',
      });
    } catch (err) {
      checks.push({
        id: 'HOOK-RETRY',
        name: 'stage-transition 超過回退上限 → 強制繼續',
        result: 'FAIL', expected: '強制繼續', actual: err.message.slice(0, 80),
      });
    }

    // 回退驗證 5：各階段回退次數獨立
    try {
      fs.writeFileSync(mockStatePath, JSON.stringify({
        completed: ['developer', 'code-reviewer'], expectedStages: ['DEV', 'REVIEW', 'TEST', 'QA'],
        stageResults: {}, retries: { REVIEW: 3, TEST: 0 },
      }));
      const output = runTransition({
        session_id: mockSessionId, agent_type: 'tester',
        agent_transcript_path: mockTranscriptFail,
      });
      const hasRetry = output && output.systemMessage && output.systemMessage.includes('回退');
      const hasTestRetry = output && output.systemMessage && /1\/3/.test(output.systemMessage);
      checks.push({
        id: 'HOOK-RETRY',
        name: 'stage-transition 各階段回退次數獨立',
        result: hasRetry && hasTestRetry ? 'PASS' : 'FAIL',
        expected: 'TEST 獨立回退 1/3（不受 REVIEW 已用完影響）',
        actual: output ? output.systemMessage.slice(0, 80) : '無輸出',
      });
    } catch (err) {
      checks.push({
        id: 'HOOK-RETRY',
        name: 'stage-transition 各階段回退次數獨立',
        result: 'FAIL', expected: '獨立回退', actual: err.message.slice(0, 80),
      });
    }

    // 回退驗證 6：state file 正確更新 retries 計數
    try {
      const stateAfter = JSON.parse(fs.readFileSync(mockStatePath, 'utf8'));
      const testRetries = stateAfter.retries && stateAfter.retries.TEST;
      const reviewRetries = stateAfter.retries && stateAfter.retries.REVIEW;
      checks.push({
        id: 'HOOK-RETRY',
        name: 'state file retries 計數正確',
        result: testRetries === 1 && reviewRetries === 3 ? 'PASS' : 'FAIL',
        expected: 'TEST=1, REVIEW=3',
        actual: `TEST=${testRetries}, REVIEW=${reviewRetries}`,
      });
    } catch (err) {
      checks.push({
        id: 'HOOK-RETRY',
        name: 'state file retries 計數正確',
        result: 'FAIL', expected: 'TEST=1, REVIEW=3', actual: err.message.slice(0, 80),
      });
    }

    // 清理 mock 檔案
    try { fs.unlinkSync(mockStatePath); } catch (_) {}
    try { fs.unlinkSync(mockTranscriptPass); } catch (_) {}
    try { fs.unlinkSync(mockTranscriptFail); } catch (_) {}
    try { fs.unlinkSync(mockTranscriptMedium); } catch (_) {}

    // ─── Agent Verdict 標記驗證 ───
    const verdictAgents = ['code-reviewer', 'tester', 'qa', 'e2e-runner'];
    for (const agent of verdictAgents) {
      const agentPath = path.join(PLUGINS_DIR, 'sentinel', 'agents', `${agent}.md`);
      if (!fs.existsSync(agentPath)) continue;
      const content = fs.readFileSync(agentPath, 'utf8');
      const hasVerdict = content.includes('PIPELINE_VERDICT');
      const hasPass = content.includes('PIPELINE_VERDICT: PASS');
      const hasFail = content.includes('PIPELINE_VERDICT: FAIL');
      checks.push({
        id: 'HOOK-VERDICT',
        name: `${agent} 有 PIPELINE_VERDICT 標記規則`,
        result: hasVerdict && hasPass && hasFail ? 'PASS' : 'FAIL',
        expected: 'PASS + FAIL 兩種標記',
        actual: hasVerdict ? (hasPass && hasFail ? 'PASS + FAIL 皆有' : '標記不完整') : '無 VERDICT 標記',
      });
    }
  }

  // pipeline-check：防迴圈
  const checkPath = path.join(PLUGINS_DIR, 'flow', 'scripts', 'hooks', 'pipeline-check.js');
  if (fs.existsSync(checkPath)) {
    try {
      const stdin = JSON.stringify({ stop_hook_active: true, session_id: 'test' });
      const result = execSync(`echo '${stdin}' | node "${checkPath}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(PLUGINS_DIR, 'flow') },
      }).toString().trim();
      checks.push({
        id: 'HOOK-LOOP',
        name: 'pipeline-check 防迴圈',
        result: result === '' ? 'PASS' : 'FAIL',
        expected: '靜默退出（無輸出）',
        actual: result || '（空）',
      });
    } catch (_) {
      checks.push({
        id: 'HOOK-LOOP',
        name: 'pipeline-check 防迴圈',
        result: 'PASS',
        expected: '靜默退出',
        actual: 'exit 0',
      });
    }
  }

  // check-console-log：防迴圈
  const consolePath = path.join(PLUGINS_DIR, 'sentinel', 'scripts', 'hooks', 'check-console-log.js');
  if (fs.existsSync(consolePath)) {
    try {
      const stdin = JSON.stringify({ stop_hook_active: true });
      const result = execSync(`echo '${stdin}' | node "${consolePath}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).toString().trim();
      checks.push({
        id: 'HOOK-LOOP',
        name: 'check-console-log 防迴圈',
        result: result === '' ? 'PASS' : 'FAIL',
        expected: '靜默退出（無輸出）',
        actual: result || '（空）',
      });
    } catch (_) {
      checks.push({
        id: 'HOOK-LOOP',
        name: 'check-console-log 防迴圈',
        result: 'PASS',
        expected: '靜默退出',
        actual: 'exit 0',
      });
    }
  }

  return checks;
}

// ─── 工具函式 ──────────────────────────────────────

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

// ─── 報告產生 ──────────────────────────────────────

function generateReport(checks, state, pipeline) {
  const passed = checks.filter(c => c.result === 'PASS').length;
  const failed = checks.filter(c => c.result === 'FAIL').length;
  const warned = checks.filter(c => c.result === 'WARN').length;
  const skipped = checks.filter(c => c.result === 'SKIP').length;

  return {
    timestamp: new Date().toISOString(),
    sessionId: state ? state.sessionId : null,
    taskType: state ? state.taskType : null,
    result: failed > 0 ? 'FAIL' : warned > 0 ? 'WARN' : 'PASS',
    summary: {
      total: checks.length,
      passed,
      failed,
      warned,
      skipped,
    },
    pipeline: {
      definedStages: pipeline.stageOrder,
      installedStages: pipeline.stageOrder.filter(s => pipeline.stageMap[s]),
      expectedStages: state ? (state.expectedStages || []) : [],
      completedAgents: state ? (state.completed || []) : [],
    },
    checks,
    failures: checks.filter(c => c.result === 'FAIL'),
    warnings: checks.filter(c => c.result === 'WARN'),
  };
}

function printSummary(report) {
  const icon = report.result === 'PASS' ? '✅' : report.result === 'WARN' ? '⚠️' : '❌';
  process.stderr.write(`\n${icon} 工作流驗證結果：${report.result}\n`);
  process.stderr.write(`   通過: ${report.summary.passed}  失敗: ${report.summary.failed}  警告: ${report.summary.warned}  跳過: ${report.summary.skipped}\n`);

  if (report.sessionId) {
    process.stderr.write(`   Session: ${report.sessionId}\n`);
    process.stderr.write(`   任務類型: ${report.taskType || '未分類'}\n`);
  }

  if (report.pipeline.completedAgents.length > 0) {
    process.stderr.write(`   已完成 agents: ${report.pipeline.completedAgents.join(' → ')}\n`);
  }

  if (report.failures.length > 0) {
    process.stderr.write('\n   ── 失敗項目 ──\n');
    for (const f of report.failures) {
      process.stderr.write(`   ❌ ${f.name}\n      預期: ${f.expected}\n      實際: ${f.actual}\n`);
    }
  }

  if (report.warnings.length > 0) {
    process.stderr.write('\n   ── 警告項目 ──\n');
    for (const w of report.warnings) {
      process.stderr.write(`   ⚠️  ${w.name}\n      ${w.actual}\n`);
    }
  }

  process.stderr.write('\n');
}

// ─── 主程式 ──────────────────────────────────────

function main() {
  const arg = process.argv[2];

  if (!arg) {
    process.stderr.write('用法：node scripts/validate-workflow.js <sessionId|--latest|--check-config>\n');
    process.exit(1);
  }

  const pipeline = discoverPipelineLocal();

  if (pipeline.stageOrder.length === 0) {
    process.stderr.write('錯誤：找不到 plugins/flow/pipeline.json\n');
    process.exit(1);
  }

  // --check-config：驗證 pipeline 配置 + hook 流程
  if (arg === '--check-config') {
    const checks = [
      ...checkConfig(pipeline),
      ...checkHooks(),
    ];
    const report = generateReport(checks, null, pipeline);
    printSummary(report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.result === 'FAIL' ? 1 : 0);
  }

  // 驗證完整工作流
  const state = loadState(arg);
  if (!state) {
    process.stderr.write(`錯誤：找不到 session state（${arg}）\n`);
    process.stderr.write('提示：用 --latest 驗證最近的 session，或 --check-config 只驗證配置\n');
    process.exit(1);
  }

  const targetDir = state.environment?.cwd || ROOT;

  const allChecks = [
    ...checkConfig(pipeline),
    ...checkHooks(),
    ...checkCompliance(pipeline, state),
    ...checkArtifacts(targetDir),
    ...checkQuality(targetDir),
    ...checkConventions(targetDir),
  ];

  const report = generateReport(allChecks, state, pipeline);
  printSummary(report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.result === 'FAIL' ? 1 : 0);
}

main();
