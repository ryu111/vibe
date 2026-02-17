#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# run.sh — Pipeline E2E 測試驅動器
#
# 用法:
#   ./run.sh              # 跑全部 29 個場景
#   ./run.sh A            # 跑 A 分類（Pipeline 正路徑）
#   ./run.sh A04          # 跑單一場景
#   ./run.sh A04 A10 B03  # 跑指定場景
#   ./run.sh smoke        # 冒煙測試（A10 + A04）
#
# 環境變數:
#   VIBE_E2E_MODEL     測試模型（預設 haiku）
#   VIBE_E2E_PARALLEL  同時執行場景數（預設 1，建議 1-3）
#   VIBE_E2E_KEEP_TMP  保留暫存目錄（除錯用）
#   VIBE_E2E_DRY_RUN   只顯示場景列表不執行
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

MODEL="${VIBE_E2E_MODEL:-haiku}"
KEEP_TMP="${VIBE_E2E_KEEP_TMP:-false}"
DRY_RUN="${VIBE_E2E_DRY_RUN:-false}"

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

# ────────────────── 信號處理 ──────────────────

cleanup_on_exit() {
  echo ""
  echo -e "${YELLOW}收到中斷信號，清理殘留 tmux sessions...${RESET}"
  for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^e2e-'); do
    tmux kill-session -t "$sess" 2>/dev/null || true
  done
  # 產出已完成的結果報告
  if [ -d "$RESULTS_DIR" ] && ls "$RESULTS_DIR"/*.json 1>/dev/null 2>&1; then
    echo -e "${DIM}產出部分結果報告...${RESET}"
    node "$REPORT_SCRIPT" "$RESULTS_DIR" 2>/dev/null || true
  fi
  exit 130
}

trap cleanup_on_exit INT TERM

# ────────────────── 前置檢查 ──────────────────

check_prerequisites() {
  local missing=0

  if ! command -v tmux &>/dev/null; then
    echo -e "${RED}tmux 未安裝${RESET}"
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
    # 全部場景
    jq -r '.scenarios[].id' "$SCENARIOS_FILE"
  elif [ "$filter" = "smoke" ]; then
    # 冒煙測試：最便宜的兩個
    echo "A10"
    echo "A04"
  elif [[ "$filter" =~ ^[A-D]$ ]]; then
    # 分類篩選
    jq -r ".scenarios[] | select(.category == \"$filter\") | .id" "$SCENARIOS_FILE"
  else
    # 單一或多個場景 ID
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

  # 清理殘留
  rm -rf "$target"

  # 淺複製（~2 秒）
  git clone --depth 1 --single-branch "file://$VIBE_ROOT" "$target" 2>/dev/null

  echo "$target"
}

# ────────────────── 專案變體 ──────────────────

apply_variant() {
  local project_dir="$1"
  local variant="$2"

  case "$variant" in
    "default")
      # 不需修改
      ;;
    "buggy-review")
      # 植入 console.log 殘留讓 reviewer 報 FAIL
      echo "console.log('DEBUG_LEFTOVER_FOR_REVIEW');" >> "$project_dir/plugins/vibe/scripts/lib/hook-logger.js"
      (cd "$project_dir" && git add -A && git commit -m "inject buggy code for review test" --no-verify 2>/dev/null) || true
      ;;
    "buggy-test")
      # 植入必定失敗的測試
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
      # 模擬前端專案（next.config.js + react 依賴）
      echo "module.exports = { reactStrictMode: true };" > "$project_dir/next.config.js"
      mkdir -p "$project_dir/src/components"
      echo "export default function App() { return <div>Hello</div>; }" > "$project_dir/src/components/App.tsx"
      # 注入 package.json 前端依賴
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
      echo -e "${YELLOW}未知 variant: $variant，使用 default${RESET}"
      ;;
  esac
}

# ────────────────── 等待 State 檔案 ──────────────────

poll_state() {
  local uuid="$1"
  local timeout="$2"
  local scenario_id="$3"
  local sess="$4"
  local elapsed=0
  local state_file="$CLAUDE_DIR/pipeline-state-${uuid}.json"
  local poll_interval=10
  local ask_handled=0

  while true; do
    if (( elapsed > timeout )); then
      echo "TIMEOUT"
      return 1
    fi

    if [ -f "$state_file" ]; then
      local phase
      phase=$(node -e "
        try {
          const s = JSON.parse(require('fs').readFileSync('$state_file','utf8'));
          console.log(s.phase || 'UNKNOWN');
        } catch(e) { console.log('UNKNOWN'); }
      " 2>/dev/null)

      case "$phase" in
        COMPLETE)
          echo -e "  ${DIM}[${elapsed}s] phase=COMPLETE${RESET}" >&2
          # 不回應 AskUserQuestion — 全域規則會讓 Claude 在 pipeline 完成後
          # 觸發 AskUserQuestion，回應 "1" 會被 task-classifier 當作新 prompt
          # 重新分類，覆蓋 state。直接返回讓 caller 驗證後 /exit。
          echo "COMPLETE"
          return 0
          ;;
        IDLE)
          # none pipeline 或完成後重設
          local pid
          pid=$(node -e "
            try {
              const s = JSON.parse(require('fs').readFileSync('$state_file','utf8'));
              console.log(s.context && s.context.pipelineId || '');
            } catch(e) { console.log(''); }
          " 2>/dev/null)
          if [ "$pid" = "none" ]; then
            echo -e "  ${DIM}[${elapsed}s] none pipeline 偵測到，等 15s${RESET}" >&2
            sleep 15
            echo "NONE_COMPLETE"
            return 0
          fi
          ;;
        CLASSIFIED|DELEGATING|RETRYING)
          echo -e "  ${DIM}[${elapsed}s] phase=$phase${RESET}" >&2
          ;;
      esac
    else
      echo -e "  ${DIM}[${elapsed}s] 等待 state 檔案...${RESET}" >&2
    fi

    sleep "$poll_interval"
    elapsed=$((elapsed + poll_interval))
  done
}

# ────────────────── Cancel 場景特殊處理 ──────────────────

wait_for_plan_then_cancel() {
  local uuid="$1"
  local sess="$2"
  local timeout="$3"
  local state_file="$CLAUDE_DIR/pipeline-state-${uuid}.json"
  local elapsed=0

  echo -e "  ${DIM}等待 PLAN 完成後送 /cancel...${RESET}" >&2

  while (( elapsed < timeout )); do
    if [ -f "$state_file" ]; then
      local has_plan
      has_plan=$(node -e "
        try {
          const s = JSON.parse(require('fs').readFileSync('$state_file','utf8'));
          const r = s.progress && s.progress.stageResults;
          console.log(r && r.PLAN ? 'yes' : 'no');
        } catch(e) { console.log('no'); }
      " 2>/dev/null)

      if [ "$has_plan" = "yes" ]; then
        echo -e "  ${DIM}[${elapsed}s] PLAN 完成，送 /cancel${RESET}" >&2
        sleep 3
        tmux send-keys -t "$sess" -l "/cancel" 2>/dev/null
        tmux send-keys -t "$sess" Enter 2>/dev/null
        # 等 cancel 處理（不回應 AskUserQuestion，同理）
        sleep 10
        echo "CANCELLED"
        return 0
      fi
    fi

    sleep 5
    elapsed=$((elapsed + 5))
  done

  echo "TIMEOUT"
  return 1
}

# ────────────────── Follow-up 場景處理 ──────────────────

handle_follow_up() {
  local uuid="$1"
  local sess="$2"
  local follow_up="$3"
  local timeout="$4"

  # 先等第一個 pipeline 完成
  local result
  result=$(poll_state "$uuid" "$timeout" "" "$sess")

  if [ "$result" = "COMPLETE" ] || [ "$result" = "NONE_COMPLETE" ]; then
    echo -e "  ${DIM}第一輪完成，送 follow-up...${RESET}" >&2
    sleep 5
    # 先回應 AskUserQuestion（如果有的話）
    # 然後等一下再送 follow-up
    sleep 3
    tmux send-keys -t "$sess" -l "$follow_up"
    sleep 1
    tmux send-keys -t "$sess" Enter
    # 重新等待
    sleep 5
    local result2
    result2=$(poll_state "$uuid" "$timeout" "" "$sess")
    echo "$result2"
  else
    echo "$result"
  fi
}

# ────────────────── 單一場景執行 ──────────────────

run_scenario() {
  local id="$1"
  local scenario_json
  scenario_json=$(get_scenario_json "$id")

  if [ -z "$scenario_json" ] || [ "$scenario_json" = "null" ]; then
    echo -e "${RED}場景 $id 不存在${RESET}"
    return 1
  fi

  local name prompt timeout_sec variant category follow_up
  name=$(echo "$scenario_json" | jq -r '.name')
  prompt=$(echo "$scenario_json" | jq -r '.prompt')
  timeout_sec=$(echo "$scenario_json" | jq -r '.timeout // 300')
  variant=$(echo "$scenario_json" | jq -r '.projectVariant // "default"')
  category=$(echo "$scenario_json" | jq -r '.category')
  follow_up=$(echo "$scenario_json" | jq -r '.followUp // empty')

  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}[$id] $name${RESET}"
  echo -e "${DIM}  pipeline: $(echo "$scenario_json" | jq -r '.expected.pipelineId // "auto"')${RESET}"
  echo -e "${DIM}  timeout: ${timeout_sec}s | variant: $variant${RESET}"

  if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}  [DRY RUN] 跳過執行${RESET}"
    return 0
  fi

  local start_time
  start_time=$(date +%s)

  # 1. 複製專案
  echo -e "  ${DIM}複製專案...${RESET}"
  local project_dir
  project_dir=$(clone_project "$id")

  # 2. 套用變體
  if [ "$variant" != "default" ]; then
    echo -e "  ${DIM}套用變體: $variant${RESET}"
    apply_variant "$project_dir" "$variant"
  fi

  # 3. 產生 UUID
  local uuid
  uuid=$(uuidgen | tr '[:upper:]' '[:lower:]')

  # 4. 啟動 claude session（獨立 tmux session per scenario）
  local sess="e2e-${id}"

  # 清理殘留 session
  tmux kill-session -t "$sess" 2>/dev/null || true

  # 建立新 detached session
  tmux new-session -d -s "$sess" -x 200 -y 50

  # 等 tmux 就緒
  sleep 1

  # 送出 claude 啟動命令
  local claude_cmd="cd '$project_dir' && claude --session-id '$uuid' --model '$MODEL' --dangerously-skip-permissions --plugin-dir '$VIBE_PLUGIN' --plugin-dir '$FORGE_PLUGIN'"
  tmux send-keys -t "$sess" "$claude_cmd" Enter

  echo -e "  ${DIM}等待 claude 啟動 (session=$uuid)...${RESET}"
  sleep 10

  # 5. 送出 prompt
  local prompt_preview="$prompt"
  if [ ${#prompt_preview} -gt 80 ]; then
    prompt_preview="${prompt_preview:0:77}..."
  fi
  echo -e "  ${DIM}送出 prompt: ${CYAN}${prompt_preview}${RESET}"
  tmux send-keys -t "$sess" -l "$prompt"
  sleep 1
  tmux send-keys -t "$sess" Enter

  # 6. 等待完成
  local final_status="UNKNOWN"

  if [ "$id" = "C03" ]; then
    # Cancel 場景：等 PLAN 完成後送 /cancel
    final_status=$(wait_for_plan_then_cancel "$uuid" "$sess" "$timeout_sec")
  elif [ -n "$follow_up" ]; then
    # Follow-up 場景：第一輪完成後送後續
    final_status=$(handle_follow_up "$uuid" "$sess" "$follow_up" "$timeout_sec")
  else
    # 正常場景
    final_status=$(poll_state "$uuid" "$timeout_sec" "$id" "$sess")
  fi

  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - start_time))

  # 7. 驗證結果（用快照）
  echo -e "  ${DIM}驗證結果...${RESET}"
  local result_file="$RESULTS_DIR/${id}.json"

  if [ "$final_status" = "TIMEOUT" ]; then
    # Timeout — 產出特殊結果
    cat > "$result_file" << EOF
{
  "scenarioId": "$id",
  "scenarioName": "$name",
  "category": "$category",
  "sessionId": "$uuid",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "TIMEOUT",
  "timeout": $timeout_sec,
  "duration": $duration,
  "summary": { "passed": 0, "failed": 1, "warnings": 0, "total": 1 },
  "checks": [{ "name": "timeout", "passed": false, "required": true, "error": "超過 ${timeout_sec}s 時限" }]
}
EOF
    echo -e "  ${RED}✗ TIMEOUT (${duration}s)${RESET}"
  else
    # 正常驗證
    node "$VALIDATE_SCRIPT" "$uuid" "$id" "$SCENARIOS_FILE" > "$result_file" 2>/dev/null || true

    # 注入 duration
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

    if [ "$status" = "PASS" ]; then
      echo -e "  ${GREEN}✓ PASS (${duration}s)${RESET}"
    else
      echo -e "  ${RED}✗ $status (${duration}s)${RESET}"
    fi
  fi

  # 8. 關閉 claude session
  echo -e "  ${DIM}清理...${RESET}"
  tmux send-keys -t "$sess" -l "/exit" 2>/dev/null || true
  sleep 1
  tmux send-keys -t "$sess" Enter 2>/dev/null || true
  sleep 3

  # 關閉 tmux session
  tmux kill-session -t "$sess" 2>/dev/null || true

  # 9. 清理暫存目錄
  if [ "$KEEP_TMP" != "true" ]; then
    rm -rf "$project_dir"
  else
    echo -e "  ${DIM}保留暫存: $project_dir${RESET}"
  fi

  echo -e "  ${DIM}完成 [$id] (${duration}s)${RESET}"
}

# ────────────────── 主流程 ──────────────────

main() {
  echo -e "${CYAN}${BOLD}"
  echo "  ╔═══════════════════════════════════════╗"
  echo "  ║   Pipeline E2E 測試框架 v1.0          ║"
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
      *",$id,"*) ;;  # 已見過
      *)
        unique_ids+=("$id")
        seen_list="${seen_list}${id},"
        ;;
    esac
  done

  echo -e "${BOLD}場景: ${#unique_ids[@]} 個${RESET}"
  echo -e "${DIM}模型: $MODEL | 結果: $RESULTS_DIR${RESET}"
  echo ""

  if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}[DRY RUN 模式]${RESET}"
  fi

  # 建立結果目錄
  mkdir -p "$RESULTS_DIR"

  # 建立 latest symlink
  ln -sfn "$TIMESTAMP" "$SCRIPT_DIR/results/latest"

  # 執行成本排序（none→fix→docs→...→full）
  local cost_order=(
    A10 B03       # none（最便宜）
    A04 B02       # fix
    A08 B05       # docs-only
    A07           # review-only
    C06 C07 C08   # 模糊測試
    A03 B04 D04   # quick-dev
    A06           # ui-only
    A09           # security
    A05           # test-first
    A02 B01 B06 D03 # standard
    C01 C02 C03 C04 C05 # 回復
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

  # 執行
  local total=${#ordered_ids[@]}
  local parallel="${VIBE_E2E_PARALLEL:-1}"

  echo -e "${DIM}並行度: $parallel${RESET}"
  echo ""

  if [ "$parallel" -le 1 ]; then
    # ─── 序列執行 ───
    local current=0
    for id in "${ordered_ids[@]}"; do
      current=$((current + 1))
      echo -e "${BLUE}[${current}/${total}]${RESET} 執行場景 $id"
      run_scenario "$id" || true
    done
  else
    # ─── 並行執行 ───
    local running=0
    local launched=0
    local pids=""

    for id in "${ordered_ids[@]}"; do
      # 等待空位
      while [ "$running" -ge "$parallel" ]; do
        sleep 3
        # 收割完成的 jobs
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

      launched=$((launched + 1))
      echo -e "${BLUE}[${launched}/${total}]${RESET} ${BOLD}啟動${RESET} $id ${DIM}(slot $((running + 1))/$parallel)${RESET}"

      # 背景執行
      run_scenario "$id" &
      pids="$pids $!"
      running=$((running + 1))

      # 錯開啟動避免 git clone 競爭
      sleep 2
    done

    # 等待所有剩餘 jobs
    echo -e "${DIM}等待 $running 個場景完成...${RESET}"
    for pid in $pids; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  # 統計結果
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
      if [ "$status" = "PASS" ]; then
        passed=$((passed + 1))
      else
        failed=$((failed + 1))
      fi
    else
      failed=$((failed + 1))
    fi
  done

  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}執行完成: $passed PASS / $failed FAIL (共 $total)${RESET}"
  echo ""

  # 產出報告
  if [ "$DRY_RUN" != "true" ]; then
    echo -e "${DIM}產出報告...${RESET}"
    node "$REPORT_SCRIPT" "$RESULTS_DIR"
  fi
}

main "$@"
