#!/usr/bin/env node
/**
 * session-cleanup.js — SessionStart hook
 *
 * 自動清理殘留進程和過時檔案，防止 RAM 持續累積。
 *
 * 清理項目：
 * 1. 孤兒 chroma-mcp / uv 進程（PPID=1，來自已結束的 claude-mem session）
 * 2. 孤兒 claude-in-chrome-mcp 進程（不屬於任何活躍 claude session）
 * 3. 過時的 timeline-*.jsonl（> 3 天）
 * 4. 過時的 pipeline-state-*.json（> 3 天）
 * 5. 過時的 pipeline-wisdom-*.md（> 3 天）
 * 6. MCP log 檔案
 */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STALE_DAYS = 3;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
// COMPLETE 或超過 48h 的 pipeline state 提前清理（支援 pipeline-resume 功能）
const PIPELINE_STALE_MS = 48 * 60 * 60 * 1000;
// 超過 1 小時的暫存檔（*.tmp.*）視為廢棄
const TMP_STALE_MS = 60 * 60 * 1000;
// RAM 水位閾值（與 ram-monitor.sh 的 WARN_THRESHOLD_MB / CRIT_THRESHOLD_MB 保持一致）
const RAM_WARN_MB = 4096;   // 4GB 警告
const RAM_CRIT_MB = 8192;   // 8GB 嚴重

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'unknown';
    const results = { orphansKilled: 0, filesRemoved: 0, mbFreed: 0 };

    // --- 1. 清理孤兒 chroma-mcp 進程樹（uv launcher + python worker） ---
    cleanOrphanChromaTree(results);

    // --- 2. 清理無主的 claude-in-chrome-mcp 進程 ---
    cleanOrphanChromeMcp(sessionId, results);

    // --- 3b. 清理過時 heartbeat 檔案 ---
    cleanStaleFiles('heartbeat-*', results);

    // --- 4. 清理過時 state 檔案 ---
    cleanStaleFiles('timeline-*.jsonl', results);
    cleanStaleFiles('pipeline-state-*.json', results);
    // pipeline-context 檔案（品質階段的詳細報告）
    cleanStaleFiles('pipeline-context-*.md', results);
    // reflection-memory 檔案（v4 回退歷史記錄）
    cleanStaleFiles('reflection-memory-*.md', results);
    // pipeline-wisdom 檔案（v5 S4 跨 stage 知識累積）
    cleanStaleFiles('pipeline-wisdom-*.md', results);
    // pipeline-status 檔案（v5 S5 FIC 狀態壓縮）
    cleanStaleFiles('pipeline-status-*.md', results);
    // barrier-state 檔案（v4 Phase 4 並行同步）
    cleanStaleFiles('barrier-state-*.json', results);
    // 提前清理：COMPLETE pipeline 或超過 48h 的 pipeline state
    cleanCompletedPipelineStates(sessionId, results);

    // --- 5. 清理 MCP log ---
    cleanMcpLogs(results);

    // --- 6. 清理過時暫存檔（*.tmp.*，超過 1 小時）---
    cleanStaleTmpFiles(results);

    // --- 7. RAM 水位偵測（清理後執行，獨立判斷）---
    const ramResult = checkRamWatermark();

    // 輸出摘要（有清理動作 或 RAM 警告 時報告）
    if (results.orphansKilled > 0 || results.filesRemoved > 0 || ramResult.warning) {
      const parts = [];
      if (results.orphansKilled > 0) {
        parts.push(`清理 ${results.orphansKilled} 個孤兒進程（~${results.mbFreed}MB）`);
      }
      if (results.filesRemoved > 0) {
        parts.push(`移除 ${results.filesRemoved} 個過時檔案`);
      }
      const contextParts = [];
      if (parts.length > 0) {
        contextParts.push(`[清理] ${parts.join('，')}`);
      }
      if (ramResult.warning) {
        contextParts.push(ramResult.warning);
      }
      console.log(JSON.stringify({
        additionalContext: contextParts.join('\n')
      }));
    }
  } catch (err) {
    // 清理失敗不應阻擋 session 啟動
    hookLogger.error('session-cleanup', err);
  }
});

/**
 * 清理孤兒 chroma-mcp 進程樹（PPID=1 的 uv launcher + 其子 python 進程）
 * 策略：先找 PPID=1 的 uv 進程，收集其 PID，再找這些 PID 的子進程一併清理
 */
function cleanOrphanChromaTree(results) {
  try {
    // 第一步：找出所有 PPID=1 的 uv chroma 進程
    const uvOutput = execSync(
      `ps -eo pid,ppid,rss,command 2>/dev/null | grep 'uv tool uvx.*chroma-mcp' | grep -v grep`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    if (!uvOutput) return;

    const orphanUvPids = new Set();
    for (const line of uvOutput.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0]);
      const ppid = parseInt(parts[1]);
      if (ppid === 1) orphanUvPids.add(pid);
    }
    if (orphanUvPids.size === 0) return;

    // 第二步：找出這些孤兒 uv 的子進程（python chroma-mcp）
    const allOutput = execSync(
      `ps -eo pid,ppid,rss,command 2>/dev/null | grep 'chroma-mcp' | grep -v grep`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();

    const toKill = []; // { pid, rss }
    for (const line of allOutput.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0]);
      const ppid = parseInt(parts[1]);
      const rss = parseInt(parts[2]);

      // 直接孤兒（PPID=1）或孤兒的子進程
      if (orphanUvPids.has(pid) || orphanUvPids.has(ppid)) {
        toKill.push({ pid, rss });
      }
    }

    // 第三步：先殺子進程再殺父進程（逆序）
    toKill.reverse();
    for (const { pid, rss } of toKill) {
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGTERM');
        results.orphansKilled++;
        results.mbFreed += Math.round(rss / 1024);
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * 清理無主的 claude-in-chrome-mcp 進程
 * 用 kill(ppid, 0) 直接檢查父進程是否存活（比 grep PID 列表更可靠）
 */
function cleanOrphanChromeMcp(currentSessionId, results) {
  try {
    const chromeMcpOutput = execSync(
      `ps -eo pid,ppid,rss,command 2>/dev/null | grep 'claude-in-chrome-mcp' | grep -v grep`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    if (!chromeMcpOutput) return;

    for (const line of chromeMcpOutput.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0]);
      const ppid = parseInt(parts[1]);
      const rss = parseInt(parts[2]);

      // 直接檢查父進程是否存活
      let parentAlive = false;
      try {
        process.kill(ppid, 0); // signal 0 = 只檢查存在性
        parentAlive = true;
      } catch (_) {}

      if (!parentAlive) {
        try {
          process.kill(pid, 'SIGTERM');
          results.orphansKilled++;
          results.mbFreed += Math.round(rss / 1024);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

/**
 * 清理過時的 session-isolated 檔案
 */
function cleanStaleFiles(pattern, results) {
  try {
    const files = fs.readdirSync(CLAUDE_DIR).filter(f => {
      // 簡單 glob 匹配
      if (pattern === 'timeline-*.jsonl') {
        return f.startsWith('timeline-') && f.endsWith('.jsonl');
      }
      if (pattern === 'pipeline-state-*.json') {
        return f.startsWith('pipeline-state-') && f.endsWith('.json');
      }
      if (pattern === 'heartbeat-*') {
        return f.startsWith('heartbeat-');
      }
      if (pattern === 'pipeline-context-*.md') {
        return f.startsWith('pipeline-context-') && f.endsWith('.md');
      }
      if (pattern === 'reflection-memory-*.md') {
        return f.startsWith('reflection-memory-') && f.endsWith('.md');
      }
      if (pattern === 'barrier-state-*.json') {
        return f.startsWith('barrier-state-') && f.endsWith('.json');
      }
      if (pattern === 'pipeline-wisdom-*.md') {
        return f.startsWith('pipeline-wisdom-') && f.endsWith('.md');
      }
      if (pattern === 'pipeline-status-*.md') {
        return f.startsWith('pipeline-status-') && f.endsWith('.md');
      }
      return false;
    });

    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(CLAUDE_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > STALE_MS) {
          fs.unlinkSync(filePath);
          results.filesRemoved++;
        }
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * 提前清理 pipeline-state：
 * - COMPLETE 的（已完成，不需再接續）
 * - 超過 48h 的（即使未完成，也不值得接續）
 * 排除當前 session 自己的 state
 */
function cleanCompletedPipelineStates(currentSessionId, results) {
  try {
    // 延遲 require 以避免循環依賴
    const { derivePhase, PHASES } = require(path.join(__dirname, '..', 'lib', 'flow', 'dag-state.js'));
    const files = fs.readdirSync(CLAUDE_DIR).filter(
      f => f.startsWith('pipeline-state-') && f.endsWith('.json')
    );
    const now = Date.now();

    for (const file of files) {
      const sessionId = file.replace('pipeline-state-', '').replace('.json', '');
      // 排除自己（當前 session 的 state 在此 hook 執行時可能剛建立）
      if (sessionId === currentSessionId) continue;

      const filePath = path.join(CLAUDE_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        const ageMs = now - stat.mtimeMs;

        // 超過 48h 直接刪
        if (ageMs > PIPELINE_STALE_MS) {
          fs.unlinkSync(filePath);
          results.filesRemoved++;
          continue;
        }

        // 讀取 state 檢查是否 COMPLETE（支援 v3 和 v4）
        // 加 5 分鐘寬限期：防止並行 session 互相刪除剛完成的 state
        // （E2E 測試中多個 claude subprocess 同時運行，
        //   先完成的 state 會被後啟動的 SessionStart 清理掉）
        const COMPLETE_GRACE_MS = 5 * 60 * 1000;
        const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if ((state.version === 3 || state.version === 4) &&
            derivePhase(state) === PHASES.COMPLETE &&
            ageMs > COMPLETE_GRACE_MS) {
          fs.unlinkSync(filePath);
          results.filesRemoved++;
        }
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * 清理過時暫存檔（~/.claude/*.tmp.*，超過 1 小時）
 * 這些檔案通常由 atomic-write 或測試腳本產生，正常執行後應自動刪除。
 * 若殘留超過 1 小時，視為廢棄暫存檔。
 */
function cleanStaleTmpFiles(results) {
  try {
    const files = fs.readdirSync(CLAUDE_DIR).filter(f => f.includes('.tmp.'));
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(CLAUDE_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > TMP_STALE_MS) {
          fs.unlinkSync(filePath);
          results.filesRemoved++;
        }
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * 偵測 Claude 生態圈 RAM 水位
 *
 * 使用單一 ps 呼叫取得所有進程的 RSS，用 JS 逐行匹配 Claude 生態圈進程模式，
 * 累加 RSS（KB → MB）並與閾值比較。
 *
 * 匹配模式（與 ram-monitor.sh 對齊）：
 * - claude CLI 進程（排除 chrome-mcp）
 * - claude-in-chrome-mcp
 * - chroma-mcp 相關進程
 * - uv tool uvx chroma 進程
 * - worker-service.cjs / mcp-server.cjs（MCP worker）
 * - vibe/server.js / vibe/bot.js（Dashboard + Telegram daemon）
 *
 * @returns {{ totalMb: number, warning: string|null }}
 */
function checkRamWatermark() {
  try {
    const output = execSync(
      'ps -eo rss,command 2>/dev/null',
      { encoding: 'utf8', timeout: 3000 }
    );
    let totalKb = 0;
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const spaceIdx = line.trimStart().indexOf(' ');
      if (spaceIdx === -1) continue;
      const trimmed = line.trimStart();
      const rss = parseInt(trimmed.slice(0, spaceIdx));
      if (isNaN(rss) || rss <= 0) continue;
      const cmd = trimmed.slice(spaceIdx + 1).trim();

      // 匹配 Claude 生態圈進程
      const isClaude =
        /(^|\/)claude( |$)/.test(cmd) && !/chrome-mcp/.test(cmd);
      const isChromeMcp = /claude-in-chrome-mcp/.test(cmd);
      const isChromaMcp = /chroma-mcp/.test(cmd);
      const isUvChroma = /uv tool uvx.*chroma/.test(cmd);
      const isWorkerService = /worker-service\.cjs/.test(cmd);
      const isMcpServer = /mcp-server\.cjs/.test(cmd);
      const isVibeServer = /vibe\/server\.js/.test(cmd);
      const isVibeBot = /vibe\/bot\.js/.test(cmd);

      if (isClaude || isChromeMcp || isChromaMcp || isUvChroma ||
          isWorkerService || isMcpServer || isVibeServer || isVibeBot) {
        totalKb += rss;
      }
    }

    const totalMb = Math.round(totalKb / 1024);

    if (totalMb >= RAM_CRIT_MB) {
      return {
        totalMb,
        warning: `[RAM 嚴重] Claude 生態圈記憶體使用 ${totalMb}MB（>= ${RAM_CRIT_MB}MB）。` +
          `建議執行 /vibe:health 診斷並重啟 Claude。`,
      };
    }
    if (totalMb >= RAM_WARN_MB) {
      return {
        totalMb,
        warning: `[RAM 警告] Claude 生態圈記憶體使用 ${totalMb}MB（>= ${RAM_WARN_MB}MB）。` +
          `建議執行 /vibe:health 檢查孤兒進程。`,
      };
    }

    return { totalMb, warning: null };
  } catch (_) {
    // ps 失敗不影響 session 啟動
    return { totalMb: 0, warning: null };
  }
}

/**
 * 清理 MCP log 檔案
 */
function cleanMcpLogs(results) {
  const logDir = path.join(os.homedir(), '.cache', 'claude-cli-nodejs');
  try {
    if (!fs.existsSync(logDir)) return;

    const versions = fs.readdirSync(logDir);
    for (const ver of versions) {
      const mcpLogDir = path.join(logDir, ver, 'mcp-logs');
      if (!fs.existsSync(mcpLogDir)) continue;

      const sessions = fs.readdirSync(mcpLogDir);
      const now = Date.now();
      for (const session of sessions) {
        const sessionDir = path.join(mcpLogDir, session);
        try {
          const stat = fs.statSync(sessionDir);
          if (now - stat.mtimeMs > STALE_MS) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            results.filesRemoved++;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
}
