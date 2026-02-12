#!/usr/bin/env node
/**
 * refresh-dashboard.js — 掃描進度 + 生成 Dashboard + 智慧開啟/刷新
 *
 * 用途：Stop hook 每次 Claude 回應完畢後自動執行
 * 行為：
 *   0. 執行 sync-dashboard-data.js（更新 dashboard-meta.json）
 *   1. 執行 scan-progress.js（更新 progress.json）
 *   2. 執行 generate-dashboard.js（更新 dashboard.html）
 *   3. 偵測 dashboard.html 是否已在瀏覽器開啟
 *      - 未開啟 → open 打開
 *      - 已開啟 → 刷新該分頁
 *
 * 重要：永遠 exit 0，不阻擋 Claude 停止
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = process.cwd();
const DASHBOARD_PATH = path.join(ROOT, 'dashboard', 'dashboard.html');
const DASHBOARD_URL = `file://${DASHBOARD_PATH}`;

// ─── 步驟 0：同步 metadata ──────────────────────────

try {
  execFileSync('node', [path.join(ROOT, 'dashboard', 'scripts', 'sync-data.js')], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 8000,
  });
} catch (e) {
  // 同步失敗不阻擋流程（generate-dashboard 可 fallback）
}

// ─── 步驟 1 & 2：掃描 + 生成 ─────────────────────

try {
  execFileSync('node', [path.join(ROOT, 'dashboard', 'scripts', 'scan-progress.js')], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 8000,
  });
} catch (e) {
  // 掃描失敗不阻擋流程
  process.exit(0);
}

try {
  execFileSync('node', [path.join(ROOT, 'dashboard', 'scripts', 'generate.js')], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 8000,
  });
} catch (e) {
  process.exit(0);
}

// ─── 步驟 3：偵測瀏覽器 + 開啟或刷新 ──────────────

/**
 * 用 osascript 檢查 Safari 是否有開啟 dashboard，有的話刷新
 * 回傳 true 表示已找到並刷新
 */
function refreshSafari() {
  const script = `
    tell application "System Events"
      if not (exists process "Safari") then return "not_running"
    end tell
    tell application "Safari"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "${DASHBOARD_PATH}" then
            tell t to do JavaScript "location.reload()"
            return "refreshed"
          end if
        end repeat
      end repeat
    end tell
    return "not_found"
  `;
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result === 'refreshed';
  } catch (_) {
    return false;
  }
}

/**
 * 用 osascript 檢查 Chrome 是否有開啟 dashboard，有的話刷新
 * 回傳 true 表示已找到並刷新
 */
function refreshChrome() {
  const script = `
    tell application "System Events"
      if not (exists process "Google Chrome") then return "not_running"
    end tell
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "${DASHBOARD_PATH}" then
            reload t
            return "refreshed"
          end if
        end repeat
      end repeat
    end tell
    return "not_found"
  `;
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result === 'refreshed';
  } catch (_) {
    return false;
  }
}

try {
  // 先嘗試刷新已開啟的分頁（Safari 優先，再 Chrome）
  const refreshed = refreshSafari() || refreshChrome();

  if (!refreshed) {
    // 都沒開啟，用系統預設瀏覽器打開
    execSync(`open "${DASHBOARD_PATH}"`, { timeout: 3000, stdio: 'pipe' });
  }
} catch (_) {
  // 瀏覽器操作失敗不阻擋
}

process.exit(0);
