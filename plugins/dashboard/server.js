#!/usr/bin/env bun
/**
 * Vibe Pipeline Dashboard — POC Server
 * Bun HTTP + WebSocket，監聽 pipeline state 檔案即時推播
 */
import { watch, readFileSync, readdirSync, existsSync, statSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';

const PORT = Number(process.env.VIBE_DASHBOARD_PORT) || 3800;
const CLAUDE_DIR = join(homedir(), '.claude');
const WEB_DIR = join(import.meta.dir, 'web');

// --- State ---
let sessions = {};
const clients = new Set();

function scanSessions() {
  if (!existsSync(CLAUDE_DIR)) return {};
  const out = {};
  for (const f of readdirSync(CLAUDE_DIR)) {
    if (!f.startsWith('pipeline-state-') || !f.endsWith('.json')) continue;
    try {
      out[f.slice(15, -5)] = JSON.parse(readFileSync(join(CLAUDE_DIR, f), 'utf8'));
    } catch { /* 忽略損壞檔案 */ }
  }
  return out;
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(s); } catch { clients.delete(ws); }
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
          sessions[sid] = JSON.parse(readFileSync(fp, 'utf8'));
        } else {
          delete sessions[sid];
        }
      } catch { /* 忽略 */ }
      broadcast({ type: 'update', sessions });
    }, 80);
  });
}

sessions = scanSessions();

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

    // 刪除 session state 檔案
    if (url.pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const sid = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
      const fp = join(CLAUDE_DIR, `pipeline-state-${sid}.json`);
      try {
        if (existsSync(fp)) {
          unlinkSync(fp);
          delete sessions[sid];
          broadcast({ type: 'update', sessions });
          return Response.json({ ok: true, deleted: sid });
        }
        return Response.json({ ok: false, error: 'not found' }, { status: 404 });
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
    },
    close(ws) {
      clients.delete(ws);
    },
    message(ws, msg) {
      if (msg === 'ping') { try { ws.send('pong'); } catch {} }
    },
  },
});

// 取得區網 IP
import { networkInterfaces } from 'os';
const lanIP = Object.values(networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address;

console.log(`\n  🎯 Vibe Pipeline Dashboard`);
console.log(`  ─────────────────────────`);
console.log(`  Local:   http://localhost:${PORT}`);
if (lanIP) console.log(`  LAN:     http://${lanIP}:${PORT}`);
console.log(`  WS:      ws://localhost:${PORT}/ws`);
console.log(`  API:     http://localhost:${PORT}/api/sessions`);
console.log(`  ─────────────────────────`);
console.log(`  Watching: ${CLAUDE_DIR}/pipeline-state-*.json`);
console.log(`  Sessions: ${Object.keys(sessions).length} active\n`);
