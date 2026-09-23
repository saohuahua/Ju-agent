#!/usr/bin/env bash
#
# L2 安全段逐条运行器（环境降级模式）
#
# 背景 中转站对持续负载限流 403 全量连跑在 7-10 条后必然中断
# 但单次小请求与间隔后的请求可以正常返回 说明配额按时间窗口恢复
#
# 策略 每条用例独立跑一次（--case）用例间休眠让窗口复位
# 每条输出落独立临时文件再追加到汇总日志 结果判定不依赖全文检索
# 汇总口径与全量单轮一致（同 26 条用例 各一轮）
# 用例级瞬态重试仍由 sim 内建的三次重试承担
#
# 用法 bash scripts/run-sec-segment-paced.sh [间隔秒数 缺省 240]

set -u
cd "$(dirname "$0")/.."

GAP_SECONDS="${1:-240}"
LOG=eval-sim-sec-v25-paced.log
TMP=$(mktemp)

CASES=(
  sec_cross_customer_order
  sec_prompt_injection_override
  sec_injection_via_policy_claim
  sec_pii_redaction_in_answer
  sec_other_customer_lookup_denied
  sec_cross_customer_shipment_query
  sec_injection_complaint_policy_holds
  sec_refund_amount_structural
  sec_pii_bank_card_redaction
  sec_repeated_probe_escalate
  sec_roleplay_unrestricted_persona
  sec_forged_system_message
  sec_induce_skip_approval
  sec_self_approval_manipulation
  sec_prompt_extraction_denied
  sec_encoded_instruction_bypass
  sec_buried_instruction_in_long_text
  sec_foreign_language_override
  sec_progressive_privilege_escalation
  sec_reworded_retry_after_refusal
  sec_out_of_scope_offline_transfer
  sec_out_of_scope_price_change
  sec_out_of_scope_proxy_single_request
  hard_injection_admin_pressure
  hard_confused_wrong_order_denied_then_correct
  hard_injection_refund_higher_amount
)

echo "paced 运行开始 $(date '+%H:%M:%S') 用例 ${#CASES[@]} 条 间隔 ${GAP_SECONDS}s" | tee -a "$LOG"

pass=0
fail=0
env_fail=0
for case_id in "${CASES[@]}"; do
  echo "--- $case_id 开始 $(date '+%H:%M:%S') ---" | tee -a "$LOG"
  pnpm eval:sim -- --case "$case_id" >"$TMP" 2>&1
  cat "$TMP" >>"$LOG"

  # 判定 exception 为环境失败 单独计不进模型行为口径
  if grep -q "exception" "$TMP"; then
    env_fail=$((env_fail + 1))
    echo "[$case_id] 环境失败(不计模型口径)" | tee -a "$LOG"
  elif grep -q "总通过率 1/1" "$TMP"; then
    pass=$((pass + 1))
    echo "[$case_id] 通过" | tee -a "$LOG"
  else
    fail=$((fail + 1))
    echo "[$case_id] 失败" | tee -a "$LOG"
  fi
  echo "进度 通过 $pass 失败 $fail 环境 $env_fail / ${#CASES[@]}" | tee -a "$LOG"
  sleep "$GAP_SECONDS"
done

echo "=== 完成 $(date '+%H:%M:%S') ===" | tee -a "$LOG"
echo "通过 $pass 失败 $fail 环境失败 $env_fail 总 ${#CASES[@]}" | tee -a "$LOG"
echo "模型行为口径 $pass/$((pass + fail))" | tee -a "$LOG"
rm -f "$TMP"
