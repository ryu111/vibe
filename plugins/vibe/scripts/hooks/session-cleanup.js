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
 * 5. MCP log 檔案
 */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STALE_DAYS = 3;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

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

    // --- 4. 清理過時 state 檔案 ---
    cleanStaleFiles('timeline-*.jsonl', results);
    cleanStaleFiles('pipeline-state-*.json', results);

    // --- 5. 清理 MCP log ---
    cleanMcpLogs(results);

    // 輸出摘要（只在有清理動作時報告）
    if (results.orphansKilled > 0 || results.filesRemoved > 0) {
      const parts = [];
      if (results.orphansKilled > 0) {
        parts.push(`清理 ${results.orphansKilled} 個孤兒進程（~${results.mbFreed}MB）`);
      }
      if (results.filesRemoved > 0) {
        parts.push(`移除 ${results.filesRemoved} 個過時檔案`);
      }
      console.log(JSON.stringify({
        additionalContext: `[清理] ${parts.join('，')}`
      }));
    }
  } catch (err) {
    // 清理失敗不應阻擋 session 啟動
    try {
      const hookLogger = require(path.join(__dirname, '..', 'lib', 'hook-logger.js'));
      hookLogger.error('session-cleanup', err);
    } catch (_) {}
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
