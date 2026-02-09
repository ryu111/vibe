#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 腳本名稱：{{SCRIPT_NAME}}
# 用途：{{SCRIPT_PURPOSE}}
# 呼叫方：{{CALLER}}
# 輸入：stdin JSON（{{INPUT_DESCRIPTION}}）
# 輸出：stdout JSON（{{OUTPUT_DESCRIPTION}}）
# Exit codes：0={{EXIT_0_MEANING}}, 2={{EXIT_2_MEANING}}
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

INPUT=$(cat)

main() {
    # TODO: 實作主邏輯
    output_json "pass" "{{DEFAULT_MESSAGE}}"
}

main
