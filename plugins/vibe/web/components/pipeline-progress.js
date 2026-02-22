// Pipeline 進度條組件
import { html } from '../lib/preact.js';
import { hasPipeline, getPipelineProgress, getStageStatus, getAllStageKeys } from '../state/pipeline.js';

/**
 * 動態 Pipeline 各 stage 進度條
 * @param {{ state: object, registry: object }} props
 */
export function PipelineProgressBar({ state, registry }) {
  const dag = state?.dag || {};
  const dagKeys = getAllStageKeys(state);
  const hasDag = dagKeys.length > 0;

  // 無 DAG 時顯示佔位
  if (!hasDag) {
    return html`
      <div class="pipeline-progress">
        <h3 style="display:flex;align-items:center;justify-content:space-between">
          <span>📊 Pipeline 進度</span>
          <span style="font-size:12px;color:var(--overlay0);font-weight:700">—</span>
        </h3>
        <div style="font-size:10px;color:var(--overlay0);padding:4px 0">尚未啟動 Pipeline</div>
      </div>
    `;
  }

  const pipelineInactive = !state?.pipelineActive && (state?.activeStages || []).length === 0;
  const progress = getPipelineProgress(state);
  const isComp = progress === 100;
  const isCancelled = pipelineInactive && !isComp && state?.meta?.cancelled;

  return html`
    <div class="pipeline-progress">
      <h3 style="display:flex;align-items:center;justify-content:space-between">
        <span>📊 Pipeline 進度${isCancelled ? ' · 已取消' : ''}</span>
        <span style="font-size:12px;color:${isComp ? 'var(--green)' : isCancelled ? 'var(--orange)' : 'var(--blue)'};font-weight:700">${progress}%</span>
      </h3>
      <div class="pipeline-stages-bar">
        ${dagKeys.map(id => {
          const status = getStageStatus(id, state);
          const stageBase = id.split(':')[0];
          const meta = registry?.stages?.[stageBase];
          return html`
            <div key=${id} class="ps-block">
              <span class="ps-label">${meta?.emoji || ''} ${id}</span>
              <div class="ps-bar ${status}"></div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}
