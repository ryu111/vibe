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

// Task 1.1 / 1.2 / 1.3：從 registry.js 和 schema.js 讀取 metadata
const { STAGES, REFERENCE_PIPELINES } = require(`${import.meta.dir}/scripts/lib/registry.js`);
const { CATEGORIES } = require(`${import.meta.dir}/scripts/lib/timeline/schema.js`);

// Task 1.2：從 STAGES 動態建立 agent→emoji 映射
// registry.js 的 STAGES 涵蓋 9 個 pipeline stage agent，額外加入 pipeline-architect
const AGENT_EMOJI = {
  ...Object.fromEntries(
    Object.values(STAGES).map(cfg => [cfg.agent, cfg.emoji])
  ),
  'pipeline-architect': '📐',
};

// Task 1.3：從 CATEGORIES 動態建立 eventType→category 映射
// 優先序：pipeline > quality > agent > remote > safety > task > session
const CAT_PRIORITY = ['pipeline', 'quality', 'agent', 'remote', 'safety', 'task', 'session'];
const EVENT_TYPE_TO_CAT = {};
for (const catName of [...CAT_PRIORITY].reverse()) {
  const types = CATEGORIES[catName] || [];
  for (const t of types) {
    EVENT_TYPE_TO_CAT[t] = catName;
  }
}
// 向後相容覆寫：以下事件在前端視同 pipeline 分類（與原 eventCat() 行為一致）
// session.start、task.classified、prompt.received、task.incomplete 概念上屬於 pipeline 流程
for (const t of ['session.start', 'task.classified', 'prompt.received', 'task.incomplete']) {
  EVENT_TYPE_TO_CAT[t] = 'pipeline';
}

// Task 1.5：統一 stale 閾值常數（30 分鐘，與前端 sidebar 一致）
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

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
const ALIVE_THRESHOLD_MS = 120_000; // 2 分鐘內有 heartbeat = alive

/** 檢查 session 是否 alive（heartbeat 檔案 mtime 在閾值內） */
function isSessionAlive(sid) {
  try {
    const st = statSync(join(CLAUDE_DIR, `heartbeat-${sid}`));
    return (Date.now() - st.mtimeMs) < ALIVE_THRESHOLD_MS;
  } catch { return false; }
}

/** 取得所有 session 的 alive 狀態（掃描全部 heartbeat 檔案，不只有 pipeline-state 的） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function getAliveMap() {
  const map = {};
  try {
    for (const f of readdirSync(CLAUDE_DIR)) {
      if (!f.startsWith('heartbeat-')) continue;
      const sid = f.slice('heartbeat-'.length);
      if (!UUID_RE.test(sid)) continue; // 真正的 session ID 都是 UUID
      map[sid] = isSessionAlive(sid);
    }
  } catch {}
  return map;
}

/** 取得 session 的指標數據（counter + transcript 大小 + compact 次數） */
function getSessionMetrics(sid) {
  if (!UUID_RE.test(sid)) return null;
  const m = { toolCallCount: 0, contextPct: 0, transcriptSize: 0, sessionStartedAt: null, compactCount: 0 };
  try {
    const d = JSON.parse(readFileSync(join(CLAUDE_DIR, `flow-counter-${sid}.json`), 'utf8'));
    m.toolCallCount = d.count || 0;
    m.contextPct = Math.min(100, Math.round((d.count || 0) / 200 * 100));
  } catch {}
  try {
    const pd = join(CLAUDE_DIR, 'projects');
    for (const p of readdirSync(pd)) {
      const fp = join(pd, p, `${sid}.jsonl`);
      try {
        const st = statSync(fp);
        m.transcriptSize = st.size;
        m.sessionStartedAt = st.birthtime?.toISOString() || null;
        break;
      } catch {}
    }
  } catch {}
  // 從 timeline JSONL 直接讀取 compact.executed 事件數（WS replay 保證一致）
  try {
    const events = query(sid, { types: ['compact.executed'] });
    m.compactCount = events.length;
  } catch {}
  return m;
}

/** 批次取得所有 session 的指標（含 heartbeat-only sessions） */
function getAllSessionMetrics() {
  const out = {};
  const aliveMap = getAliveMap();
  const allSids = new Set([...Object.keys(sessions), ...Object.keys(aliveMap)]);
  for (const sid of allSids) {
    out[sid] = getSessionMetrics(sid);
  }
  return out;
}

/** 合併 alive sessions 的 pipeline state（heartbeat-only 也需要完整 state） */
function getMergedSessions() {
  const out = { ...sessions };
  const aliveMap = getAliveMap();
  for (const sid of Object.keys(aliveMap)) {
    if (!aliveMap[sid] || out[sid]) continue;
    try {
      const fp = join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
      if (existsSync(fp)) out[sid] = JSON.parse(readFileSync(fp, 'utf8'));
    } catch {}
  }
  return out;
}

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
    const sid = f.slice(15, -5);
    if (!UUID_RE.test(sid)) continue; // 過濾測試產生的非 UUID session
    try {
      const state = JSON.parse(readFileSync(join(CLAUDE_DIR, f), 'utf8'));
      if (isDisplayWorthy(state)) {
        out[sid] = state;
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
    const sid = f.slice(15, -5);
    if (!UUID_RE.test(sid)) continue; // 過濾測試產生的非 UUID session
    const fp = join(CLAUDE_DIR, f);
    try {
      const state = JSON.parse(readFileSync(fp, 'utf8'));
      // 空 session（無 DAG、無分類）且超過閾值 → 清理
      if (!isDisplayWorthy(state)) {
        const mtime = statSync(fp).mtimeMs;
        if (now - mtime > STALE_THRESHOLD_MS) {
          unlinkSync(fp);
          delete sessions[sid];
          stopTimelineConsumer(sid);
          changed = true;
        }
      }
    } catch { /* 忽略 */ }
  }
  if (changed) broadcast({ type: 'update', sessions: getMergedSessions(), metrics: getAllSessionMetrics() });
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(s); } catch { clients.delete(ws); }
  }
}

/** 事件類型→分類映射（前端 Tab 篩選用），動態從 schema.js CATEGORIES 生成 */
function eventCat(type) {
  return EVENT_TYPE_TO_CAT[type] || 'task';
}

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
  } else if (event.type === 'barrier.resolved') {
    type = d.verdict === 'FAIL' ? 'fail' : 'pass';
  } else if (event.type === 'barrier.waiting') {
    type = 'active';
  } else if (event.type === 'agent.crash') {
    type = 'fail';
  }

  return { time: t, ts: event.timestamp, type, cat: eventCat(event.type), emoji, text, eventType: event.type, tool: d.tool || null };
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
let pipelineTimer;
let barrierTimer;
let hbTimer;
if (existsSync(CLAUDE_DIR)) {
  watch(CLAUDE_DIR, (_, filename) => {
    // Heartbeat 檔案 → 廣播 alive 狀態（500ms 防抖，高頻操作）
    if (filename?.startsWith('heartbeat-')) {
      clearTimeout(hbTimer);
      hbTimer = setTimeout(() => {
        // Task 1.4：加入記憶體資訊供前端 Session Card 顯示
        const mem = process.memoryUsage();
        broadcast({
          type: 'heartbeat',
          alive: getAliveMap(),
          memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
          metrics: getAllSessionMetrics(),
        });
      }, 500);
      return;
    }
    // barrier-state 檔案變化 → 廣播 barrier 更新
    if (filename?.startsWith('barrier-state-') && filename.endsWith('.json')) {
      const sid = filename.slice('barrier-state-'.length, -5);
      if (UUID_RE.test(sid)) {
        clearTimeout(barrierTimer);
        barrierTimer = setTimeout(() => {
          const fp = join(CLAUDE_DIR, filename);
          try {
            const barrierState = existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf8')) : null;
            broadcast({ type: 'barrier', sessionId: sid, barrierState });
          } catch { /* 忽略 */ }
        }, 80);
      }
      return;
    }
    if (!filename?.startsWith('pipeline-state-') || !filename.endsWith('.json')) return;
    const sid = filename.slice(15, -5);
    if (!UUID_RE.test(sid)) return; // 過濾測試產生的非 UUID session
    clearTimeout(pipelineTimer);
    pipelineTimer = setTimeout(() => {
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
      broadcast({ type: 'update', sessions: getMergedSessions(), metrics: getAllSessionMetrics() });
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

/** 過期 session（30 分鐘無活動 + 未完成） */
function isStaleSession(state) {
  if (!state) return true;
  const last = state.meta?.lastTransition || state.lastTransition;
  if (!last) return true;
  return (Date.now() - new Date(last).getTime()) > STALE_THRESHOLD_MS;
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
      return Response.json(getMergedSessions());
    }

    // Task 1.1：registry 端點，提供 stages/pipelines/agents metadata 給前端
    if (url.pathname === '/api/registry') {
      // 轉換 STAGES 格式，確保 emoji unicode 正確序列化
      const stages = Object.fromEntries(
        Object.entries(STAGES).map(([id, cfg]) => [id, {
          agent: cfg.agent,
          emoji: cfg.emoji,
          label: cfg.label,
          color: cfg.color,
        }])
      );
      // 轉換 REFERENCE_PIPELINES 格式
      const pipelines = Object.fromEntries(
        Object.entries(REFERENCE_PIPELINES).map(([id, cfg]) => [id, {
          label: cfg.label,
          stages: cfg.stages,
          description: cfg.description,
          enforced: cfg.enforced,
        }])
      );
      // agents 列表：從 STAGES 取出所有 agent + 額外的 pipeline-architect
      const agentsFromStages = Object.values(STAGES).map(cfg => cfg.agent);
      const agents = [...agentsFromStages, 'pipeline-architect'];
      return Response.json({ stages, pipelines, agents });
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
      if (cleaned > 0) broadcast({ type: 'update', sessions: getMergedSessions(), metrics: getAllSessionMetrics() });
      return Response.json({ ok: true, cleaned });
    }

    // 刪除 session state 檔案
    if (url.pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const sid = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
      if (!UUID_RE.test(sid)) {
        return Response.json({ ok: false, error: 'invalid session id' }, { status: 400 });
      }
      const fp = join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
      try {
        if (existsSync(fp)) unlinkSync(fp);
        // 停止 Timeline consumer
        stopTimelineConsumer(sid);
        // 無論檔案是否存在，都清除記憶體中的 session
        if (sessions[sid]) {
          delete sessions[sid];
          broadcast({ type: 'update', sessions: getMergedSessions(), metrics: getAllSessionMetrics() });
        }
        return Response.json({ ok: true, deleted: sid });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // 靜態檔案（路徑遍歷防護：resolved path 必須在 WEB_DIR 內）
    const filePath = join(WEB_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    try {
      if (!filePath.startsWith(WEB_DIR + '/') && filePath !== WEB_DIR) {
        return new Response('Forbidden', { status: 403 });
      }
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
      ws.send(JSON.stringify({ type: 'init', sessions: getMergedSessions(), alive: getAliveMap(), metrics: getAllSessionMetrics() }));
      // 新連線重播所有 session 的歷史 timeline 事件（含 heartbeat-only sessions）
      for (const sid of Object.keys(getMergedSessions())) {
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
