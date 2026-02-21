// MCP 統計面板組件
import { html, useMemo } from '../lib/preact.js';

/**
 * MCP 工具呼叫統計面板
 * @param {{ events: object[] }} props
 */
export function MCPStats({ events }) {
  const stats = useMemo(() => {
    const servers = {};
    for (const ev of events) {
      if (!ev.text) continue;
      const m = ev.text.match(/^([a-z][a-z0-9_-]*):/i);
      if (!m) continue;
      const server = m[1];
      if (!servers[server]) servers[server] = { count: 0, methods: {} };
      servers[server].count++;
      const method = ev.text.slice(server.length + 1).split(' ')[0];
      if (method) servers[server].methods[method] = (servers[server].methods[method] || 0) + 1;
    }
    return Object.entries(servers).sort((a, b) => b[1].count - a[1].count);
  }, [events]);

  if (stats.length === 0) return null;
  const total = stats.reduce((sum, [, s]) => sum + s.count, 0);
  const maxCount = stats[0]?.[1]?.count || 1;

  return html`
    <div class="mcp-stats">
      <h3>🔌 MCP 活動<span class="mcp-total">${total} calls</span></h3>
      ${stats.map(([server, s]) => {
        const topMethods = Object.entries(s.methods).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m]) => m).join(', ');
        return html`
          <div key=${server} class="mcp-row">
            <span class="mcp-server">${server}</span>
            <span class="mcp-count">${s.count}</span>
            <div class="mcp-bar"><div class="mcp-fill" style="width:${(s.count / maxCount * 100)}%"></div></div>
            <span class="mcp-methods">${topMethods}</span>
          </div>
        `;
      })}
    </div>
  `;
}
