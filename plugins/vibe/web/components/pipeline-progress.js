// Pipeline 進度條組件
import { html } from '../lib/preact.js';
import { hasPipeline, getPipelineProgress, getStageStatus } from '../state/pipeline.js';

/**
 * 動態 Pipeline 各 stage 進度條
 * @param {{ state: object, registry: object }} props
 */
export function PipelineProgressBar({ state, registry }) {
  if (!hasPipeline(state)) return null;
  const dag = state.dag || {};
  const dagKeys = Object.keys(dag);
  const progress = getPipelineProgress(state);
  const isComp = progress === 100;

  return html`
    <div class="pipeline-progress">
      <h3 style="display:flex;align-items:center;justify-content:space-between">
        <span>📊 Pipeline 進度</span>
        <span style="font-size:12px;color:${isComp ? 'var(--green)' : 'var(--blue)'};font-weight:700">${progress}%</span>
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
