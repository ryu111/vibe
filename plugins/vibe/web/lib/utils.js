// 共用輔助函式

/**
 * 截取 session ID 前 8 碼顯示
 * @param {string} id
 * @returns {string}
 */
export function sid(id) {
  return id?.length > 8 ? id.slice(0, 8) : id || '—';
}

/**
 * 取得目前時間字串（HH:MM:SS）
 * @returns {string}
 */
export function now() {
  return new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * 計算距 ISO 時間的經過時間（人類可讀格式）
 * @param {string} iso
 * @returns {string}
 */
export function elapsed(iso) {
  if (!iso) return '';
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h`;
}

/**
 * 格式化秒數為人類可讀字串
 * @param {number|null} secs
 * @returns {string}
 */
export function fmtSec(secs) {
  if (!secs && secs !== 0) return '—';
  if (secs < 60) return Math.round(secs) + 's';
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/**
 * 計算從 startedAt 到現在的持續時間
 * @param {string} startedAt ISO 時間字串
 * @returns {string}
 */
export function fmtDuration(startedAt) {
  if (!startedAt) return '—';
  const secs = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  return fmtSec(secs);
}

/**
 * 格式化 bytes 為人類可讀大小
 * @param {number} bytes
 * @returns {string}
 */
export function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * 刪除指定 session
 * @param {string} id session ID
 */
export async function deleteSession(id) {
  try { await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
}

/**
 * 清理過期 session
 */
export async function cleanupStale() {
  try { await fetch('/api/sessions/cleanup', { method: 'POST' }); } catch {}
}
