// v4 Pipeline state accessor 函式（不依賴 adaptState）
import { fmtSec } from '../lib/utils.js';

/**
 * 取得指定 stage 的狀態
 * @param {string} stageId
 * @param {object} state
 * @returns {'pending'|'active'|'completed'|'failed'|'skipped'}
 */
export function getStageStatus(stageId, state) {
  if (!state?.stages?.[stageId]) return 'pending';
  return state.stages[stageId].status;
}

/**
 * 取得指定 stage 的 verdict
 * @param {string} stageId
 * @param {object} state
 * @returns {string|null}
 */
export function getStageVerdict(stageId, state) {
  const stage = state?.stages?.[stageId];
  if (!stage?.verdict) return null;
  if (typeof stage.verdict === 'object') return stage.verdict.verdict || null;
  return stage.verdict;
}

/**
 * 取得指定 stage 的 severity（FAIL 嚴重程度）
 * @param {string} stageId
 * @param {object} state
 * @returns {string|null}
 */
export function getStageSeverity(stageId, state) {
  const stage = state?.stages?.[stageId];
  if (!stage?.verdict) return null;
  if (typeof stage.verdict === 'object') return stage.verdict.severity || null;
  return null;
}

/**
 * 計算 stage 執行耗時（秒）
 * @param {string} stageId
 * @param {object} state
 * @returns {number|null}
 */
export function getStageDuration(stageId, state) {
  const stage = state?.stages?.[stageId];
  if (!stage?.startedAt || !stage?.completedAt) return null;
  return Math.round((new Date(stage.completedAt) - new Date(stage.startedAt)) / 1000);
}

/**
 * 取得所有 stage ID（合併 DAG + stages，保持 DAG 拓撲順序）
 * DAG 中的 stage 在前，動態新增的 stage（不在 DAG 但有記錄）追加到末尾
 * @param {object} state
 * @returns {string[]}
 */
export function getAllStageKeys(state) {
  const dagKeys = Object.keys(state?.dag || {});
  const stageKeys = Object.keys(state?.stages || {});
  const extraKeys = stageKeys.filter(k => !dagKeys.includes(k));
  return [...dagKeys, ...extraKeys];
}

/**
 * 計算 pipeline 完成百分比（0-100）
 * 合併 DAG + stages 的所有 stage（涵蓋動態新增的 stage）
 * @param {object} state
 * @returns {number}
 */
export function getPipelineProgress(state) {
  const stages = getAllStageKeys(state);
  if (!stages.length) return 0;
  const done = stages.filter(id => {
    const st = state.stages?.[id]?.status;
    return st === 'completed' || st === 'skipped';
  });
  return Math.round(done.length / stages.length * 100);
}

/**
 * 是否有 pipeline DAG
 * @param {object} state
 * @returns {boolean}
 */
export function hasPipeline(state) {
  return !!(state?.dag && Object.keys(state.dag).length > 0);
}

/**
 * Session 是否存活（有活躍 agent）
 * @param {object} state
 * @returns {boolean}
 */
export function isLive(state) {
  return !!(state?._alive || (state?.activeStages?.length > 0) || state?.pipelineActive);
}

/**
 * 取得目前 active 的 stage ID 清單（涵蓋 DAG 外動態新增的 stage）
 * @param {object} state
 * @returns {string[]}
 */
export function getActiveStages(state) {
  return getAllStageKeys(state).filter(id => state.stages?.[id]?.status === 'active');
}

/**
 * 判斷 session 類別
 * @param {object} s session state
 * @returns {'live'|'done'|'active'|'stale'}
 */
export function sessionCategory(s) {
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

/**
 * 取得 session 顯示名稱
 * @param {object} s session state
 * @param {object} registry registry 資料
 * @returns {string}
 */
export function sessionName(s, registry) {
  if (s?._heartbeatOnly) return '對話中';
  const pid = s?.classification?.pipelineId;
  if (!pid || pid === 'none') return '對話中';
  if (registry?.pipelines?.[pid]) return registry.pipelines[pid].label;
  return pid;
}

/**
 * 取得目前 active stage 的顯示名稱（含 emoji）
 * @param {object} s session state
 * @param {object} registry registry 資料
 * @returns {string|null}
 */
export function currentStageName(s, registry) {
  const active = getActiveStages(s);
  if (!active.length) return null;
  const stage = active[0];
  const stageBase = stage.split(':')[0];
  const meta = registry?.stages?.[stageBase];
  return meta ? `${meta.emoji} ${meta.label}` : stage;
}
