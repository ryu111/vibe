#!/bin/bash
# ram-monitor.sh — Claude Code RAM 監控工具
#
# 用法：
#   ./ram-monitor.sh          # 顯示當前狀態
#   ./ram-monitor.sh --clean  # 清理孤兒進程
#   ./ram-monitor.sh --watch  # 持續監控（每 30 秒更新）
#
# 監控項目：
# - 全系統 RAM 分佈（Chrome/VS Code/Claude/MCP/Daemon/System）
# - Claude Code 主進程 + MCP servers + Daemon 詳細列表
# - 孤兒進程偵測（PPID=1 / 父進程不存在）
# - Claude 生態圈佔比摘要
set -euo pipefail

# 顏色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

WARN_THRESHOLD_MB=4096  # 4GB 警告
CRIT_THRESHOLD_MB=8192  # 8GB 嚴重

# --- 格式化 RSS ---
format_mb() {
  local kb=$1
  local mb=$((kb / 1024))
  if [ "$mb" -ge "$CRIT_THRESHOLD_MB" ]; then
    echo -e "${RED}${mb}MB${NC}"
  elif [ "$mb" -ge "$WARN_THRESHOLD_MB" ]; then
    echo -e "${YELLOW}${mb}MB${NC}"
  elif [ "$mb" -ge 500 ]; then
    echo -e "${CYAN}${mb}MB${NC}"
  else
    echo "${mb}MB"
  fi
}

# --- 顯示進程狀態 ---
show_status() {
  echo -e "${BOLD}=== Claude Code RAM Monitor ===${NC}"
  echo -e "${GRAY}$(date '+%Y-%m-%d %H:%M:%S')${NC}"
  echo ""

  local total_rss=0
  local orphan_count=0
  local orphan_rss=0

  # --- Claude 主進程 ---
  echo -e "${BOLD}[Claude 主進程]${NC}"
  local claude_procs
  claude_procs=$(ps -eo pid,ppid,rss,etime,command 2>/dev/null | grep -E '(^|/)claude( |$)' | grep -v grep | grep -v 'chrome-mcp' || true)
  if [ -n "$claude_procs" ]; then
    while IFS= read -r line; do
      local parts=($line)
      local pid=${parts[0]}
      local ppid=${parts[1]}
      local rss=${parts[2]}
      local etime=${parts[3]}
      local cmd="${parts[@]:4}"
      total_rss=$((total_rss + rss))
      echo -e "  PID ${pid} $(format_mb $rss) [${etime}] ${GRAY}${cmd:0:60}${NC}"
    done <<< "$claude_procs"
  else
    echo -e "  ${GRAY}（無）${NC}"
  fi
  echo ""

  # --- claude-in-chrome MCP ---
  echo -e "${BOLD}[claude-in-chrome MCP]${NC}"
  local chrome_procs
  chrome_procs=$(ps -eo pid,ppid,rss,etime,command 2>/dev/null | grep 'claude-in-chrome-mcp' | grep -v grep || true)
  if [ -n "$chrome_procs" ]; then
    while IFS= read -r line; do
      local parts=($line)
      local pid=${parts[0]}
      local ppid=${parts[1]}
      local rss=${parts[2]}
      local etime=${parts[3]}
      total_rss=$((total_rss + rss))

      local is_orphan=""
      # 直接檢查父進程是否存活（kill -0 不送信號，只檢查存在性）
      if ! kill -0 "$ppid" 2>/dev/null; then
        is_orphan="${RED}[ORPHAN]${NC} "
        orphan_count=$((orphan_count + 1))
        orphan_rss=$((orphan_rss + rss))
      fi
      echo -e "  PID ${pid} $(format_mb $rss) [${etime}] ${is_orphan}PPID=${ppid}"
    done <<< "$chrome_procs"
  else
    echo -e "  ${GRAY}（無）${NC}"
  fi
  echo ""

  # --- claude-mem 相關 ---
  echo -e "${BOLD}[claude-mem 進程]${NC}"
  # worker daemon
  local worker
  worker=$(ps -eo pid,rss,etime,command 2>/dev/null | grep 'worker-service.cjs' | grep -v grep || true)
  if [ -n "$worker" ]; then
    local parts=($worker)
    local rss=${parts[1]}
    total_rss=$((total_rss + rss))
    echo -e "  Worker:    PID ${parts[0]} $(format_mb $rss) [${parts[2]}]"
  fi

  # mcp-server
  local mcp_server
  mcp_server=$(ps -eo pid,ppid,rss,etime,command 2>/dev/null | grep 'mcp-server.cjs' | grep -v grep || true)
  if [ -n "$mcp_server" ]; then
    while IFS= read -r line; do
      local parts=($line)
      local rss=${parts[2]}
      total_rss=$((total_rss + rss))
      echo -e "  MCP Node:  PID ${parts[0]} $(format_mb $rss) [${parts[3]}] PPID=${parts[1]}"
    done <<< "$mcp_server"
  fi

  # chroma-mcp python worker 進程（排除 uv launcher，避免重複計數）
  local chroma_procs
  chroma_procs=$(ps -eo pid,ppid,rss,etime,command 2>/dev/null | grep 'python.*chroma-mcp' | grep -v grep || true)
  if [ -n "$chroma_procs" ]; then
    while IFS= read -r line; do
      local parts=($line)
      local pid=${parts[0]}
      local ppid=${parts[1]}
      local rss=${parts[2]}
      local etime=${parts[3]}
      total_rss=$((total_rss + rss))

      local is_orphan=""
      if [ "$ppid" -eq 1 ]; then
        is_orphan="${RED}[ORPHAN]${NC} "
        orphan_count=$((orphan_count + 1))
        orphan_rss=$((orphan_rss + rss))
      fi
      echo -e "  Chroma:    PID ${pid} $(format_mb $rss) [${etime}] ${is_orphan}PPID=${ppid}"
    done <<< "$chroma_procs"
  fi

  # uv 進程
  local uv_procs
  uv_procs=$(ps -eo pid,ppid,rss,etime,command 2>/dev/null | grep 'uv tool uvx.*chroma-mcp' | grep -v grep || true)
  if [ -n "$uv_procs" ]; then
    while IFS= read -r line; do
      local parts=($line)
      local pid=${parts[0]}
      local ppid=${parts[1]}
      local rss=${parts[2]}
      local etime=${parts[3]}
      total_rss=$((total_rss + rss))

      local is_orphan=""
      if [ "$ppid" -eq 1 ]; then
        is_orphan="${RED}[ORPHAN]${NC} "
        orphan_count=$((orphan_count + 1))
        orphan_rss=$((orphan_rss + rss))
      fi
      echo -e "  UV:        PID ${pid} $(format_mb $rss) [${etime}] ${is_orphan}PPID=${ppid}"
    done <<< "$uv_procs"
  fi

  if [ -z "$worker" ] && [ -z "$chroma_procs" ]; then
    echo -e "  ${GRAY}（無）${NC}"
  fi
  echo ""

  # --- Dashboard / Remote ---
  echo -e "${BOLD}[Daemon 進程]${NC}"
  local dashboard
  dashboard=$(ps -eo pid,rss,etime,command 2>/dev/null | grep 'server.js' | grep 'vibe' | grep -v grep || true)
  if [ -n "$dashboard" ]; then
    local parts=($dashboard)
    local rss=${parts[1]}
    total_rss=$((total_rss + rss))
    echo -e "  Dashboard: PID ${parts[0]} $(format_mb $rss) [${parts[2]}]"
  fi

  local remote
  remote=$(ps -eo pid,rss,etime,command 2>/dev/null | grep 'bot.js' | grep -v grep || true)
  if [ -n "$remote" ]; then
    local parts=($remote)
    local rss=${parts[1]}
    total_rss=$((total_rss + rss))
    echo -e "  Remote:    PID ${parts[0]} $(format_mb $rss) [${parts[2]}]"
  fi

  if [ -z "$dashboard" ] && [ -z "$remote" ]; then
    echo -e "  ${GRAY}（無）${NC}"
  fi
  echo ""

  # --- 全系統 RAM 分佈 ---
  echo -e "${BOLD}[全系統 RAM 分佈]${NC}"
  local sys_total_kb
  sys_total_kb=$(ps -eo rss 2>/dev/null | awk 'NR>1 {s+=$1} END {print s+0}')
  local sys_total_mb=$((sys_total_kb / 1024))

  # 用 awk 一次掃描分類所有進程（POSIX awk 相容）
  ps -eo rss,command 2>/dev/null | awk -v total="$sys_total_kb" '
    NR==1 {next}
    {
      rss=$1; cmd=$0; sub(/^[ ]*[0-9]+[ ]+/, "", cmd)
      if (cmd ~ /Google Chrome|Chrome Helper/) { k="Chrome" }
      else if (cmd ~ /Electron|Code Helper|code-insiders/) { k="VS Code" }
      else if (cmd ~ /(^|\/)claude( |$)/ && cmd !~ /chrome-mcp/) { k="Claude CLI" }
      else if (cmd ~ /claude-in-chrome-mcp/) { k="Chrome MCP" }
      else if (cmd ~ /chroma-mcp|worker-service\.cjs|mcp-server\.cjs|uv tool uvx.*chroma/) { k="claude-mem" }
      else if (cmd ~ /vibe\/server\.js|vibe\/bot\.js/) { k="Vibe Daemon" }
      else { k="System/Other" }

      if (!(k in cat)) { keys[++n] = k }
      cat[k] += rss; cnt[k]++
    }
    END {
      # 計算 MB，bubble sort 降序
      for (i=1; i<=n; i++) mb[keys[i]] = int(cat[keys[i]] / 1024)
      for (i=1; i<n; i++) {
        for (j=i+1; j<=n; j++) {
          if (mb[keys[j]] > mb[keys[i]]) {
            tmp = keys[i]; keys[i] = keys[j]; keys[j] = tmp
          }
        }
      }
      for (i=1; i<=n; i++) {
        k = keys[i]
        pct = (total > 0) ? sprintf("%.1f", cat[k] * 100 / total) : "0.0"
        printf "  %-14s %4d procs  %6dMB  (%s%%)\n", k, cnt[k], mb[k], pct
      }
      printf "  %-14s %4s        %6dMB\n", "── 合計 ──", "", int(total/1024)
    }
  '
  echo ""

  # --- Claude 相關摘要 ---
  echo -e "${BOLD}[Claude 相關摘要]${NC}"
  local total_mb=$((total_rss / 1024))
  local claude_pct="0.0"
  if [ "$sys_total_kb" -gt 0 ]; then
    claude_pct=$(awk "BEGIN{printf \"%.1f\", $total_rss*100/$sys_total_kb}")
  fi
  echo -e "  Claude 生態圈 RAM: $(format_mb $total_rss)（佔系統 ${claude_pct}%）"

  if [ "$orphan_count" -gt 0 ]; then
    echo -e "  ${RED}孤兒進程: ${orphan_count} 個（$(format_mb $orphan_rss)）${NC}"
    echo -e "  ${YELLOW}使用 --clean 清理孤兒進程${NC}"
  else
    echo -e "  ${GREEN}無孤兒進程${NC}"
  fi

  # State 檔案統計
  local timeline_count
  timeline_count=$(ls ~/.claude/timeline-*.jsonl 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  local state_count
  state_count=$(ls ~/.claude/pipeline-state-*.json 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  echo -e "  State 檔案: ${timeline_count} timeline + ${state_count} pipeline-state"

  if [ "$total_mb" -ge "$CRIT_THRESHOLD_MB" ]; then
    echo ""
    echo -e "  ${RED}*** 警告：Claude RAM 超過 ${CRIT_THRESHOLD_MB}MB，建議立即清理或重啟 ***${NC}"
  elif [ "$total_mb" -ge "$WARN_THRESHOLD_MB" ]; then
    echo ""
    echo -e "  ${YELLOW}注意：Claude RAM 超過 ${WARN_THRESHOLD_MB}MB，建議注意觀察${NC}"
  fi
  echo ""
}

# --- 清理孤兒進程 ---
clean_orphans() {
  echo -e "${BOLD}=== 清理孤兒進程 ===${NC}"
  local killed=0
  local freed=0

  # 清理 PPID=1 的 chroma-mcp
  local chroma_orphans
  chroma_orphans=$(ps -eo pid,ppid,rss,command 2>/dev/null | grep 'chroma-mcp' | grep -v grep | awk '$2==1 {print $1, $3}' || true)
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local parts=($line)
    local pid=${parts[0]}
    local rss=${parts[1]}
    echo -e "  ${RED}KILL${NC} chroma-mcp PID ${pid} ($(format_mb $rss))"
    kill -TERM "$pid" 2>/dev/null || true
    killed=$((killed + 1))
    freed=$((freed + rss))
  done <<< "$chroma_orphans"

  # 清理 PPID=1 的 uv（chroma-mcp 相關）
  local uv_orphans
  uv_orphans=$(ps -eo pid,ppid,rss,command 2>/dev/null | grep 'uv tool uvx.*chroma-mcp' | grep -v grep | awk '$2==1 {print $1, $3}' || true)
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local parts=($line)
    local pid=${parts[0]}
    local rss=${parts[1]}
    echo -e "  ${RED}KILL${NC} uv (chroma) PID ${pid} ($(format_mb $rss))"
    kill -TERM "$pid" 2>/dev/null || true
    killed=$((killed + 1))
    freed=$((freed + rss))
  done <<< "$uv_orphans"

  # 清理孤兒 claude-in-chrome-mcp（父進程不存在的）
  local chrome_mcps
  chrome_mcps=$(ps -eo pid,ppid,rss,command 2>/dev/null | grep 'claude-in-chrome-mcp' | grep -v grep || true)
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local parts=($line)
    local pid=${parts[0]}
    local ppid=${parts[1]}
    local rss=${parts[2]}
    if ! kill -0 "$ppid" 2>/dev/null; then
      echo -e "  ${RED}KILL${NC} chrome-mcp PID ${pid} ($(format_mb $rss)) [orphan, PPID=${ppid}]"
      kill -TERM "$pid" 2>/dev/null || true
      killed=$((killed + 1))
      freed=$((freed + rss))
    fi
  done <<< "$chrome_mcps"

  echo ""
  if [ "$killed" -gt 0 ]; then
    echo -e "  ${GREEN}已清理 ${killed} 個孤兒進程，釋放 ~$(format_mb $freed)${NC}"
  else
    echo -e "  ${GREEN}無需清理${NC}"
  fi
  echo ""
}

# --- 持續監控 ---
watch_mode() {
  echo -e "${BOLD}持續監控模式（Ctrl+C 退出）${NC}"
  while true; do
    clear
    show_status
    sleep 30
  done
}

# --- 主流程 ---
case "${1:-}" in
  --clean)
    clean_orphans
    ;;
  --watch)
    watch_mode
    ;;
  --help|-h)
    echo "用法: ram-monitor.sh [選項]"
    echo ""
    echo "選項:"
    echo "  (無)      顯示全系統 RAM 分佈 + Claude 生態圈摘要"
    echo "  --clean   清理孤兒進程"
    echo "  --watch   持續監控（每 30 秒更新）"
    echo "  --help    顯示此說明"
    ;;
  *)
    show_status
    ;;
esac
