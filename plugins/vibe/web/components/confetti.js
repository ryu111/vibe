// Confetti 慶祝動畫組件
import { html, useMemo } from '../lib/preact.js';

const CONFETTI_COLORS = ['#a6e3a1', '#89b4fa', '#f9e2af', '#f5c2e7', '#cba6f7', '#89dceb', '#fab387', '#f38ba8'];

/**
 * 慶祝彩紙動畫
 */
export function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 60 }, (_, i) => ({
    left: Math.random() * 100,
    delay: Math.random() * 1.5,
    dur: 2.5 + Math.random() * 2,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    w: 5 + Math.random() * 7,
    h: 3 + Math.random() * 5,
  })), []);

  return html`
    <div class="confetti-wrap">
      ${pieces.map((p, i) => html`
        <div key=${i} class="confetti-piece" style="left:${p.left}%;--delay:${p.delay}s;--dur:${p.dur}s;background:${p.color};width:${p.w}px;height:${p.h}px"></div>
      `)}
    </div>
  `;
}
