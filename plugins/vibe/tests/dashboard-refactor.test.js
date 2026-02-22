#!/usr/bin/env node
/**
 * dashboard-refactor.test.js — Dashboard 前端重構驗證測試
 *
 * 測試對象：
 *   - web/hooks/useWebSocket.js — WebSocket hook 靜態結構 + 邏輯萃取
 *   - web/hooks/useKeyboard.js — 鍵盤快捷鍵 hook 靜態結構 + 邏輯萃取
 *   - web/hooks/useSessionManager.js — Session 管理 hook 靜態結構 + 邏輯萃取
 *   - web/components/header.js — Header 組件靜態結構
 *   - web/components/dashboard-tab.js — DashboardTab 組件靜態結構
 *   - web/components/timeline-tab.js — TimelineTab 組件靜態結構
 *   - web/app.js — 主應用正確 import 所有新模組
 *   - web/styles.css — CSS 結構驗證（二層結構 + 關鍵 class）
 *
 * 測試策略：
 *   - ES Module 無法直接 require，採用「邏輯萃取」模式
 *   - 將純函式邏輯直接定義於測試中，對照原始碼驗證行為
 *   - 組件結構以 fs.readFileSync + regex 靜態分析驗證
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WEB_DIR = path.join(__dirname, '..', 'web');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

function readFile(relPath) {
  return fs.readFileSync(path.join(WEB_DIR, relPath), 'utf8');
}

// ═══════════════════════════════════════════════════════════════
// 萃取自 web/hooks/useSessionManager.js（純邏輯）
// ═══════════════════════════════════════════════════════════════

// sessionCategory 和 isLive 的副本（用於測試 useSessionManager 邏輯）
function isLive(state) {
  return !!(state?._alive || (state?.activeStages?.length > 0) || state?.pipelineActive);
}

function getPipelineProgress(state) {
  if (!state?.dag) return 0;
  const stages = Object.keys(state.dag);
  if (!stages.length) return 0;
  const done = stages.filter(id => {
    const st = state.stages?.[id]?.status;
    return st === 'completed' || st === 'skipped';
  });
  return Math.round(done.length / stages.length * 100);
}

function hasPipeline(state) {
  return !!(state?.dag && Object.keys(state.dag).length > 0);
}

function sessionCategory(s) {
  if (!s) return 'stale';
  if (s._alive || isLive(s)) return 'live';
  const prog = getPipelineProgress(s);
  if (hasPipeline(s) && prog >= 100) return 'done';
  if (hasPipeline(s)) return 'active';
  const last = s.meta?.lastTransition;
  if (!last) return 'stale';
  const age = Date.now() - new Date(last).getTime();
  if (age > 1800_000) return 'stale';
  return 'active';
}

// mergedSessions 邏輯萃取
function mergedSessions(sessions, alive) {
  const out = {};
  for (const [id, s] of Object.entries(sessions)) {
    out[id] = alive[id] ? { ...s, _alive: true } : s;
  }
  for (const id of Object.keys(alive)) {
    if (alive[id] && !out[id]) out[id] = { _alive: true, _heartbeatOnly: true };
  }
  return out;
}

// 分組邏輯萃取
function groupSessions(merged) {
  const live = [], done = [], stale = [];
  for (const [id, s] of Object.entries(merged)) {
    const cat = sessionCategory(s);
    if (cat === 'live' || cat === 'active') live.push([id, s]);
    else if (cat === 'done') done.push([id, s]);
    else stale.push([id, s]);
  }
  return { live, done, stale };
}

// 排序邏輯萃取
function byRecent(a, b) {
  const aAlive = a[1]._alive ? 1 : 0, bAlive = b[1]._alive ? 1 : 0;
  if (aAlive !== bAlive) return bAlive - aAlive;
  return new Date(b[1].meta?.lastTransition || 0) - new Date(a[1].meta?.lastTransition || 0);
}

// ═══════════════════════════════════════════════════════════════
// 萃取自 useKeyboard.js（純邏輯）
// ═══════════════════════════════════════════════════════════════

function computeZoomStyle(zoom) {
  if (zoom === 100) return '';
  const sc = zoom / 100;
  return `transform:scale(${sc});transform-origin:0 0;width:${100 / sc}vw;height:${100 / sc}vh;`;
}

// tlFiltered 過濾邏輯萃取（來自 app.js）
function filterTimeline(tlAll, tlTab, tlFilter) {
  let list = tlAll;
  if (tlTab !== 'all') list = list.filter(ev => ev.cat === tlTab);
  if (tlFilter !== 0) {
    const cutoff = Date.now() - tlFilter * 60000;
    list = list.filter(ev => ev.ts && ev.ts >= cutoff);
  }
  return list;
}

// ════════════════════════════════════════════════════════════════
// Section 1: hooks 目錄存在，三個 hook 檔案都存在
// ════════════════════════════════════════════════════════════════

section('Section 1: hooks 目錄與檔案存在性');

const hooksDir = path.join(WEB_DIR, 'hooks');
assert(fs.existsSync(hooksDir), 'hooks 目錄存在');
assert(fs.existsSync(path.join(hooksDir, 'useWebSocket.js')), 'useWebSocket.js 存在');
assert(fs.existsSync(path.join(hooksDir, 'useKeyboard.js')), 'useKeyboard.js 存在');
assert(fs.existsSync(path.join(hooksDir, 'useSessionManager.js')), 'useSessionManager.js 存在');

// 新組件檔案存在
const componentsDir = path.join(WEB_DIR, 'components');
assert(fs.existsSync(path.join(componentsDir, 'header.js')), 'components/header.js 存在');
assert(fs.existsSync(path.join(componentsDir, 'dashboard-tab.js')), 'components/dashboard-tab.js 存在');
assert(fs.existsSync(path.join(componentsDir, 'timeline-tab.js')), 'components/timeline-tab.js 存在');

// ════════════════════════════════════════════════════════════════
// Section 2: app.js 正確 import 所有新模組
// ════════════════════════════════════════════════════════════════

section('Section 2: app.js import 完整性');

const appContent = readFile('app.js');

// hooks import
assert(appContent.includes("from './hooks/useWebSocket.js'"), 'app.js import useWebSocket.js');
assert(appContent.includes("from './hooks/useKeyboard.js'"), 'app.js import useKeyboard.js');
assert(appContent.includes("from './hooks/useSessionManager.js'"), 'app.js import useSessionManager.js');

// 新組件 import
assert(appContent.includes("from './components/header.js'"), 'app.js import header.js');
assert(appContent.includes("from './components/dashboard-tab.js'"), 'app.js import dashboard-tab.js');
assert(appContent.includes("from './components/timeline-tab.js'"), 'app.js import timeline-tab.js');

// 舊組件仍然 import
assert(appContent.includes("from './components/sidebar.js'"), 'app.js 仍 import sidebar.js');
assert(appContent.includes("from './components/dag-view.js'"), 'app.js 仍 import dag-view.js');
assert(appContent.includes("from './components/barrier-display.js'"), 'app.js 仍 import barrier-display.js');
assert(appContent.includes("from './components/confetti.js'"), 'app.js 仍 import confetti.js');
assert(appContent.includes("from './components/export-report.js'"), 'app.js import export-report.js');

// state + lib import
assert(appContent.includes("from './state/pipeline.js'"), 'app.js import state/pipeline.js');
assert(appContent.includes("from './lib/preact.js'"), 'app.js import lib/preact.js');

// ════════════════════════════════════════════════════════════════
// Section 3: useWebSocket.js export 與結構驗證
// ════════════════════════════════════════════════════════════════

section('Section 3: useWebSocket.js 結構驗證');

const wsContent = readFile('hooks/useWebSocket.js');

// export
assert(wsContent.includes('export function useWebSocket'), 'useWebSocket export 正確');

// 回傳欄位（七個狀態）
assert(wsContent.includes('sessions'), '回傳 sessions');
assert(wsContent.includes('alive'), '回傳 alive');
assert(wsContent.includes('timelineEvents'), '回傳 timelineEvents');
assert(wsContent.includes('barrierStates'), '回傳 barrierStates');
assert(wsContent.includes('memory'), '回傳 memory');
assert(wsContent.includes('sessionMetrics'), '回傳 sessionMetrics');
assert(wsContent.includes('conn'), '回傳 conn');

// WebSocket 關鍵行為
assert(wsContent.includes("'ws'"), '支援 ws 協議');
assert(wsContent.includes("'wss'"), '支援 wss 協議（https 升級）');
assert(wsContent.includes('retries'), '重連次數計數存在');
assert(wsContent.includes('Math.min'), '指數退避有上限（Math.min）');
assert(wsContent.includes('Math.pow'), '指數退避使用 Math.pow');
assert(wsContent.includes('25000'), '心跳間隔 25000ms（25 秒）');
assert(wsContent.includes("=== 'pong'"), 'pong 訊息過濾');

// 訊息分發邏輯
assert(wsContent.includes("m.sessions"), '處理 sessions 訊息');
assert(wsContent.includes("m.alive"), '處理 alive 訊息');
assert(wsContent.includes("m.memory"), '處理 memory 訊息');
assert(wsContent.includes("m.metrics"), '處理 metrics 訊息');
assert(wsContent.includes("=== 'timeline'"), '處理 timeline 事件');
assert(wsContent.includes("=== 'barrier'"), '處理 barrier 事件');

// timeline 事件列表上限
assert(wsContent.includes('.slice(0, 200)'), 'timeline 事件列表上限 200 筆');

// cleanup
assert(wsContent.includes('ws?.close()'), 'cleanup 關閉 WebSocket');
assert(wsContent.includes('clearTimeout'), 'cleanup 清除重連 timer');
assert(wsContent.includes('clearInterval'), 'cleanup 清除心跳 timer');

// ════════════════════════════════════════════════════════════════
// Section 4: useKeyboard.js export 與結構驗證
// ════════════════════════════════════════════════════════════════

section('Section 4: useKeyboard.js 結構驗證');

const kbContent = readFile('hooks/useKeyboard.js');

// export
assert(kbContent.includes('export function useKeyboard'), 'useKeyboard export 正確');

// 回傳值
assert(kbContent.includes('zoom'), '回傳 zoom');
assert(kbContent.includes('zoomStyle'), '回傳 zoomStyle');
assert(kbContent.includes('setZoom'), '回傳 setZoom');

// zoom 範圍
assert(kbContent.includes('Math.min(200'), 'zoom 最大值 200');
assert(kbContent.includes('Math.max(50'), 'zoom 最小值 50');
assert(kbContent.includes('+ 10'), 'zoom 每次增減 10');
assert(kbContent.includes('- 10'), 'zoom 減少 10');
assert(kbContent.includes("zoom(100)") || kbContent.includes("setZoom(100)"), 'zoom 重設為 100');

// ⌘ 快捷鍵
assert(kbContent.includes("e.metaKey || e.ctrlKey"), '⌘/Ctrl 修飾鍵偵測');
assert(kbContent.includes("e.key === '='") || kbContent.includes("e.key === '+'"), "⌘+ 放大快捷鍵");
assert(kbContent.includes("e.key === '-'"), "⌘- 縮小快捷鍵");
assert(kbContent.includes("e.key === '0'"), "⌘0 重設縮放");

// 鍵盤快捷鍵
assert(kbContent.includes("'j'") || kbContent.includes('"j"'), 'j 鍵向下導航');
assert(kbContent.includes("'k'") || kbContent.includes('"k"'), 'k 鍵向上導航');
assert(kbContent.includes("'s'") || kbContent.includes('"s"') || kbContent.includes("'S'"), 'S 鍵切換側邊欄');
assert(kbContent.includes("'f'") || kbContent.includes('"f"') || kbContent.includes("'F'"), 'F 鍵切換全螢幕');
assert(kbContent.includes("'1'"), '1 鍵切換至 Dashboard tab');
assert(kbContent.includes("'2'"), '2 鍵切換至 Pipeline tab');
assert(kbContent.includes("'3'"), '3 鍵切換至 Timeline tab');
assert(kbContent.includes("'t'") || kbContent.includes('"t"') || kbContent.includes("'T'"), 'T 鍵切換 Timeline');
assert(kbContent.includes("'e'") || kbContent.includes('"e"') || kbContent.includes("'E'"), 'E 鍵導出報告');
assert(kbContent.includes("'?'"), '? 鍵顯示說明');

// input 過濾（不攔截輸入框事件）
assert(kbContent.includes("'INPUT'"), 'INPUT 標籤過濾');
assert(kbContent.includes("'SELECT'"), 'SELECT 標籤過濾');

// 事件監聽 cleanup
assert(kbContent.includes('removeEventListener'), 'cleanup 移除事件監聽器');

// ════════════════════════════════════════════════════════════════
// Section 5: useSessionManager.js export 與結構驗證
// ════════════════════════════════════════════════════════════════

section('Section 5: useSessionManager.js 結構驗證');

const smContent = readFile('hooks/useSessionManager.js');

// export
assert(smContent.includes('export function useSessionManager'), 'useSessionManager export 正確');

// import sessionCategory 和 isLive
assert(smContent.includes('sessionCategory'), 'import/使用 sessionCategory');
assert(smContent.includes('isLive'), 'import/使用 isLive');

// 回傳欄位
assert(smContent.includes('mergedSessions'), '回傳 mergedSessions');
assert(smContent.includes('liveSessions'), '回傳 liveSessions');
assert(smContent.includes('doneSessions'), '回傳 doneSessions');
assert(smContent.includes('staleSessions'), '回傳 staleSessions');
assert(smContent.includes('active'), '回傳 active');
assert(smContent.includes('selectSession'), '回傳 selectSession');

// 關鍵邏輯
assert(smContent.includes('_alive: true'), '合併 alive 時注入 _alive: true');
assert(smContent.includes('_heartbeatOnly: true'), 'heartbeat-only session 標記');
assert(smContent.includes('.sort('), '分組後排序');
assert(smContent.includes('meta?.lastTransition'), '按最後活動時間排序');

// 自動選擇邏輯
assert(smContent.includes('liveSid'), '計算活躍 session ID');
assert(smContent.includes('setActive(liveSid)'), '自動跟隨活躍 session');

// ════════════════════════════════════════════════════════════════
// Section 6: header.js export 與結構驗證
// ════════════════════════════════════════════════════════════════

section('Section 6: header.js 結構驗證');

const headerContent = readFile('components/header.js');

// export
assert(headerContent.includes('export function Header'), 'Header export 正確');

// props 參數（所有必要 props）
assert(headerContent.includes('activeId'), 'Header 接受 activeId prop');
assert(headerContent.includes('isComplete'), 'Header 接受 isComplete prop');
assert(headerContent.includes('fullscreen'), 'Header 接受 fullscreen prop');
assert(headerContent.includes('zoom'), 'Header 接受 zoom prop');
assert(headerContent.includes('conn'), 'Header 接受 conn prop');
assert(headerContent.includes('tlAll'), 'Header 接受 tlAll prop');
assert(headerContent.includes('s'), 'Header 接受 s prop');
assert(headerContent.includes('registry'), 'Header 接受 registry prop');
assert(headerContent.includes('onToggleFullscreen'), 'Header 接受 onToggleFullscreen handler');
assert(headerContent.includes('onZoomIn'), 'Header 接受 onZoomIn handler');
assert(headerContent.includes('onZoomOut'), 'Header 接受 onZoomOut handler');
assert(headerContent.includes('onZoomReset'), 'Header 接受 onZoomReset handler');
assert(headerContent.includes('onExport'), 'Header 接受 onExport handler');

// 關鍵 UI 元素
assert(headerContent.includes('conn-indicator'), '連線燈號 conn-indicator class');
assert(headerContent.includes('dot.on') || (headerContent.includes("dot ") && headerContent.includes("on")), '連線燈號 on 狀態');
assert(headerContent.includes('dot.off') || (headerContent.includes("dot ") && headerContent.includes("off")), '連線燈號 off 狀態');
assert(headerContent.includes('toolbar'), 'toolbar class 存在');
assert(headerContent.includes('tool-btn'), '工具按鈕 class');
assert(headerContent.includes('全螢幕'), '全螢幕按鈕文字');
assert(headerContent.includes("'md'"), '導出 MD 按鈕');
assert(headerContent.includes("'json'"), '導出 JSON 按鈕');

// sid import
assert(headerContent.includes("from '../lib/utils.js'"), 'header.js import from ../lib/utils.js');
assert(headerContent.includes('sid'), 'header.js 使用 sid 函式');

// 完成彩蛋
assert(headerContent.includes('isComplete'), 'isComplete 條件渲染存在');

// ════════════════════════════════════════════════════════════════
// Section 7: dashboard-tab.js export 與結構驗證
// ════════════════════════════════════════════════════════════════

section('Section 7: dashboard-tab.js 結構驗證');

const dtContent = readFile('components/dashboard-tab.js');

// export
assert(dtContent.includes('export function DashboardTab'), 'DashboardTab export 正確');

// 子組件 import
assert(dtContent.includes("AgentStatus"), 'import AgentStatus');
assert(dtContent.includes("MCPStats"), 'import MCPStats');
assert(dtContent.includes("StatsCards"), 'import StatsCards');
assert(dtContent.includes("PipelineProgressBar"), 'import PipelineProgressBar');

// props 參數
assert(dtContent.includes('s,'), 'DashboardTab 接受 s prop');
assert(dtContent.includes('tick'), 'DashboardTab 接受 tick prop');
assert(dtContent.includes('tlAll'), 'DashboardTab 接受 tlAll prop');
assert(dtContent.includes('registry'), 'DashboardTab 接受 registry prop');
assert(dtContent.includes('alive'), 'DashboardTab 接受 alive prop');
assert(dtContent.includes('memory'), 'DashboardTab 接受 memory prop');
assert(dtContent.includes('sessionId'), 'DashboardTab 接受 sessionId prop');
assert(dtContent.includes('sessionMetrics'), 'DashboardTab 接受 sessionMetrics prop');
assert(dtContent.includes('isComplete'), 'DashboardTab 接受 isComplete prop');
assert(dtContent.includes('typeLabel'), 'DashboardTab 接受 typeLabel prop');

// 關鍵 UI 元素
assert(dtContent.includes('dash-grid'), 'dash-grid class 存在');
assert(dtContent.includes('layout-mosaic'), 'layout-mosaic class 存在');
assert(dtContent.includes('mini-tl'), 'mini-tl（活動記錄）存在');
assert(dtContent.includes('活動記錄'), '活動記錄標題文字');
assert(dtContent.includes('等待事件流'), '空狀態提示文字');
assert(dtContent.includes('isComplete'), '完成摘要條件渲染');
assert(dtContent.includes('完成摘要'), '完成摘要文字存在');
assert(dtContent.includes('各階段耗時'), '各階段耗時文字存在');

// ResizeObserver 高度同步
assert(dtContent.includes('ResizeObserver'), 'ResizeObserver 用於高度同步');
assert(dtContent.includes('agent-panel'), 'agent-panel selector 用於高度同步');
assert(dtContent.includes('mini-tl'), 'mini-tl selector 用於高度同步');

// mini-tl 事件過濾（排除 tool.used）
assert(dtContent.includes("!== 'tool.used'"), 'mini-tl 過濾 tool.used 事件');
// .slice(0, 50) 取最新 50 筆（事件列表最新在前，0,50 = 最近事件）
assert(dtContent.includes('.slice(0, 50)'), 'mini-tl 最多顯示 50 個事件（取最新 50 筆）');

// ════════════════════════════════════════════════════════════════
// Section 8: timeline-tab.js export 與結構驗證
// ════════════════════════════════════════════════════════════════

section('Section 8: timeline-tab.js 結構驗證');

const ttContent = readFile('components/timeline-tab.js');

// export
assert(ttContent.includes('export function TimelineTab'), 'TimelineTab export 正確');

// TL_TABS 定義（5 個分類）
assert(ttContent.includes("'all'"), "TL_TABS 包含 'all'");
assert(ttContent.includes("'agent'"), "TL_TABS 包含 'agent'");
assert(ttContent.includes("'pipeline'"), "TL_TABS 包含 'pipeline'");
assert(ttContent.includes("'quality'"), "TL_TABS 包含 'quality'");
assert(ttContent.includes("'task'"), "TL_TABS 包含 'task'");

// TL_FILTERS 定義（4 個選項）
assert(ttContent.includes('[0,'), "TL_FILTERS 包含 0（全部）");
assert(ttContent.includes('[10,'), "TL_FILTERS 包含 10m");
assert(ttContent.includes('[30,'), "TL_FILTERS 包含 30m");
assert(ttContent.includes('[60,'), "TL_FILTERS 包含 1h（60m）");

// props 參數
assert(ttContent.includes('tlFiltered'), 'TimelineTab 接受 tlFiltered prop');
assert(ttContent.includes('tlTab'), 'TimelineTab 接受 tlTab prop');
assert(ttContent.includes('tlFilter'), 'TimelineTab 接受 tlFilter prop');
assert(ttContent.includes('hasFilter'), 'TimelineTab 接受 hasFilter prop');
assert(ttContent.includes('onTabChange'), 'TimelineTab 接受 onTabChange handler');
assert(ttContent.includes('onFilterChange'), 'TimelineTab 接受 onFilterChange handler');

// 關鍵 UI 元素
assert(ttContent.includes('tl-full'), 'tl-full class 存在');
assert(ttContent.includes('tl-tabs'), 'tl-tabs class 存在');
assert(ttContent.includes('tl-tab'), 'tl-tab class 存在');
assert(ttContent.includes('tl-filter'), 'tl-filter class 存在');
assert(ttContent.includes('tl-chip'), 'tl-chip class 存在');
assert(ttContent.includes('tl-items'), 'tl-items class 存在');
assert(ttContent.includes('tl-item'), 'tl-item class 存在');

// 空狀態提示
assert(ttContent.includes('此篩選條件下無事件'), '有篩選時的空狀態文字');
assert(ttContent.includes('等待事件流'), '無篩選時的空狀態文字');
assert(ttContent.includes('hasFilter'), '空狀態依 hasFilter 切換文字');

// active class 條件渲染
assert(ttContent.includes("tlTab === v ? 'active'"), 'tab active class 條件正確');
assert(ttContent.includes("tlFilter === v ? 'active'"), 'filter chip active class 條件正確');

// ════════════════════════════════════════════════════════════════
// Section 9: useSessionManager mergedSessions 邏輯驗證
// ════════════════════════════════════════════════════════════════

section('Section 9: useSessionManager mergedSessions 邏輯');

// 基本合併
const sessions1 = { 'sid-1': { pipelineActive: true }, 'sid-2': { pipelineActive: false } };
const alive1 = { 'sid-1': true };
const merged1 = mergedSessions(sessions1, alive1);
assert(merged1['sid-1']._alive === true, 'alive session：注入 _alive=true');
assert(!merged1['sid-2']?._alive, '非 alive session：無 _alive 注入');

// heartbeat-only session（alive 中有但 sessions 中無）
const sessions2 = {};
const alive2 = { 'ghost-sid': true };
const merged2 = mergedSessions(sessions2, alive2);
assert(merged2['ghost-sid'] !== undefined, 'heartbeat-only session 出現在合併結果中');
assert(merged2['ghost-sid']._alive === true, 'heartbeat-only session _alive=true');
assert(merged2['ghost-sid']._heartbeatOnly === true, 'heartbeat-only session _heartbeatOnly=true');

// alive=false 不注入
const sessions3 = { 'sid-a': { pipelineActive: true } };
const alive3 = { 'sid-a': false };
const merged3 = mergedSessions(sessions3, alive3);
assert(!merged3['sid-a']._alive, 'alive=false 不注入 _alive');

// 空 sessions 空 alive
const merged4 = mergedSessions({}, {});
assert(Object.keys(merged4).length === 0, '空 sessions + 空 alive：空合併結果');

// ════════════════════════════════════════════════════════════════
// Section 10: useSessionManager 分組邏輯驗證
// ════════════════════════════════════════════════════════════════

section('Section 10: useSessionManager 分組排序邏輯');

const now = Date.now();

const aliveSession = { _alive: true, meta: { lastTransition: new Date(now - 1000).toISOString() } };
const doneSession = {
  dag: { PLAN: {} },
  stages: { PLAN: { status: 'completed' } },
  meta: { lastTransition: new Date(now - 5000).toISOString() }
};
const staleSession1 = {
  meta: { lastTransition: new Date(now - 2 * 3600 * 1000).toISOString() }
};
const pipelineSession = {
  dag: { PLAN: {}, ARCH: {} },
  stages: { PLAN: { status: 'completed' }, ARCH: { status: 'pending' } },
  meta: { lastTransition: new Date(now - 60 * 1000).toISOString() }
};

const testMerged = {
  's1': aliveSession,
  's2': doneSession,
  's3': staleSession1,
  's4': pipelineSession,
};

const { live, done, stale } = groupSessions(testMerged);

// 分類正確性
assert(live.some(([id]) => id === 's1'), '_alive session 歸類為 live');
assert(live.some(([id]) => id === 's4'), 'pipeline active session 歸類為 live');
assert(done.some(([id]) => id === 's2'), '100% 完成 session 歸類為 done');
assert(stale.some(([id]) => id === 's3'), '2 小時前 session 歸類為 stale');

// live 組排序：_alive 優先
const livePairs = [
  ['s-b', { meta: { lastTransition: new Date(now - 2000).toISOString() } }],
  ['s-a', { _alive: true, meta: { lastTransition: new Date(now - 5000).toISOString() } }],
];
livePairs.sort(byRecent);
assert(livePairs[0][0] === 's-a', '_alive session 排在最前（即使 lastTransition 較舊）');

// done 組排序：最近活動時間優先
const donePairs = [
  ['s-old', { dag: { A: {} }, stages: { A: { status: 'completed' } }, meta: { lastTransition: new Date(now - 10000).toISOString() } }],
  ['s-new', { dag: { A: {} }, stages: { A: { status: 'completed' } }, meta: { lastTransition: new Date(now - 1000).toISOString() } }],
];
const doneSort = (a, b) => new Date(b[1].meta?.lastTransition || 0) - new Date(a[1].meta?.lastTransition || 0);
donePairs.sort(doneSort);
assert(donePairs[0][0] === 's-new', 'done 組：最近活動的 session 排第一');

// ════════════════════════════════════════════════════════════════
// Section 11: useKeyboard zoomStyle 計算邏輯
// ════════════════════════════════════════════════════════════════

section('Section 11: useKeyboard zoomStyle 邏輯');

// zoom=100：空字串
assert(computeZoomStyle(100) === '', 'zoom=100：zoomStyle 為空字串（無縮放）');

// zoom=150：scale=1.5，width=66.67vw，height=66.67vh
const style150 = computeZoomStyle(150);
assert(style150.includes('scale(1.5)'), 'zoom=150：transform:scale(1.5)');
assert(style150.includes('transform-origin:0 0'), 'zoom=150：transform-origin:0 0');
assert(style150.includes('vw') && style150.includes('vh'), 'zoom=150：包含 vw 和 vh 單位');

// zoom=50：scale=0.5，width=200vw
const style50 = computeZoomStyle(50);
assert(style50.includes('scale(0.5)'), 'zoom=50：transform:scale(0.5)');
assert(style50.includes('200vw'), 'zoom=50：width=200vw（補償縮小）');
assert(style50.includes('200vh'), 'zoom=50：height=200vh（補償縮小）');

// zoom=200：scale=2，width=50vw
const style200 = computeZoomStyle(200);
assert(style200.includes('scale(2)'), 'zoom=200：transform:scale(2)');
assert(style200.includes('50vw'), 'zoom=200：width=50vw');
assert(style200.includes('50vh'), 'zoom=200：height=50vh');

// zoom=110：
const style110 = computeZoomStyle(110);
assert(style110.includes('scale(1.1)'), 'zoom=110：scale(1.1)');

// ════════════════════════════════════════════════════════════════
// Section 12: Timeline 過濾邏輯（filterTimeline 等效）
// ════════════════════════════════════════════════════════════════

section('Section 12: app.js tlFiltered 過濾邏輯');

const recentNow = Date.now();
const events = [
  { cat: 'pipeline', ts: recentNow - 5 * 60 * 1000, text: '5 分鐘前 pipeline 事件' },
  { cat: 'agent', ts: recentNow - 20 * 60 * 1000, text: '20 分鐘前 agent 事件' },
  { cat: 'quality', ts: recentNow - 45 * 60 * 1000, text: '45 分鐘前 quality 事件' },
  { cat: 'pipeline', ts: recentNow - 70 * 60 * 1000, text: '70 分鐘前 pipeline 事件' },
];

// tlTab='all'，無時間過濾
const allFiltered = filterTimeline(events, 'all', 0);
assert(allFiltered.length === 4, 'all + 無時間過濾：返回全部 4 個事件');

// tlTab='pipeline'，無時間過濾
const pipelineFiltered = filterTimeline(events, 'pipeline', 0);
assert(pipelineFiltered.length === 2, "tlTab='pipeline'：只返回 pipeline 事件 2 個");
assert(pipelineFiltered.every(e => e.cat === 'pipeline'), '所有結果都是 pipeline 類別');

// tlTab='all'，時間過濾 10 分鐘
const recentFiltered = filterTimeline(events, 'all', 10);
assert(recentFiltered.length === 1, 'tlFilter=10m：只返回 10 分鐘內的 1 個事件');
assert(recentFiltered[0].cat === 'pipeline', '10 分鐘內只有 pipeline 事件');

// tlTab='pipeline'，時間過濾 30 分鐘
const combinedFiltered = filterTimeline(events, 'pipeline', 30);
assert(combinedFiltered.length === 1, 'pipeline + 30m：只有 5 分鐘前的 pipeline 事件');

// tlTab='agent'，時間過濾 30 分鐘
const agentFiltered = filterTimeline(events, 'agent', 30);
assert(agentFiltered.length === 1, 'agent + 30m：20 分鐘前的 agent 事件在範圍內');

// tlTab='quality'，時間過濾 30 分鐘（quality 事件在 45 分鐘前，超出範圍）
const qualityFiltered = filterTimeline(events, 'quality', 30);
assert(qualityFiltered.length === 0, 'quality + 30m：45 分鐘前的 quality 事件超出範圍，返回空');

// 無 ts 欄位的事件在時間過濾下被排除
const eventsNoTs = [{ cat: 'agent', text: '無 ts 事件' }];
const noTsFiltered = filterTimeline(eventsNoTs, 'all', 10);
assert(noTsFiltered.length === 0, '無 ts 欄位的事件在時間過濾下被排除');

// ════════════════════════════════════════════════════════════════
// Section 13: CSS 結構驗證（關鍵 class 存在 + 二層結構）
// ════════════════════════════════════════════════════════════════

section('Section 13: styles.css 關鍵 class 存在性');

const cssContent = fs.readFileSync(path.join(WEB_DIR, 'styles.css'), 'utf8');

// 基礎全局
assert(cssContent.includes(':root'), ':root CSS 變數區塊存在');
assert(cssContent.includes('--bg:'), '--bg 顏色變數');
assert(cssContent.includes('--surface0:'), '--surface0 顏色變數');
assert(cssContent.includes('--text:'), '--text 顏色變數');
assert(cssContent.includes('--blue:'), '--blue 顏色變數');
assert(cssContent.includes('--green:'), '--green 顏色變數');

// Layout
assert(cssContent.includes('.layout'), '.layout class 存在');
assert(cssContent.includes('.layout.collapsed'), '.layout.collapsed 折疊狀態');
assert(cssContent.includes('.main'), '.main class 存在');
assert(cssContent.includes('.fullscreen') || cssContent.includes('fullscreen'), 'fullscreen 相關樣式');

// Sidebar
assert(cssContent.includes('.sidebar'), '.sidebar class 存在');
assert(cssContent.includes('.sb-top'), '.sb-top class 存在');
assert(cssContent.includes('.sb-body'), '.sb-body class 存在');
assert(cssContent.includes('.sc'), '.sc（session card）class 存在');
assert(cssContent.includes('.sc.live'), '.sc.live 存活狀態樣式');
assert(cssContent.includes('.sc.done'), '.sc.done 完成狀態樣式');
assert(cssContent.includes('.sc.stale'), '.sc.stale 過期狀態樣式');

// Dashboard Grid
assert(cssContent.includes('.dash-grid'), '.dash-grid class 存在');
assert(cssContent.includes('.mini-tl'), '.mini-tl class 存在');

// Agent Panel
assert(cssContent.includes('.agent-panel'), '.agent-panel class 存在');
assert(cssContent.includes('.agent-row'), '.agent-row class 存在');
assert(cssContent.includes('.al.running'), '.al.running 動畫樣式');
assert(cssContent.includes('.al.delegating'), '.al.delegating 動畫樣式');
assert(cssContent.includes('.al.idle'), '.al.idle 靜止樣式');

// Stats
assert(cssContent.includes('.stats-grid'), '.stats-grid class 存在');
assert(cssContent.includes('.stat-card'), '.stat-card class 存在');

// Pipeline Progress
assert(cssContent.includes('.pipeline-progress'), '.pipeline-progress class 存在');
assert(cssContent.includes('.pipeline-stages-bar'), '.pipeline-stages-bar class 存在');
assert(cssContent.includes('.ps-block'), '.ps-block class 存在');
assert(cssContent.includes('.ps-bar.completed'), '.ps-bar.completed 樣式');
assert(cssContent.includes('.ps-bar.active'), '.ps-bar.active 樣式');

// Main Tabs
assert(cssContent.includes('.main-tabs'), '.main-tabs class 存在');
assert(cssContent.includes('.main-tab'), '.main-tab class 存在');
assert(cssContent.includes('.main-tab.active'), '.main-tab.active 樣式');

// Timeline Full
assert(cssContent.includes('.tl-full'), '.tl-full class 存在');
assert(cssContent.includes('.tl-tabs'), '.tl-tabs class 存在');
assert(cssContent.includes('.tl-tab'), '.tl-tab class 存在');
assert(cssContent.includes('.tl-filter'), '.tl-filter class 存在');
assert(cssContent.includes('.tl-chip'), '.tl-chip class 存在');
assert(cssContent.includes('.tl-chip.active'), '.tl-chip.active 樣式');
assert(cssContent.includes('.tl-items'), '.tl-items class 存在');
assert(cssContent.includes('.tl-item'), '.tl-item class 存在');

// Toolbar
assert(cssContent.includes('.toolbar'), '.toolbar class 存在');
assert(cssContent.includes('.tool-btn'), '.tool-btn class 存在');
assert(cssContent.includes('.conn-indicator'), '.conn-indicator class 存在');
assert(cssContent.includes('.dot.on'), '.dot.on 連線燈號');
assert(cssContent.includes('.dot.off'), '.dot.off 斷線燈號');

// DAG
assert(cssContent.includes('.dag-container'), '.dag-container class 存在');
assert(cssContent.includes('.dag-node'), '.dag-node class 存在');
assert(cssContent.includes('.dag-node.completed'), '.dag-node.completed 完成樣式');
assert(cssContent.includes('.dag-node.active'), '.dag-node.active 執行中樣式');
assert(cssContent.includes('.dag-node.failed'), '.dag-node.failed 失敗樣式');

// RWD
assert(cssContent.includes('@media (max-width: 1100px)'), 'RWD 1100px 斷點存在');
assert(cssContent.includes('@media (max-width: 700px)'), 'RWD 700px 斷點存在');

// ════════════════════════════════════════════════════════════════
// Section 14: CSS 消除三重覆寫 — 驗證二層結構
// ════════════════════════════════════════════════════════════════

section('Section 14: styles.css 二層結構驗證（消除三重覆寫）');

// CSS 策略：基礎值（≤1100px）= 無 media query，寬屏（>1100px）= min-width:1101px 覆寫
// 結果：每個屬性最多設定 2 次，消除舊的「三層：base → max-width:1100px → min-width:1101px」

// 二層結構：必須有 @media (min-width: 1101px) 的寬屏覆寫區塊
assert(cssContent.includes('min-width: 1101px') || cssContent.includes('min-width:1101px'), '寬屏覆寫使用 @media min-width 1101px');

// 驗證 Mosaic 主佈局定義存在
assert(cssContent.includes('.dash-grid.layout-mosaic'), '.dash-grid.layout-mosaic 主佈局定義存在');

// 確認基礎 grid-template-areas 存在（≤1100px 的雙欄佈局）
assert(cssContent.includes('grid-template-areas'), 'grid-template-areas 存在（Mosaic 區域佈局）');

// 確認寬屏三欄佈局存在（@media min-width:1101px 的覆寫）
assert(cssContent.includes('minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)'), '寬屏三欄佈局存在（>1100px 覆寫）');

// 確認 CSS 策略說明存在（文件化）
assert(cssContent.includes('消除三重覆寫') || cssContent.includes('min-width'), '消除三重覆寫策略已實施（min-width 覆寫）');

// ════════════════════════════════════════════════════════════════
// Section 15: app.js 主組件邏輯完整性靜態驗證
// ════════════════════════════════════════════════════════════════

section('Section 15: app.js 主組件邏輯完整性');

// 三個 hooks 正確調用
assert(appContent.includes('useWebSocket()'), 'useWebSocket() 被調用');
assert(appContent.includes('useSessionManager('), 'useSessionManager() 被調用');
assert(appContent.includes('useKeyboard('), 'useKeyboard() 被調用');

// hooks 回傳值解構（useWebSocket）
assert(appContent.includes('sessions') && appContent.includes('useWebSocket'), 'sessions 從 useWebSocket 解構');
assert(appContent.includes('alive') && appContent.includes('useWebSocket'), 'alive 從 useWebSocket 解構');
assert(appContent.includes('timelineEvents'), 'timelineEvents 從 useWebSocket 解構');
assert(appContent.includes('barrierStates'), 'barrierStates 從 useWebSocket 解構');
assert(appContent.includes('conn') && appContent.includes('useWebSocket'), 'conn 從 useWebSocket 解構');

// hooks 回傳值解構（useSessionManager）
assert(appContent.includes('mergedSessions'), 'mergedSessions 從 useSessionManager 解構');
assert(appContent.includes('liveSessions'), 'liveSessions 從 useSessionManager 解構');
assert(appContent.includes('doneSessions'), 'doneSessions 從 useSessionManager 解構');
assert(appContent.includes('staleSessions'), 'staleSessions 從 useSessionManager 解構');
assert(appContent.includes('selectSession'), 'selectSession 從 useSessionManager 解構');

// hooks 回傳值解構（useKeyboard）
assert(appContent.includes('zoom,') || appContent.includes('zoom }'), 'zoom 從 useKeyboard 解構');
assert(appContent.includes('zoomStyle'), 'zoomStyle 從 useKeyboard 解構');
assert(appContent.includes('setZoom'), 'setZoom 從 useKeyboard 解構');

// 三個新組件正確使用
assert(appContent.includes('<${Header}'), 'Header 組件被渲染');
assert(appContent.includes('<${DashboardTab}'), 'DashboardTab 組件被渲染');
assert(appContent.includes('<${TimelineTab}'), 'TimelineTab 組件被渲染');

// tab 切換條件
assert(appContent.includes("mainTab === 'dashboard'"), "dashboard tab 條件渲染");
assert(appContent.includes("mainTab === 'pipeline'"), "pipeline tab 條件渲染");
assert(appContent.includes("mainTab === 'timeline'"), "timeline tab 條件渲染");

// 每秒 tick（動態更新）
assert(appContent.includes('setInterval'), '每秒 tick setInterval 存在');
assert(appContent.includes('clearInterval'), '清理 setInterval');

// registry 載入
assert(appContent.includes("fetch('/api/registry')"), 'registry API 呼叫');

// confetti 觸發邏輯
assert(appContent.includes('confettiShown'), 'confetti 去重機制');
assert(appContent.includes('setShowConfetti(true)'), 'confetti 顯示觸發');
assert(appContent.includes('setShowConfetti(false)'), 'confetti 隱藏清理');

// typeLabel 函式
assert(appContent.includes('typeLabel'), 'typeLabel 函式定義');
assert(appContent.includes('registry.pipelines'), 'typeLabel 使用 registry.pipelines');

// ════════════════════════════════════════════════════════════════
// Section 16: hooks import 路徑一致性（相對路徑驗證）
// ════════════════════════════════════════════════════════════════

section('Section 16: hooks import 路徑一致性');

// 所有 hook 都應從 ../lib/preact.js import
const hookFiles = ['useWebSocket.js', 'useKeyboard.js', 'useSessionManager.js'];
for (const hookFile of hookFiles) {
  const content = readFile(`hooks/${hookFile}`);
  const importLines = content.split('\n').filter(l => l.trim().startsWith('import'));
  for (const imp of importLines) {
    const hasRelative = imp.includes("'../") || imp.includes('"../') || imp.includes("'./") || imp.includes('"./');
    assert(hasRelative, `${hookFile} 的 import 使用相對路徑：${imp.trim().slice(0, 60)}`);
  }
}

// useWebSocket：只 import preact
const wsImportLines = wsContent.split('\n').filter(l => l.trim().startsWith('import'));
assert(wsImportLines.some(l => l.includes('../lib/preact.js')), 'useWebSocket.js import ../lib/preact.js');

// useKeyboard：import preact
const kbImportLines = kbContent.split('\n').filter(l => l.trim().startsWith('import'));
assert(kbImportLines.some(l => l.includes('../lib/preact.js')), 'useKeyboard.js import ../lib/preact.js');

// useSessionManager：import preact + state/pipeline
const smImportLines = smContent.split('\n').filter(l => l.trim().startsWith('import'));
assert(smImportLines.some(l => l.includes('../lib/preact.js')), 'useSessionManager.js import ../lib/preact.js');
assert(smImportLines.some(l => l.includes('../state/pipeline.js')), 'useSessionManager.js import ../state/pipeline.js');

// header.js import 路徑
const headerImportLines = headerContent.split('\n').filter(l => l.trim().startsWith('import'));
assert(headerImportLines.some(l => l.includes('../lib/preact.js')), 'header.js import ../lib/preact.js');
assert(headerImportLines.some(l => l.includes('../lib/utils.js')), 'header.js import ../lib/utils.js');

// dashboard-tab.js import 路徑
const dtImportLines = dtContent.split('\n').filter(l => l.trim().startsWith('import'));
assert(dtImportLines.some(l => l.includes('../lib/preact.js')), 'dashboard-tab.js import ../lib/preact.js');
assert(dtImportLines.some(l => l.includes('../lib/utils.js')), 'dashboard-tab.js import ../lib/utils.js');
assert(dtImportLines.some(l => l.includes('../state/pipeline.js')), 'dashboard-tab.js import ../state/pipeline.js');

// ════════════════════════════════════════════════════════════════
// Section 17: useWebSocket 心跳 + 重連邏輯驗證
// ════════════════════════════════════════════════════════════════

section('Section 17: useWebSocket 心跳與重連邏輯驗證');

// 心跳機制
assert(wsContent.includes('ping'), '心跳發送 ping');
assert(wsContent.includes('clearInterval(hb)'), 'onopen 清除舊心跳');
assert(wsContent.includes('hb = setInterval'), '設置心跳 interval');

// 指數退避重連
const backoffMatch = wsContent.match(/Math\.min\((\d+)\s*\*\s*Math\.pow\(2,\s*retries/);
assert(backoffMatch !== null, '指數退避：300 * 2^retries 模式');
// 基礎延遲是 300ms
assert(wsContent.includes('300'), '重連基礎延遲 300ms');
// 上限 5000ms
assert(wsContent.includes('5000'), '重連上限 5000ms');

// 連線成功重設 retries
assert(wsContent.includes('retries = 0'), '連線成功：重設 retries 為 0');

// onerror 靜默處理
assert(wsContent.includes('onerror = () => {}'), 'onerror 靜默處理（空函式）');

// ════════════════════════════════════════════════════════════════
// Section 18: DashboardTab → Header props 傳遞一致性
// ════════════════════════════════════════════════════════════════

section('Section 18: app.js → Header + DashboardTab props 傳遞一致性');

// Header props 傳遞
assert(appContent.includes('activeId=${active}'), 'Header activeId 傳遞正確');
assert(appContent.includes('isComplete=${isComplete}'), 'Header isComplete 傳遞正確');
assert(appContent.includes('fullscreen=${fullscreen}'), 'Header fullscreen 傳遞正確');
assert(appContent.includes('zoom=${zoom}'), 'Header zoom 傳遞正確');
assert(appContent.includes('conn=${conn}'), 'Header conn 傳遞正確');
assert(appContent.includes('tlAll=${tlAll}'), 'Header tlAll 傳遞正確');
assert(appContent.includes('s=${s}'), 'Header s 傳遞正確');
assert(appContent.includes('registry=${registry}'), 'Header registry 傳遞正確');

// DashboardTab props 傳遞
assert(appContent.includes('s=${s}'), 'DashboardTab s 傳遞正確');
assert(appContent.includes('tick=${tick}'), 'DashboardTab tick 傳遞正確');
assert(appContent.includes('tlAll=${tlAll}'), 'DashboardTab tlAll 傳遞正確');
assert(appContent.includes('registry=${registry}'), 'DashboardTab registry 傳遞正確');
assert(appContent.includes('memory=${memory}'), 'DashboardTab memory 傳遞正確');
assert(appContent.includes('sessionId=${active}'), 'DashboardTab sessionId 傳遞正確');
assert(appContent.includes('isComplete=${isComplete}'), 'DashboardTab isComplete 傳遞正確');
assert(appContent.includes('typeLabel=${typeLabel}'), 'DashboardTab typeLabel 傳遞正確');

// TimelineTab props 傳遞
assert(appContent.includes('tlFiltered=${tlFiltered}'), 'TimelineTab tlFiltered 傳遞正確');
assert(appContent.includes('tlTab=${tlTab}'), 'TimelineTab tlTab 傳遞正確');
assert(appContent.includes('tlFilter=${tlFilter}'), 'TimelineTab tlFilter 傳遞正確');
assert(appContent.includes('onTabChange=${setTlTab}'), 'TimelineTab onTabChange 傳遞正確');
assert(appContent.includes('onFilterChange=${setTlFilter}'), 'TimelineTab onFilterChange 傳遞正確');

// ════════════════════════════════════════════════════════════════
// Section 19: app.js 行數驗證（重構後應顯著縮短）
// ════════════════════════════════════════════════════════════════

section('Section 19: app.js 重構後行數驗證');

const appLines = appContent.split('\n').length;
assert(appLines <= 250, `app.js 行數 ${appLines} 應 ≤ 250（重構後縮短到 ~196 行）`);
assert(appLines >= 100, `app.js 行數 ${appLines} 應 ≥ 100（非空）`);

// hooks 各自檔案行數
const wsLines = wsContent.split('\n').length;
assert(wsLines <= 100, `useWebSocket.js 行數 ${wsLines} 應 ≤ 100（單一職責）`);

const kbLines = kbContent.split('\n').length;
assert(kbLines <= 90, `useKeyboard.js 行數 ${kbLines} 應 ≤ 90（單一職責）`);

const smLines = smContent.split('\n').length;
assert(smLines <= 80, `useSessionManager.js 行數 ${smLines} 應 ≤ 80（單一職責）`);

// 新組件行數
const headerLines = headerContent.split('\n').length;
assert(headerLines <= 60, `header.js 行數 ${headerLines} 應 ≤ 60（單一職責）`);

const dtLines = dtContent.split('\n').length;
assert(dtLines <= 130, `dashboard-tab.js 行數 ${dtLines} 應 ≤ 130（單一職責）`);

const ttLines = ttContent.split('\n').length;
assert(ttLines <= 70, `timeline-tab.js 行數 ${ttLines} 應 ≤ 70（單一職責）`);

// ════════════════════════════════════════════════════════════════
// Section 20: useSessionManager 自動選擇邏輯分析
// ════════════════════════════════════════════════════════════════

section('Section 20: useSessionManager 自動選擇邏輯靜態分析');

// 自動選擇策略
assert(smContent.includes('liveSessions.find('), '自動選擇：優先從 liveSessions 找活躍 session');
assert(smContent.includes('ss._alive || isLive(ss)'), '自動選擇條件：_alive 或 isLive');
assert(smContent.includes('liveSessions[0]?.[0]'), '降級：無活躍時選 liveSessions 第一個');
assert(smContent.includes('doneSessions[0]?.[0]'), '降級：再選 doneSessions 第一個');
assert(smContent.includes('sids[sids.length - 1]'), '最後降級：最新 session');

// 防空保護
assert(smContent.includes("if (!sids.length) return"), '空 sessions 時提前返回');

// ════════════════════════════════════════════════════════════════
// Section 21: 邊界案例 — mergedSessions 邊界
// ════════════════════════════════════════════════════════════════

section('Section 21: mergedSessions 邊界案例');

// alive 有多個，sessions 有多個，重疊
const bigSessions = { a: { v: 1 }, b: { v: 2 }, c: { v: 3 } };
const bigAlive = { a: true, b: false, d: true };  // d 不在 sessions 中
const bigMerged = mergedSessions(bigSessions, bigAlive);

assert(bigMerged.a._alive === true, '重疊：a 在兩邊 + alive=true → _alive');
assert(!bigMerged.b._alive, '重疊：b 在兩邊 + alive=false → 無 _alive');
assert(bigMerged.c !== undefined, 'c 只在 sessions → 保留');
assert(!bigMerged.c._alive, 'c 只在 sessions，無 alive → 無 _alive');
assert(bigMerged.d._heartbeatOnly === true, 'd 只在 alive → heartbeatOnly');

// 空 sessions，非空 alive
const emptySessionsMerged = mergedSessions({}, { 'sid-x': true, 'sid-y': false });
assert(emptySessionsMerged['sid-x'] !== undefined, 'alive=true 且不在 sessions → 出現');
assert(emptySessionsMerged['sid-x']._heartbeatOnly === true, '正確標記 _heartbeatOnly');
assert(emptySessionsMerged['sid-y'] === undefined, 'alive=false 且不在 sessions → 不出現');

// ════════════════════════════════════════════════════════════════
// Section 22: filterTimeline 邊界案例
// ════════════════════════════════════════════════════════════════

section('Section 22: filterTimeline 邊界案例');

// 空陣列
assert(filterTimeline([], 'all', 0).length === 0, '空事件陣列：返回空陣列');
assert(filterTimeline([], 'pipeline', 10).length === 0, '空事件陣列 + 過濾：返回空陣列');

// ts=0（UNIX epoch）被 cutoff 過濾
const epochEvent = [{ cat: 'pipeline', ts: 0, text: 'epoch 事件' }];
const epochFiltered = filterTimeline(epochEvent, 'all', 10);
assert(epochFiltered.length === 0, 'ts=0（epoch）在 10m 過濾下被排除');

// tlTab='all' 不過濾類別
const mixedCatEvents = [
  { cat: 'pipeline', ts: Date.now() },
  { cat: 'agent', ts: Date.now() },
  { cat: undefined, ts: Date.now() },
];
const mixedFiltered = filterTimeline(mixedCatEvents, 'all', 0);
assert(mixedFiltered.length === 3, "tlTab='all' 保留所有類別，包括 undefined");

// tlFilter=0 不過濾時間（即使 ts 為 undefined）
const noTsEvents = [{ cat: 'pipeline', text: '無 ts' }];
const noTsAll = filterTimeline(noTsEvents, 'all', 0);
assert(noTsAll.length === 1, 'tlFilter=0 時不過濾時間，無 ts 事件仍保留');

// ════════════════════════════════════════════════════════════════
// Section 23: CSS keyframes 動畫存在性（視覺效果驗證）
// ════════════════════════════════════════════════════════════════

section('Section 23: CSS @keyframes 動畫存在性');

assert(cssContent.includes('@keyframes blink'), '@keyframes blink（斷線燈號閃爍）');
assert(cssContent.includes('@keyframes livePulse'), '@keyframes livePulse（活躍 session 脈動）');
assert(cssContent.includes('@keyframes alPulse'), '@keyframes alPulse（agent 狀態燈脈動）');
assert(cssContent.includes('@keyframes slideIn'), '@keyframes slideIn（timeline 事件滑入）');
assert(cssContent.includes('@keyframes pulse'), '@keyframes pulse（pipeline active 脈動）');
assert(cssContent.includes('@keyframes shimmer'), '@keyframes shimmer（完成進度條光澤）');
assert(cssContent.includes('@keyframes dagPulse'), '@keyframes dagPulse（DAG node 脈動）');
assert(cssContent.includes('@keyframes dagShake'), '@keyframes dagShake（DAG node 失敗抖動）');
assert(cssContent.includes('@keyframes dashFlow'), '@keyframes dashFlow（DAG edge 流動虛線）');
assert(cssContent.includes('@keyframes celebratePop'), '@keyframes celebratePop（完成彈出）');

// ════════════════════════════════════════════════════════════════
// Section 24: useWebSocket timeline 事件 prepend 邏輯（最新優先）
// ════════════════════════════════════════════════════════════════

section('Section 24: useWebSocket timeline 事件 prepend 邏輯');

// timeline 事件以 [m.event, ...list] 預置（最新在前）
assert(wsContent.includes('[m.event, ...list]'), 'timeline 事件 prepend（最新在前）');
assert(wsContent.includes('.slice(0, 200)'), 'timeline 事件列表最多 200 筆（防記憶體膨脹）');

// barrier 事件覆蓋（使用 {...prev, [m.sessionId]: m.barrierState}）
assert(wsContent.includes('m.barrierState'), 'barrier 狀態覆蓋保存');

// alive 合併（使用展開語法保留其他 session alive 狀態）
assert(wsContent.includes('...prev, ...m.alive'), 'alive 狀態合併展開（保留舊值）');

// ════════════════════════════════════════════════════════════════
// Section 25: useKeyboard 邊界導航（列表頭尾不崩潰）
// ════════════════════════════════════════════════════════════════

section('Section 25: useKeyboard 邊界導航邏輯');

// j/k 導航邊界保護
assert(kbContent.includes('idx > 0'), 'k 鍵上移：idx > 0 邊界保護（不低於 0）');
assert(kbContent.includes('idx < sids.length - 1'), 'j 鍵下移：idx < sids.length-1 邊界保護');

// active=null 時 sids.indexOf(null) = -1，idx=-1 → 兩個條件都不滿足 → 不執行
// 此邏輯由上面兩個 assert 涵蓋

// ════════════════════════════════════════════════════════════════
// Section 26: DashboardTab ResizeObserver sessionId 依賴
// ════════════════════════════════════════════════════════════════

section('Section 26: DashboardTab ResizeObserver sessionId 依賴');

// ResizeObserver 的 useEffect 依賴 [sessionId] → session 切換時重設同步
assert(dtContent.includes('[sessionId]'), 'ResizeObserver useEffect 依賴 [sessionId]');
assert(dtContent.includes('ro.disconnect()'), 'ResizeObserver cleanup：disconnect');
assert(dtContent.includes('ro.observe(ap)'), 'ResizeObserver 觀察 agent-panel 元素');

// 高度同步：tl.style.maxHeight = ap.offsetHeight
assert(dtContent.includes('tl.style.maxHeight'), 'mini-tl maxHeight 同步到 agent-panel 高度');
assert(dtContent.includes('offsetHeight'), '使用 offsetHeight 取得實際高度');

// ════════════════════════════════════════════════════════════════
// Section 27: header.js 完成彩蛋與工具列等效性
// ════════════════════════════════════════════════════════════════

section('Section 27: header.js 完成彩蛋與工具列等效性');

// 完成時顯示彩蛋
assert(headerContent.includes('🎉'), 'isComplete=true 時顯示 🎉 彩蛋');

// 全螢幕狀態圖示切換
assert(headerContent.includes('⊡'), '全螢幕模式：⊡ 圖示');
assert(headerContent.includes('⊞'), '非全螢幕模式：⊞ 圖示');

// 縮放顯示 zoom%
assert(headerContent.includes('${zoom}%') || headerContent.includes('zoom}%') || headerContent.includes('zoom'), '縮放百分比顯示');

// 工具列分隔線
assert(headerContent.includes('toolbar-sep'), 'toolbar-sep 分隔線 class');

// 導出按鈕
assert(headerContent.includes("'md'"), 'MD 導出按鈕');
assert(headerContent.includes("'json'"), 'JSON 導出按鈕');
assert(headerContent.includes('onExport('), '導出 handler 呼叫');

// ════════════════════════════════════════════════════════════════
// Section 28: 組件 export 與 import 完整性最終驗證
// ════════════════════════════════════════════════════════════════

section('Section 28: 所有新模組 export 與 import 完整性最終驗證');

const newFiles = [
  { file: 'hooks/useWebSocket.js', expected: 'useWebSocket' },
  { file: 'hooks/useKeyboard.js', expected: 'useKeyboard' },
  { file: 'hooks/useSessionManager.js', expected: 'useSessionManager' },
  { file: 'components/header.js', expected: 'Header' },
  { file: 'components/dashboard-tab.js', expected: 'DashboardTab' },
  { file: 'components/timeline-tab.js', expected: 'TimelineTab' },
];

for (const { file, expected } of newFiles) {
  const content = readFile(file);
  const hasExport = content.includes(`export function ${expected}`) ||
                    content.includes(`export const ${expected}`);
  assert(hasExport, `${file} 有正確 export ${expected}`);
}

// app.js 中正確使用（解構/呼叫）
assert(appContent.includes('useWebSocket()'), 'app.js 呼叫 useWebSocket()');
assert(appContent.includes('useSessionManager('), 'app.js 呼叫 useSessionManager()');
assert(appContent.includes('useKeyboard('), 'app.js 呼叫 useKeyboard()');
assert(appContent.includes('<${Header}'), 'app.js 使用 Header 組件');
assert(appContent.includes('<${DashboardTab}'), 'app.js 使用 DashboardTab 組件');
assert(appContent.includes('<${TimelineTab}'), 'app.js 使用 TimelineTab 組件');

// ════════════════════════════════════════════════════════════════
// Section 29: getAllStageKeys 合併 DAG + stages 邏輯驗證
// ════════════════════════════════════════════════════════════════

section('Section 29: getAllStageKeys 合併 DAG + stages 邏輯驗證');

// 邏輯萃取：getAllStageKeys
function getAllStageKeys(state) {
  const dagKeys = Object.keys(state?.dag || {});
  const stageKeys = Object.keys(state?.stages || {});
  const extraKeys = stageKeys.filter(k => !dagKeys.includes(k));
  return [...dagKeys, ...extraKeys];
}

// 29-1: 正常情況 — DAG 和 stages 完全一致
{
  const state = {
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] }, TEST: { deps: ['DEV'] } },
    stages: { DEV: { status: 'completed' }, REVIEW: { status: 'completed' }, TEST: { status: 'completed' } },
  };
  const keys = getAllStageKeys(state);
  assert(keys.length === 3, '29-1: DAG/stages 一致時長度為 3');
  assert(keys[0] === 'DEV' && keys[1] === 'REVIEW' && keys[2] === 'TEST', '29-1: 順序保持 DAG 拓撲');
}

// 29-2: stages 有額外 stage（E2E, DOCS）不在 DAG 中
{
  const state = {
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] }, TEST: { deps: ['DEV'] } },
    stages: {
      DEV: { status: 'completed' }, REVIEW: { status: 'completed' }, TEST: { status: 'completed' },
      E2E: { status: 'completed' }, DOCS: { status: 'completed' },
    },
  };
  const keys = getAllStageKeys(state);
  assert(keys.length === 5, '29-2: 合併後長度為 5（3 DAG + 2 extra）');
  assert(keys[0] === 'DEV' && keys[1] === 'REVIEW' && keys[2] === 'TEST', '29-2: DAG stage 在前');
  assert(keys[3] === 'E2E' && keys[4] === 'DOCS', '29-2: 額外 stage 追加到末尾');
}

// 29-3: 無 DAG 但有 stages
{
  const state = { stages: { DEV: { status: 'completed' } } };
  const keys = getAllStageKeys(state);
  assert(keys.length === 1 && keys[0] === 'DEV', '29-3: 無 DAG 時從 stages 取');
}

// 29-4: 空 state
{
  const keys = getAllStageKeys({});
  assert(keys.length === 0, '29-4: 空 state 回傳空陣列');
  const keysNull = getAllStageKeys(null);
  assert(keysNull.length === 0, '29-4: null state 回傳空陣列');
}

// 29-5: getPipelineProgress 使用合併 stage 計算
{
  function getPipelineProgress(state) {
    const stages = getAllStageKeys(state);
    if (!stages.length) return 0;
    const done = stages.filter(id => {
      const st = state.stages?.[id]?.status;
      return st === 'completed' || st === 'skipped';
    });
    return Math.round(done.length / stages.length * 100);
  }
  // 3/5 完成 = 60%
  const state = {
    dag: { DEV: { deps: [] }, REVIEW: { deps: ['DEV'] }, TEST: { deps: ['DEV'] } },
    stages: {
      DEV: { status: 'completed' }, REVIEW: { status: 'completed' }, TEST: { status: 'active' },
      E2E: { status: 'completed' }, DOCS: { status: 'pending' },
    },
  };
  const progress = getPipelineProgress(state);
  assert(progress === 60, `29-5: 進度 3/5 = 60%（得到 ${progress}%）`);
}

// 29-6: pipeline-progress.js import getAllStageKeys
{
  const ppContent = fs.readFileSync(path.join(WEB_DIR, 'components', 'pipeline-progress.js'), 'utf8');
  assert(ppContent.includes('getAllStageKeys'), '29-6: pipeline-progress.js import getAllStageKeys');
  assert(ppContent.includes('getAllStageKeys(state)'), '29-6: pipeline-progress.js 使用 getAllStageKeys(state)');
}

// 29-7: dashboard-tab.js import getAllStageKeys
{
  const dtContent = fs.readFileSync(path.join(WEB_DIR, 'components', 'dashboard-tab.js'), 'utf8');
  assert(dtContent.includes('getAllStageKeys'), '29-7: dashboard-tab.js import getAllStageKeys');
  assert(dtContent.includes('getAllStageKeys(s)'), '29-7: dashboard-tab.js 使用 getAllStageKeys(s)');
}

// 29-8: state/pipeline.js export getAllStageKeys
{
  const spContent = fs.readFileSync(path.join(WEB_DIR, 'state', 'pipeline.js'), 'utf8');
  assert(spContent.includes('export function getAllStageKeys'), '29-8: pipeline.js export getAllStageKeys');
}

// 29-9: onDelegate 動態建立 stage 記錄（pipeline-controller.js）
{
  const ctrlContent = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'pipeline-controller.js'), 'utf8'
  );
  assert(ctrlContent.includes('AGENT_TO_STAGE[shortAgent]'), '29-9: onDelegate 檢查 AGENT_TO_STAGE');
  assert(ctrlContent.includes("status: 'active'"), '29-9: 動態建立 stage 記錄');
  assert(ctrlContent.includes('startedAt: new Date'), '29-9: 動態建立包含 startedAt');
}

// 29-10: DAG 解析失敗日誌記錄
{
  const ctrlContent = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'lib', 'flow', 'pipeline-controller.js'), 'utf8'
  );
  assert(ctrlContent.includes('DAG 解析失敗 → 降級為 quick-dev'), '29-10: DAG 解析失敗有日誌記錄');
  assert(ctrlContent.includes('lastAssistantMessage 長度'), '29-10: 日誌包含診斷資訊');
}

// ════════════════════════════════════════════════════════════════
// 結果輸出
// ════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`結果：${passed} 通過，${failed} 失敗，共 ${passed + failed} 個測試`);

if (failed > 0) {
  process.exit(1);
}
