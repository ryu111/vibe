#!/usr/bin/env bun
/**
 * Vibe Pipeline Dashboard Server
 * Bun HTTP + WebSocket，監聽 pipeline state 檔案即時推播
 * Phase 3：整合 Timeline consumer 訂閱事件流
 */
import { watch, readFileSync, readdirSync, existsSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';

// 動態引入 CommonJS 模組
const { createConsumer } = await import('./scripts/lib/timeline/consumer.js');
const { query } = await import('./scripts/lib/timeline/timeline.js');
const { formatEventText, EMOJI_MAP } = await import('./scripts/lib/timeline/formatter.js');

// --port CLI 參數 or 環境變數
const portArg = process.argv.find(a => a.startsWith('--port='));
const PORT = Number(portArg?.split('=')[1]) || Number(process.env.VIBE_DASHBOARD_PORT) || 3800;
const PID_FILE = join(homedir(), '.claude', 'dashboard-server.pid');
const CLAUDE_DIR = join(homedir(), '.claude');
const WEB_DIR = join(import.meta.dir, 'web');

// --- State ---
let sessions = {};
const clients = new Set();
const timelineConsumers = new Map(); // sessionId → consumer

/** 判斷 session 是否值得顯示在 Dashboard */
function isDisplayWorthy(state) {
  if (!state) return false;
  // 有 DAG（活躍/已完成 pipeline）→ 顯示
  if (state.dag && Object.keys(state.dag).length > 0) return true;
  // 有非 none 分類 → 顯示
  if (state.classification?.pipelineId && state.classification.pipelineId !== 'none') return true;
  // v2 相容
  if (state.expectedStages?.length > 0) return true;
  return false;
}

function scanSessions() {
  if (!existsSync(CLAUDE_DIR)) return {};
  const out = {};
  for (const f of readdirSync(CLAUDE_DIR)) {
    if (!f.startsWith('pipeline-state-') || !f.endsWith('.json')) continue;
    try {
      const state = JSON.parse(readFileSync(join(CLAUDE_DIR, f), 'utf8'));
      if (isDisplayWorthy(state)) {
        out[f.slice(15, -5)] = state;
      }
    } catch { /* 忽略損壞檔案 */ }
  }
  return out;
}

/** 自動清理空/過期 state 檔案 */
function autoCleanup() {
  if (!existsSync(CLAUDE_DIR)) return;
  const now = Date.now();
  let changed = false;
  for (const f of readdirSync(CLAUDE_DIR)) {
    if (!f.startsWith('pipeline-state-') || !f.endsWith('.json')) continue;
    const fp = join(CLAUDE_DIR, f);
    try {
      const state = JSON.parse(readFileSync(fp, 'utf8'));
      // 空 session（無 DAG、無分類）且超過 30 分鐘 → 清理
      if (!isDisplayWorthy(state)) {
        const mtime = statSync(fp).mtimeMs;
        if (now - mtime > 30 * 60 * 1000) {
          const sid = f.slice(15, -5);
          unlinkSync(fp);
          delete sessions[sid];
          stopTimelineConsumer(sid);
          changed = true;
        }
      }
    } catch { /* 忽略 */ }
  }
  if (changed) broadcast({ type: 'update', sessions });
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(s); } catch { clients.delete(ws); }
  }
}

/** 事件類型→分類映射（前端 Tab 篩選用） */
function eventCat(type) {
  if (type.startsWith('stage.') || type.startsWith('pipeline.')) return 'pipeline';
  if (type.startsWith('quality.') || type === 'tool.blocked' || type === 'tool.guarded') return 'quality';
  if (type === 'tool.used' || type === 'delegation.start') return 'agent';
  if (type === 'session.start' || type === 'task.classified' || type === 'prompt.received' || type === 'task.incomplete') return 'pipeline';
  if (type.startsWith('ask.') || type.startsWith('compact.') || type.startsWith('say.') || type === 'turn.summary') return 'task';
  return 'task';
}

/** Agent→emoji 映射（pipeline stage 對應） */
const AGENT_EMOJI = {
  planner: '📋', architect: '🏛️', designer: '🎨', developer: '🏗️',
  'code-reviewer': '🔍', tester: '🧪', qa: '✅', 'e2e-runner': '🌐',
  'doc-updater': '📝',
  'security-reviewer': '🛡️', 'build-error-resolver': '🔧',
};

/**
 * 格式化 timeline 事件為結構化物件（用於前端推送）
 * 使用 formatter.js 的 formatEventText 統一文字描述
 */
function formatEvent(event, sessionId) {
  const t = new Date(event.timestamp).toLocaleTimeString('zh-TW', { hour12: false });
  const d = event.data || {};
  let emoji = EMOJI_MAP[event.type] || '📌';

  // tool.used：有 stage → sub-agent emoji / 無 stage → Main Agent 🎯
  // delegation.start：用 agentType 查 emoji
  if (event.type === 'tool.used') {
    const sm = { PLAN: 'planner', ARCH: 'architect', DESIGN: 'designer', DEV: 'developer', REVIEW: 'code-reviewer', TEST: 'tester', QA: 'qa', E2E: 'e2e-runner', DOCS: 'doc-updater' };
    const stage = d.stage;
    if (stage && sm[stage] && AGENT_EMOJI[sm[stage]]) {
      emoji = AGENT_EMOJI[sm[stage]]; // sub-agent
    } else {
      emoji = '🎯'; // Main Agent
    }
  } else if (event.type === 'delegation.start') {
    const agent = d.agentType;
    if (agent && AGENT_EMOJI[agent]) emoji = AGENT_EMOJI[agent];
  }

  const text = formatEventText(event);

  // 判斷事件狀態類型（前端 CSS 用）
  let type = 'active';
  if (event.type === 'stage.complete' || event.type === 'pipeline.complete') {
    type = (d.verdict === 'FAIL' || d.severity) ? 'fail' : 'pass';
  } else if (event.type === 'quality.lint') {
    type = d.pass ? 'pass' : 'fail';
  } else if (event.type === 'tool.blocked' || event.type === 'stage.retry') {
    type = 'fail';
  }

  return { time: t, ts: event.timestamp, type, cat: eventCat(event.type), emoji, text, eventType: event.type };
}

/**
 * 啟動指定 session 的 Timeline consumer
 */
function startTimelineConsumer(sessionId) {
  if (timelineConsumers.has(sessionId)) return;

  const consumer = createConsumer({
    name: `dashboard-${sessionId.slice(0, 8)}`,
    types: ['session', 'pipeline', 'quality', 'task', 'agent', 'remote'],
    handlers: {
      '*': (event) => {
        const formatted = formatEvent(event, sessionId);
        broadcast({
          type: 'timeline',
          sessionId,
          event: formatted,
        });
      },
    },
    onError: (name, err) => {
      console.error(`[Timeline Consumer ${name}] Error:`, err.message);
    },
  });

  consumer.start(sessionId, { replay: true });
  timelineConsumers.set(sessionId, consumer);
}

/**
 * 停止指定 session 的 Timeline consumer
 */
function stopTimelineConsumer(sessionId) {
  const consumer = timelineConsumers.get(sessionId);
  if (consumer) {
    consumer.stop();
    timelineConsumers.delete(sessionId);
  }
}

// --- File Watcher（防抖 80ms）---
let timer;
if (existsSync(CLAUDE_DIR)) {
  watch(CLAUDE_DIR, (_, filename) => {
    if (!filename?.startsWith('pipeline-state-') || !filename.endsWith('.json')) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const sid = filename.slice(15, -5);
      const fp = join(CLAUDE_DIR, filename);
      try {
        if (existsSync(fp)) {
          const state = JSON.parse(readFileSync(fp, 'utf8'));
          if (isDisplayWorthy(state)) {
            sessions[sid] = state;
            // 新 session 出現 → 啟動 consumer
            if (!timelineConsumers.has(sid)) {
              startTimelineConsumer(sid);
            }
          } else {
            // 不值得顯示 → 從廣播移除（但保留檔案）
            if (sessions[sid]) delete sessions[sid];
          }
        } else {
          delete sessions[sid];
          // Session 消失 → 停止 consumer
          stopTimelineConsumer(sid);
        }
      } catch { /* 忽略 */ }
      broadcast({ type: 'update', sessions });
    }, 80);
  });
}

/** Pipeline 100% 完成 */
function pct100(state) {
  if (!state?.dag) return false;
  const dagKeys = Object.keys(state.dag);
  if (!dagKeys.length) return false;
  const stages = state.stages || {};
  return dagKeys.every(id => stages[id]?.status === 'completed' || stages[id]?.status === 'skipped');
}

/** 過期 session（1h 無活動 + 未完成） */
function isStaleSession(state) {
  if (!state) return true;
  const last = state.meta?.lastTransition || state.lastTransition;
  if (!last) return true;
  return (Date.now() - new Date(last).getTime()) > 3600_000;
}

sessions = scanSessions();

// 啟動已存在 session 的 Timeline consumer
for (const sid of Object.keys(sessions)) {
  startTimelineConsumer(sid);
}

// 定時清理空 state（每 5 分鐘）
setInterval(autoCleanup, 5 * 60 * 1000);

// --- MIME ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

// --- Server ---
Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return;
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // REST API
    if (url.pathname === '/api/sessions') {
      return Response.json(sessions);
    }

    // 查詢連線中的 WebSocket 客戶端數
    if (url.pathname === '/api/clients') {
      return Response.json({ count: clients.size });
    }

    // 批次清理 stale sessions
    if (url.pathname === '/api/sessions/cleanup' && req.method === 'POST') {
      let cleaned = 0;
      for (const [sid, state] of Object.entries({ ...sessions })) {
        if (pct100(state) || isStaleSession(state)) {
          const fp = join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
          try { if (existsSync(fp)) unlinkSync(fp); } catch {}
          stopTimelineConsumer(sid);
          delete sessions[sid];
          cleaned++;
        }
      }
      if (cleaned > 0) broadcast({ type: 'update', sessions });
      return Response.json({ ok: true, cleaned });
    }

    // 刪除 session state 檔案
    if (url.pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const sid = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
      const fp = join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
      try {
        if (existsSync(fp)) unlinkSync(fp);
        // 停止 Timeline consumer
        stopTimelineConsumer(sid);
        // 無論檔案是否存在，都清除記憶體中的 session
        if (sessions[sid]) {
          delete sessions[sid];
          broadcast({ type: 'update', sessions });
        }
        return Response.json({ ok: true, deleted: sid });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // 靜態檔案
    const filePath = join(WEB_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    try {
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        return new Response(Bun.file(filePath), {
          headers: { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' },
        });
      }
    } catch { /* fall through */ }

    return new Response('Not Found', { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'init', sessions }));
      // 新連線重播所有 session 的歷史 timeline 事件
      for (const sid of Object.keys(sessions)) {
        try {
          const events = query(sid);
          for (const event of events) {
            const formatted = formatEvent(event, sid);
            ws.send(JSON.stringify({ type: 'timeline', sessionId: sid, event: formatted }));
          }
        } catch (_) { /* timeline 不存在時跳過 */ }
      }
    },
    close(ws) {
      clients.delete(ws);
    },
    message(ws, msg) {
      if (msg === 'ping') { try { ws.send('pong'); } catch {} }
    },
  },
});

// --- PID 管理 ---
try {
  const pidDir = join(homedir(), '.claude');
  if (!existsSync(pidDir)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(pidDir, { recursive: true });
  }
  writeFileSync(PID_FILE, JSON.stringify({
    pid: process.pid,
    port: PORT,
    startedAt: new Date().toISOString(),
  }));
} catch (_) { /* PID 寫入失敗不阻擋啟動 */ }

// --- 優雅關閉 ---
function shutdown() {
  // 停止所有 Timeline consumer
  for (const [sid, consumer] of timelineConsumers.entries()) {
    consumer.stop();
  }
  timelineConsumers.clear();

  // 關閉所有 WebSocket 連線
  for (const ws of clients) {
    try { ws.close(1001, 'Server shutting down'); } catch (_) {}
  }
  clients.clear();

  // 清理 PID 檔案
  try { unlinkSync(PID_FILE); } catch (_) {}

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// 取得區網 IP
import { networkInterfaces } from 'os';
const lanIP = Object.values(networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address;

console.log(`\n  🎯 Vibe Pipeline Dashboard`);
console.log(`  ─────────────────────────`);
console.log(`  PID:     ${process.pid}`);
console.log(`  Local:   http://localhost:${PORT}`);
if (lanIP) console.log(`  LAN:     http://${lanIP}:${PORT}`);
console.log(`  WS:      ws://localhost:${PORT}/ws`);
console.log(`  API:     http://localhost:${PORT}/api/sessions`);
console.log(`  ─────────────────────────`);
console.log(`  Watching: ${CLAUDE_DIR}/pipeline-state-*.json`);
console.log(`  Sessions: ${Object.keys(sessions).length} active\n`);
