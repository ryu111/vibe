#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# run.sh — Pipeline E2E 測試驅動器（Dashboard 即時渲染）
#
# 用法:
#   ./run.sh              # 跑全部場景
#   ./run.sh A            # 跑 A 分類（Pipeline 正路徑）
#   ./run.sh A04          # 跑單一場景
#   ./run.sh A04 A10 B03  # 跑指定場景
#   ./run.sh smoke        # 冒煙測試（A10 + A04）
#
# 環境變數:
#   VIBE_E2E_MODEL     測試模型（預設 opus）
#   VIBE_E2E_PARALLEL  同時執行場景數（預設 1，建議 1-3）
#   VIBE_E2E_KEEP_TMP  保留暫存目錄（除錯用）
#   VIBE_E2E_DRY_RUN   只顯示場景列表不執行
#   VIBE_E2E_NO_TMUX   強制使用 print 模式（無需 tmux）
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -uo pipefail
# 注意：不用 set -e — 並行模式下 background job 的 exit code 會觸發 early exit
# 各函式內部自行處理錯誤

# ────────────────── 常量 ──────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VIBE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
VIBE_PLUGIN="$VIBE_ROOT/plugins/vibe"
FORGE_PLUGIN="$VIBE_ROOT/plugins/forge"
SCENARIOS_FILE="$SCRIPT_DIR/scenarios.json"
VALIDATE_SCRIPT="$SCRIPT_DIR/validate.js"
REPORT_SCRIPT="$SCRIPT_DIR/report.js"

MODEL="${VIBE_E2E_MODEL:-opus}"
KEEP_TMP="${VIBE_E2E_KEEP_TMP:-false}"
DRY_RUN="${VIBE_E2E_DRY_RUN:-false}"

# 執行模式：tmux（互動）或 print（非互動，無需 tmux）
if command -v tmux &>/dev/null && [ "${VIBE_E2E_NO_TMUX:-}" != "true" ]; then
  USE_TMUX=true
else
  USE_TMUX=false
fi

# 結果目錄（時間戳）
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="$SCRIPT_DIR/results/$TIMESTAMP"

# ANSI 顏色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ────────────────── Dashboard 即時渲染 ──────────────────
#
# 設計：每個場景佔一行，狀態原地更新（不捲動）
# - set_status() 寫狀態檔 → render_dashboard() 用 ANSI 游標上移重繪
# - fd 3 = 原始終端（$() 子 shell 裡也能渲染到螢幕）
# - 序列模式：set_status 後立即渲染
# - 並行模式：背景 loop 每 2 秒渲染一次

DASH_DIR=""
DASH_LINES=0
DASH_IDS_STR=""
RENDER_LOOP_PID=""

init_dashboard() {
  DASH_DIR=$(mktemp -d /tmp/vibe-e2e-dash.XXXXXX)

  # fd 3 = 原始終端（即使在 $() 子 shell 中也能輸出到螢幕）
  exec 3>&1

  local ids=("$@")
  DASH_IDS_STR="${ids[*]}"
  DASH_LINES=$(( ${#ids[@]} + 4 ))  # header(2) + scenarios + separator(1) + summary(1)

  # 初始化 status 檔案
  for id in "${ids[@]}"; do
    local name
    name=$(get_scenario_field "$id" "name")
    echo "${name:-$id}" > "$DASH_DIR/${id}.name"
    echo "⬜ 待執行" > "$DASH_DIR/${id}.status"
  done

  # 存游標位置（DEC save），再印空行佔位
  printf '\033[s' >&3
  local i
  for ((i=0; i<DASH_LINES; i++)); do
    echo "" >&3
  done

  render_dashboard
}

set_status() {
  local id="$1"
  local status="$2"
  [ -z "$DASH_DIR" ] && return
  echo "$status" > "$DASH_DIR/${id}.status"

  # 序列模式：每次更新立即渲染；並行模式：由背景 loop 渲染
  if [ -z "$RENDER_LOOP_PID" ]; then
    render_dashboard
  fi
}

render_dashboard() {
  [ -z "$DASH_DIR" ] && return

  # 恢復游標到 dashboard 起始位置（DEC restore — 抗並行 race condition）
  printf '\033[u' >&3

  # Header
  printf '\033[K  %b━━━ Pipeline E2E ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' '\033[0;36m' '\033[0m' >&3
  printf '\033[K  %b模型: %s | 結果: %s%b\n' '\033[2m' "$MODEL" "$(basename "$RESULTS_DIR")" '\033[0m' >&3

  # Scenario rows
  local p=0 f=0 r=0 w=0
  local id
  for id in $DASH_IDS_STR; do
    local name status color
    name=$(cat "$DASH_DIR/${id}.name" 2>/dev/null || echo "$id")
    status=$(cat "$DASH_DIR/${id}.status" 2>/dev/null || echo "⬜")

    # 截斷過長名稱
    if [ ${#name} -gt 28 ]; then
      name="${name:0:25}..."
    fi

    case "$status" in
      ✓*) color='\033[0;32m'; p=$((p+1)) ;;
      ✗*) color='\033[0;31m'; f=$((f+1)) ;;
      ⏳*) color='\033[0;33m'; r=$((r+1)) ;;
      *) color='\033[2m'; w=$((w+1)) ;;
    esac

    printf '\033[K  \033[1m%-6s\033[0m %-30s %b%s\033[0m\n' "$id" "$name" "$color" "$status" >&3
  done

  # Separator + Summary
  printf '\033[K  %b───────────────────────────────────────────────────────────%b\n' '\033[2m' '\033[0m' >&3

  local total=0
  for id in $DASH_IDS_STR; do total=$((total+1)); done
  printf '\033[K  \033[0;32m%d✓\033[0m  \033[0;31m%d✗\033[0m  \033[0;33m%d⏳\033[0m  \033[2m%d⬜\033[0m  共 %d\n' "$p" "$f" "$r" "$w" "$total" >&3
}

start_render_loop() {
  (
    while [ -d "$DASH_DIR" ]; do
      render_dashboard
      sleep 2
    done
  ) &
  RENDER_LOOP_PID=$!
}

stop_render_loop() {
  if [ -n "$RENDER_LOOP_PID" ]; then
    kill "$RENDER_LOOP_PID" 2>/dev/null || true
    wait "$RENDER_LOOP_PID" 2>/dev/null || true
    RENDER_LOOP_PID=""
    render_dashboard  # 並行模式：停止 loop 後最終渲染一次
  fi
}

cleanup_dashboard() {
  stop_render_loop
  [ -n "$DASH_DIR" ] && rm -rf "$DASH_DIR"
  exec 3>&- 2>/dev/null || true
}

# ────────────────── 信號處理 ──────────────────

cleanup_on_exit() {
  # 最後一次渲染 dashboard 顯示當前狀態
  if [ -n "$DASH_DIR" ]; then
    render_dashboard
    printf '\n' >&3
    printf '  %b中斷%b\n' '\033[0;33m' '\033[0m' >&3
  fi

  if [ "$USE_TMUX" = "true" ]; then
    for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^e2e-'); do
      tmux kill-session -t "$sess" 2>/dev/null || true
    done
  else
    # print 模式：清理所有 e2e pid 檔案對應的進程
    for pf in /tmp/vibe-e2e-pid-*; do
      [ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null || true
      rm -f "$pf" 2>/dev/null || true
    done
  fi

  if [ -d "$RESULTS_DIR" ] && ls "$RESULTS_DIR"/*.json 1>/dev/null 2>&1; then
    node "$REPORT_SCRIPT" "$RESULTS_DIR" 2>/dev/null || true
  fi

  cleanup_dashboard
  exit 130
}

trap cleanup_on_exit INT TERM

# ────────────────── 前置檢查 ──────────────────

check_prerequisites() {
  local missing=0

  if [ "$USE_TMUX" = "true" ] && ! command -v tmux &>/dev/null; then
    echo -e "${RED}tmux 未安裝（設 VIBE_E2E_NO_TMUX=true 可用 print 模式）${RESET}"
    missing=1
  fi

  if ! command -v claude &>/dev/null; then
    echo -e "${RED}claude CLI 未安裝${RESET}"
    missing=1
  fi

  if ! command -v node &>/dev/null; then
    echo -e "${RED}node 未安裝${RESET}"
    missing=1
  fi

  if ! command -v jq &>/dev/null; then
    echo -e "${RED}jq 未安裝 (用於解析 scenarios.json)${RESET}"
    missing=1
  fi

  if [ ! -f "$SCENARIOS_FILE" ]; then
    echo -e "${RED}scenarios.json 不存在: $SCENARIOS_FILE${RESET}"
    missing=1
  fi

  if [ ! -d "$VIBE_PLUGIN" ]; then
    echo -e "${RED}vibe plugin 不存在: $VIBE_PLUGIN${RESET}"
    missing=1
  fi

  if [ $missing -ne 0 ]; then
    echo -e "${RED}前置條件不滿足，終止執行${RESET}"
    exit 1
  fi

  echo -e "${GREEN}✓ 前置檢查通過${RESET}"
}

# ────────────────── 場景篩選 ──────────────────

get_scenario_ids() {
  local filter="$1"

  if [ "$filter" = "all" ] || [ -z "$filter" ]; then
    jq -r '.scenarios[].id' "$SCENARIOS_FILE"
  elif [ "$filter" = "smoke" ]; then
    echo "A10"
    echo "A04"
  elif [[ "$filter" =~ ^[A-E]$ ]]; then
    jq -r ".scenarios[] | select(.category == \"$filter\") | .id" "$SCENARIOS_FILE"
  else
    echo "$filter"
  fi
}

get_scenario_field() {
  local id="$1" field="$2"
  jq -r ".scenarios[] | select(.id == \"$id\") | .$field // empty" "$SCENARIOS_FILE"
}

get_scenario_json() {
  local id="$1"
  jq ".scenarios[] | select(.id == \"$id\")" "$SCENARIOS_FILE"
}

# ────────────────── 專案複製 ──────────────────

clone_project() {
  local id="$1"
  local target="/tmp/vibe-e2e-${id}"

  rm -rf "$target"
  git clone --depth 1 --single-branch "file://$VIBE_ROOT" "$target" 2>/dev/null

  echo "$target"
}

# ────────────────── 專案變體 ──────────────────

apply_variant() {
  local project_dir="$1"
  local variant="$2"

  case "$variant" in
    "default")
      ;;
    "buggy-review")
      echo "console.log('DEBUG_LEFTOVER_FOR_REVIEW');" >> "$project_dir/plugins/vibe/scripts/lib/hook-logger.js"
      (cd "$project_dir" && git add -A && git commit -m "inject buggy code for review test" --no-verify 2>/dev/null) || true
      ;;
    "buggy-test")
      cat > "$project_dir/plugins/vibe/tests/injected-fail.test.js" << 'TESTEOF'
#!/usr/bin/env node
'use strict';
const assert = (cond, msg) => { if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); } };
// 這個測試故意失敗
assert(1 === 2, 'injected test should fail');
console.log('PASS: injected test');
TESTEOF
      chmod +x "$project_dir/plugins/vibe/tests/injected-fail.test.js"
      (cd "$project_dir" && git add -A && git commit -m "inject failing test" --no-verify 2>/dev/null) || true
      ;;
    "frontend")
      echo "module.exports = { reactStrictMode: true };" > "$project_dir/next.config.js"
      mkdir -p "$project_dir/src/components"
      echo "export default function App() { return <div>Hello</div>; }" > "$project_dir/src/components/App.tsx"
      if [ -f "$project_dir/package.json" ]; then
        node -e "
          const pkg = JSON.parse(require('fs').readFileSync('$project_dir/package.json','utf8'));
          pkg.dependencies = pkg.dependencies || {};
          pkg.dependencies.react = '^19.0.0';
          pkg.dependencies['react-dom'] = '^19.0.0';
          pkg.dependencies.next = '^15.0.0';
          require('fs').writeFileSync('$project_dir/package.json', JSON.stringify(pkg, null, 2));
        "
      else
        echo '{"dependencies":{"react":"^19.0.0","react-dom":"^19.0.0","next":"^15.0.0"}}' > "$project_dir/package.json"
      fi
      (cd "$project_dir" && git add -A && git commit -m "setup frontend project" --no-verify 2>/dev/null) || true
      ;;
    *)
      ;;
  esac
}

# ────────────────── 等待 State 檔案 ──────────────────

poll_state() {
  local uuid="$1"
  local idle_timeout="$2"
  local scenario_id="$3"
  local sess="$4"
  local elapsed=0
  local idle_elapsed=0
  local last_mtime=""
  local state_file="$CLAUDE_DIR/pipeline-state-${uuid}.json"
  local timeline_file="$CLAUDE_DIR/timeline-${uuid}.jsonl"
  local poll_interval=10
  local max_wall=1800  # 30 分鐘硬上限
  local pid_file="/tmp/vibe-e2e-pid-${scenario_id}"

  while true; do
    # 硬上限
    if (( elapsed > max_wall )); then
      echo "TIMEOUT"
      return 1
    fi

    # 閒置逾時
    if (( idle_elapsed > idle_timeout )); then
      echo "TIMEOUT"
      return 1
    fi

    # Print 模式進程退出偵測：claude -p 結束後直接進入驗證，不等閒置逾時
    if [ "$USE_TMUX" != "true" ] && [ -f "$pid_file" ]; then
      local bg_pid
      bg_pid=$(cat "$pid_file" 2>/dev/null)
      if [ -n "$bg_pid" ] && ! kill -0 "$bg_pid" 2>/dev/null; then
        # 等一下讓最後的 hook 完成檔案寫入
        sleep 3
        set_status "$scenario_id" "⏳ claude 已退出，驗證中..."
        # 進程退出後，檢查 state 檔案判斷真實狀態
        if [ -f "$state_file" ]; then
          local exit_phase
          exit_phase=$(node -e "
            try {
              const s = JSON.parse(require('fs').readFileSync('$state_file','utf8'));
              const { derivePhase } = require('$VIBE_PLUGIN/scripts/lib/flow/dag-state.js');
              console.log(derivePhase(s));
            } catch(e) { console.log('UNKNOWN'); }
          " 2>/dev/null)
          if [ "$exit_phase" = "COMPLETE" ]; then
            # 快照 state（防止被其他 session 的 cleanup 刪除）
            cp "$state_file" "$RESULTS_DIR/${scenario_id}.state-snapshot.json" 2>/dev/null || true
            echo "COMPLETE"
            return 0
          fi
        fi
        echo "PROCESS_EXIT"
        return 0
      fi
    fi

    # 活躍度偵測：timeline 或 state 檔案更新就重設閒置計時
    local current_mtime=""
    if [ -f "$timeline_file" ]; then
      current_mtime=$(stat -f %m "$timeline_file" 2>/dev/null)
    elif [ -f "$state_file" ]; then
      current_mtime=$(stat -f %m "$state_file" 2>/dev/null)
    fi

    if [ -n "$current_mtime" ]; then
      if [ "$current_mtime" != "$last_mtime" ]; then
        idle_elapsed=0
        last_mtime="$current_mtime"
      fi
    else
      # 檔案尚未建立（啟動中）— 不計入閒置
      idle_elapsed=0
    fi

    if [ -f "$state_file" ]; then
      local phase
      phase=$(node -e "
        try {
          const s = JSON.parse(require('fs').readFileSync('$state_file','utf8'));
          const { derivePhase } = require('$VIBE_PLUGIN/scripts/lib/flow/dag-state.js');
          console.log(derivePhase(s));
        } catch(e) { console.log('UNKNOWN'); }
      " 2>/dev/null)

      set_status "$scenario_id" "⏳ ${phase} (閒置${idle_elapsed}s/總${elapsed}s)"

      case "$phase" in
        COMPLETE)
          # 快照 state（防止被其他 session 的 cleanup 刪除）
          cp "$state_file" "$RESULTS_DIR/${scenario_id}.state-snapshot.json" 2>/dev/null || true
          echo "COMPLETE"
          return 0
          ;;
        IDLE)
          local pid
          pid=$(node -e "
            try {
              const s = JSON.parse(require('fs').readFileSync('$state_file','utf8'));
              console.log(s.classification && s.classification.pipelineId || '');
            } catch(e) { console.log(''); }
          " 2>/dev/null)
          if [ "$pid" = "none" ]; then
            set_status "$scenario_id" "⏳ none 完成偵測..."
            sleep 15
            echo "NONE_COMPLETE"
            return 0
          fi
          ;;
      esac
    else
      set_status "$scenario_id" "⏳ 啟動中 (${elapsed}s)"
    fi

    sleep "$poll_interval"
    elapsed=$((elapsed + poll_interval))
    idle_elapsed=$((idle_elapsed + poll_interval))
  done
}

# ────────────────── Cancel 場景特殊處理 ──────────────────

wait_for_plan_then_cancel() {
  local uuid="$1"
  local sess="$2"
  local idle_timeout="$3"
  local scenario_id="$4"
  local state_file="$CLAUDE_DIR/pipeline-state-${uuid}.json"
  local timeline_file="$CLAUDE_DIR/timeline-${uuid}.jsonl"
  local elapsed=0
  local idle_elapsed=0
  local last_mtime=""
  local max_wall=1800

  set_status "$scenario_id" "⏳ 等待 PLAN..."

  while true; do
    if (( elapsed > max_wall )) || (( idle_elapsed > idle_timeout )); then
      echo "TIMEOUT"
      return 1
    fi

    # 活躍度偵測
    local current_mtime=""
    if [ -f "$timeline_file" ]; then
      current_mtime=$(stat -f %m "$timeline_file" 2>/dev/null)
    elif [ -f "$state_file" ]; then
      current_mtime=$(stat -f %m "$state_file" 2>/dev/null)
    fi

    if [ -n "$current_mtime" ]; then
      if [ "$current_mtime" != "$last_mtime" ]; then
        idle_elapsed=0
        last_mtime="$current_mtime"
      fi
    else
      idle_elapsed=0
    fi

    if [ -f "$state_file" ]; then
      local has_plan
      has_plan=$(node -e "
        try {
          const s = JSON.parse(require('fs').readFileSync('$state_file','utf8'));
          const st = s.stages && s.stages.PLAN;
          console.log(st && st.status === 'completed' ? 'yes' : 'no');
        } catch(e) { console.log('no'); }
      " 2>/dev/null)

      if [ "$has_plan" = "yes" ]; then
        set_status "$scenario_id" "⏳ Cancel 中..."
        # 直接修改 state file — 模擬 /vibe:cancel skill 的完整操作
        node -e "
          const fs = require('fs');
          const f = '$state_file';
          const state = JSON.parse(fs.readFileSync(f, 'utf8'));
          state.meta = state.meta || {};
          state.meta.cancelled = true;
          state.pipelineActive = false;
          state.activeStages = [];
          fs.writeFileSync(f, JSON.stringify(state, null, 2));
        " 2>/dev/null
        # 中斷當前 session
        if [ "$USE_TMUX" = "true" ]; then
          tmux send-keys -t "$sess" C-c 2>/dev/null
        else
          stop_claude_print "$scenario_id"
        fi
        sleep 5
        echo "CANCELLED"
        return 0
      fi

      set_status "$scenario_id" "⏳ 等待 PLAN (閒置${idle_elapsed}s/總${elapsed}s)"
    fi

    sleep 5
    elapsed=$((elapsed + 5))
    idle_elapsed=$((idle_elapsed + 5))
  done
}

# ────────────────── Follow-up 場景處理 ──────────────────

handle_follow_up() {
  local uuid="$1"
  local sess="$2"
  local follow_up="$3"
  local timeout="$4"
  local scenario_id="$5"
  local project_dir="${6:-}"
  local mem_dir="${7:-}"

  # 先等第一個 pipeline 完成
  local result
  result=$(poll_state "$uuid" "$timeout" "$scenario_id" "$sess")

  if [ "$result" = "COMPLETE" ] || [ "$result" = "NONE_COMPLETE" ]; then
    set_status "$scenario_id" "⏳ 送 follow-up..."

    if [ "$USE_TMUX" = "true" ]; then
      # tmux：Pipeline 完成後全域規則觸發 AskUserQuestion，需要先處理
      sleep 8
      tmux send-keys -t "$sess" Escape 2>/dev/null
      sleep 3
      tmux send-keys -t "$sess" -l "$follow_up"
      sleep 1
      tmux send-keys -t "$sess" Enter
    else
      # print：第一次 -p 已結束，用 --resume -p 送第二個 prompt
      sleep 3
      send_followup_print "$scenario_id" "$project_dir" "$uuid" "$mem_dir" "$follow_up" > /dev/null
    fi

    # 重新等待
    sleep 5
    local result2
    result2=$(poll_state "$uuid" "$timeout" "$scenario_id" "$sess")
    echo "$result2"
  else
    echo "$result"
  fi
}

# ────────────────── Claude 啟動/停止（雙模式抽象）──────────────────

# 共用 claude 命令參數（不含 cd 和 -p）
_claude_base_args() {
  local uuid="$1" mem_dir="$2"
  echo "CLAUDE_MEM_DATA_DIR='$mem_dir' VIBE_SKIP_RESUME=1 claude --session-id '$uuid' --model '$MODEL' --dangerously-skip-permissions --plugin-dir '$VIBE_PLUGIN' --plugin-dir '$FORGE_PLUGIN'"
}

# tmux 模式：建立 session 並啟動 claude
start_claude_tmux() {
  local id="$1" project_dir="$2" uuid="$3" mem_dir="$4"
  local sess="e2e-${id}"
  tmux kill-session -t "$sess" 2>/dev/null || true
  tmux new-session -d -s "$sess" -x 200 -y 50
  sleep 1
  local claude_cmd="unset CLAUDECODE && cd '$project_dir' && $(_claude_base_args "$uuid" "$mem_dir")"
  tmux send-keys -t "$sess" "$claude_cmd" Enter
  sleep 10
  echo "$sess"
}

# tmux 模式：送出 prompt
send_prompt_tmux() {
  local sess="$1" prompt="$2"
  tmux send-keys -t "$sess" -l "$prompt"
  sleep 1
  tmux send-keys -t "$sess" Enter
}

# tmux 模式：停止 claude
stop_claude_tmux() {
  local sess="$1"
  tmux send-keys -t "$sess" -l "/exit" 2>/dev/null || true
  sleep 1
  tmux send-keys -t "$sess" Enter 2>/dev/null || true
  sleep 3
  tmux kill-session -t "$sess" 2>/dev/null || true
}

# print 模式：背景啟動 claude -p
start_claude_print() {
  local id="$1" project_dir="$2" uuid="$3" mem_dir="$4" prompt="$5"
  local log_file="$RESULTS_DIR/${id}.claude.log"
  local pid_file="/tmp/vibe-e2e-pid-${id}"

  (
    cd "$project_dir"
    unset CLAUDECODE  # 避免 nested session 檢測
    # 關閉繼承的 pipe FD，避免 $() 命令替換阻塞
    exec > /dev/null 2>&1
    eval "$(_claude_base_args "$uuid" "$mem_dir") -p $(printf '%q' "$prompt")" > "$log_file" 2>&1
  ) &
  local bg_pid=$!
  echo "$bg_pid" > "$pid_file"
  echo "$bg_pid"
}

# print 模式：follow-up（--resume -p）
send_followup_print() {
  local id="$1" project_dir="$2" uuid="$3" mem_dir="$4" follow_up="$5"
  local log_file="$RESULTS_DIR/${id}.claude-followup.log"

  (
    cd "$project_dir"
    unset CLAUDECODE  # 避免 nested session 檢測
    # 關閉繼承的 pipe FD，避免 $() 命令替換阻塞
    exec > /dev/null 2>&1
    # --resume <session-id> -p：恢復特定 session 並送新 prompt
    # 注意：不能用 --session-id + --resume（ECC 要求搭配 --fork-session）
    CLAUDE_MEM_DATA_DIR="$mem_dir" VIBE_SKIP_RESUME=1 claude --model "$MODEL" --dangerously-skip-permissions --plugin-dir "$VIBE_PLUGIN" --plugin-dir "$FORGE_PLUGIN" --resume "$uuid" -p "$(printf '%s' "$follow_up")" > "$log_file" 2>&1
  ) &
  local bg_pid=$!
  echo "$bg_pid" > "/tmp/vibe-e2e-pid-${id}"
  echo "$bg_pid"
}

# print 模式：停止 claude（kill background process）
stop_claude_print() {
  local id="$1"
  local pid_file="/tmp/vibe-e2e-pid-${id}"
  if [ -f "$pid_file" ]; then
    local bg_pid
    bg_pid=$(cat "$pid_file")
    kill "$bg_pid" 2>/dev/null || true
    wait "$bg_pid" 2>/dev/null || true
    rm -f "$pid_file"
  fi
}

# ────────────────── 單一場景執行 ──────────────────

run_scenario() {
  local id="$1"
  local scenario_json
  scenario_json=$(get_scenario_json "$id")

  if [ -z "$scenario_json" ] || [ "$scenario_json" = "null" ]; then
    set_status "$id" "✗ 場景不存在"
    return 1
  fi

  local name prompt timeout_sec variant category follow_up
  name=$(echo "$scenario_json" | jq -r '.name')
  prompt=$(echo "$scenario_json" | jq -r '.prompt')
  timeout_sec=$(echo "$scenario_json" | jq -r '.timeout // 300')
  variant=$(echo "$scenario_json" | jq -r '.projectVariant // "default"')
  category=$(echo "$scenario_json" | jq -r '.category')
  follow_up=$(echo "$scenario_json" | jq -r '.followUp // empty')

  if [ "$DRY_RUN" = "true" ]; then
    set_status "$id" "⬜ [DRY RUN]"
    return 0
  fi

  local start_time
  start_time=$(date +%s)

  # 1. 複製專案
  set_status "$id" "⏳ 複製專案..."
  local project_dir
  project_dir=$(clone_project "$id")

  # 2. 套用變體
  if [ "$variant" != "default" ]; then
    set_status "$id" "⏳ 套用 $variant"
    apply_variant "$project_dir" "$variant"
  fi

  # 3. 產生 UUID
  local uuid
  uuid=$(uuidgen | tr '[:upper:]' '[:lower:]')

  # claude-mem 隔離：使用空的資料目錄，避免歷史記憶污染 E2E session
  local mem_dir="/tmp/e2e-claude-mem-$$-${id}"
  mkdir -p "$mem_dir"

  # 4. 啟動 claude session + 送出 prompt
  set_status "$id" "⏳ 啟動 claude..."
  local sess="" claude_pid=""

  if [ "$USE_TMUX" = "true" ]; then
    sess=$(start_claude_tmux "$id" "$project_dir" "$uuid" "$mem_dir")
    set_status "$id" "⏳ 送 prompt..."
    send_prompt_tmux "$sess" "$prompt"
  else
    set_status "$id" "⏳ 送 prompt..."
    claude_pid=$(start_claude_print "$id" "$project_dir" "$uuid" "$mem_dir" "$prompt")
  fi

  # 5. 等待完成
  local final_status="UNKNOWN"

  if [ "$id" = "E05" ]; then
    final_status=$(wait_for_plan_then_cancel "$uuid" "$sess" "$timeout_sec" "$id")
  elif [ -n "$follow_up" ]; then
    final_status=$(handle_follow_up "$uuid" "$sess" "$follow_up" "$timeout_sec" "$id" "$project_dir" "$mem_dir")
  else
    final_status=$(poll_state "$uuid" "$timeout_sec" "$id" "$sess")
  fi

  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - start_time))

  # 7. 驗證結果
  set_status "$id" "⏳ 驗證中..."
  local result_file="$RESULTS_DIR/${id}.json"

  if [ "$final_status" = "TIMEOUT" ]; then
    cat > "$result_file" << EOF
{
  "scenarioId": "$id",
  "scenarioName": "$name",
  "category": "$category",
  "sessionId": "$uuid",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "逾時",
  "timeout": $timeout_sec,
  "duration": $duration,
  "summary": { "passed": 0, "failed": 1, "warnings": 0, "total": 1 },
  "checks": [{ "name": "timeout", "passed": false, "required": true, "error": "閒置超過 ${timeout_sec}s" }]
}
EOF
    set_status "$id" "✗ 逾時 (${duration}s)"
  else
    VIBE_E2E_RESULTS_DIR="$RESULTS_DIR" node "$VALIDATE_SCRIPT" "$uuid" "$id" "$SCENARIOS_FILE" > "$result_file" 2>/dev/null || true

    if [ -f "$result_file" ]; then
      node -e "
        const fs = require('fs');
        const r = JSON.parse(fs.readFileSync('$result_file','utf8'));
        r.duration = $duration;
        fs.writeFileSync('$result_file', JSON.stringify(r, null, 2));
      " 2>/dev/null || true
    fi

    local status
    status=$(node -e "
      try { console.log(JSON.parse(require('fs').readFileSync('$result_file','utf8')).status); }
      catch(e) { console.log('ERROR'); }
    " 2>/dev/null)

    if [ "$status" = "通過" ] || [ "$status" = "PASS" ]; then
      set_status "$id" "✓ 通過 (${duration}s)"
    else
      set_status "$id" "✗ ${status} (${duration}s)"
    fi
  fi

  # 8. 關閉 claude session
  if [ "$USE_TMUX" = "true" ]; then
    stop_claude_tmux "$sess"
  else
    stop_claude_print "$id"
  fi

  # 9. 清理暫存目錄
  if [ "$KEEP_TMP" != "true" ]; then
    rm -rf "$project_dir"
    rm -rf "/tmp/e2e-claude-mem-$$-${id}"
  fi
}

# ────────────────── 主流程 ──────────────────

main() {
  echo -e "${CYAN}${BOLD}"
  local mode_label="tmux"
  [ "$USE_TMUX" != "true" ] && mode_label="print"
  echo "  ╔═══════════════════════════════════════╗"
  echo "  ║   Pipeline E2E 測試框架 v1.1          ║"
  echo "  ║   模式: ${mode_label}                            ║"
  echo "  ╚═══════════════════════════════════════╝"
  echo -e "${RESET}"

  check_prerequisites

  # 解析場景
  local filter="${*:-all}"
  local scenario_ids=()

  for arg in "$@"; do
    while IFS= read -r id; do
      scenario_ids+=("$id")
    done < <(get_scenario_ids "$arg")
  done

  # 沒有參數 → 全部
  if [ ${#scenario_ids[@]} -eq 0 ]; then
    while IFS= read -r id; do
      scenario_ids+=("$id")
    done < <(get_scenario_ids "all")
  fi

  # 去重（相容 bash 3.2，不用 declare -A）
  local unique_ids=()
  local seen_list=""
  for id in "${scenario_ids[@]}"; do
    case ",$seen_list," in
      *",$id,"*) ;;
      *)
        unique_ids+=("$id")
        seen_list="${seen_list}${id},"
        ;;
    esac
  done

  # 建立結果目錄
  mkdir -p "$RESULTS_DIR"

  # 建立 latest symlink
  ln -sfn "$TIMESTAMP" "$SCRIPT_DIR/results/latest"

  # 執行成本排序（none→fix→docs→...→full）
  local cost_order=(
    A10 B03       # none（最便宜）
    A04 B02 B07   # fix
    E01           # v4: fix 單階段（便宜）
    A08 B05 B08   # docs-only
    A07           # review-only
    C03 C04 C05   # 模糊測試
    A03 B04 D04   # quick-dev
    E02           # v4: quick-dev 三階段
    E06           # v4: pipeline 完成後 state 清理
    A06           # ui-only
    A09           # security
    A05           # test-first
    A02 B01 B06 D03 # standard
    E03           # v4: Guard 阻擋驗證（standard）
    C01 C02       # 回復（retry + 升級）
    E04           # v4: REVIEW FAIL 回退（含 retryHistory 驗證）
    E05           # v4: cancel 中斷（最後跑）
    A01 D01 D02 D05 # full / 環境
  )

  # 按成本排序過濾場景
  local ordered_ids=()
  for oid in "${cost_order[@]}"; do
    for uid in "${unique_ids[@]}"; do
      if [ "$oid" = "$uid" ]; then
        ordered_ids+=("$oid")
        break
      fi
    done
  done

  # 補上不在 cost_order 中的場景
  for uid in "${unique_ids[@]}"; do
    local found=false
    for oid in "${ordered_ids[@]}"; do
      if [ "$oid" = "$uid" ]; then
        found=true
        break
      fi
    done
    if [ "$found" = "false" ]; then
      ordered_ids+=("$uid")
    fi
  done

  local total=${#ordered_ids[@]}
  local parallel="${VIBE_E2E_PARALLEL:-1}"

  # ─── 初始化 Dashboard ───
  init_dashboard "${ordered_ids[@]}"

  if [ "$parallel" -le 1 ]; then
    # ─── 序列執行 ───
    for id in "${ordered_ids[@]}"; do
      run_scenario "$id" > /dev/null 2>&1 || true
    done
  else
    # ─── 並行執行 ───
    start_render_loop

    local running=0
    local pids=""

    for id in "${ordered_ids[@]}"; do
      # 等待空位
      while [ "$running" -ge "$parallel" ]; do
        sleep 3
        local new_pids=""
        running=0
        for pid in $pids; do
          if kill -0 "$pid" 2>/dev/null; then
            new_pids="$new_pids $pid"
            running=$((running + 1))
          fi
        done
        pids="$new_pids"
      done

      # 背景執行
      run_scenario "$id" > /dev/null 2>&1 &
      pids="$pids $!"
      running=$((running + 1))

      # 錯開啟動避免 git clone 競爭
      sleep 2
    done

    # 等待所有剩餘 jobs
    for pid in $pids; do
      wait "$pid" 2>/dev/null || true
    done

    stop_render_loop
  fi

  # ─── 統計結果 + 報告 ───
  if [ "$DRY_RUN" = "true" ]; then
    echo "" >&3
    printf '  %b[DRY RUN] %d 個場景已列出%b\n' '\033[0;33m' "$total" '\033[0m' >&3
  else
    local passed=0
    local failed=0
    for id in "${ordered_ids[@]}"; do
      local result_file="$RESULTS_DIR/${id}.json"
      if [ -f "$result_file" ]; then
        local status
        status=$(node -e "
          try { console.log(JSON.parse(require('fs').readFileSync('$result_file','utf8')).status); }
          catch(e) { console.log('ERROR'); }
        " 2>/dev/null)
        if [ "$status" = "通過" ] || [ "$status" = "PASS" ]; then
          passed=$((passed + 1))
        else
          failed=$((failed + 1))
        fi
      else
        failed=$((failed + 1))
      fi
    done

    echo "" >&3
    printf '  %b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' '\033[0;36m' '\033[0m' >&3
    printf '  %b執行完成: %d 通過 / %d 失敗 (共 %d)%b\n' '\033[1m' "$passed" "$failed" "$total" '\033[0m' >&3
    echo "" >&3

    printf '  %b產出報告...%b\n' '\033[2m' '\033[0m' >&3
    node "$REPORT_SCRIPT" "$RESULTS_DIR" >&3 2>&1
  fi

  cleanup_dashboard
}

main "$@"
