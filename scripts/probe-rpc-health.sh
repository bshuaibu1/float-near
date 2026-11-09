#!/usr/bin/env bash
# Can this MACHINE read the chain reliably enough to be trusted?
#
# WHY THIS IS A SCRIPT AND NOT A JUDGEMENT CALL. Two decisions in this project
# turn on read reliability and both were nearly made on bad evidence:
#
#   1. A SIX-STEP IRREVERSIBLE TEARDOWN. `ft_balance_of` on a throttled RPC
#      returns nothing, the caller's catch turns that into "0", and "0" reads
#      as "no tokens to withdraw" — so the vault is deleted with money inside.
#      The same applies to the gas-key balance, which `DeleteKey` BURNS while
#      reporting success (0.08322 NEAR measured lost that way).
#
#   2. WHETHER THE HOSTED DASHBOARD IS USABLE. A dev box that has been
#      hammering a free endpoint all day measures 3/12 and looks like a
#      product defect. It is not: it is that IP's throttle. A number measured
#      on a developer's machine is NOT evidence about production, and acting
#      on one nearly produced a config change plus a spending recommendation.
#
# So: measure, on the machine that will actually do the thing, and print a
# verdict rather than a number to be interpreted later.
#
# READ-ONLY AND KEYLESS BY DESIGN. Every call here is a view. This is safe to
# run on a box you do not trust, which is the point — a candidate host can be
# measured before anything is deployed and before any credential exists on it.
#
# Usage:
#   ./scripts/probe-rpc-health.sh
#   RPC=https://my-authenticated-endpoint CALLS=40 ./scripts/probe-rpc-health.sh
set -uo pipefail

RPC="${RPC:-https://test.rpc.fastnear.com}"
CALLS="${CALLS:-20}"
GAP="${GAP:-1}"
# A real account on the target network. Defaults to the live demo vault's
# owner, which exists and is cheap to view.
PROBE_ACCOUNT="${PROBE_ACCOUNT:-flatdata6673.testnet}"
# The threshold a DESTRUCTIVE operation needs. Deliberately strict: the cost
# of waiting is minutes, the cost of a wrong read is an unrecoverable account.
NEED_PCT="${NEED_PCT:-95}"

echo "probing $RPC"
echo "  $CALLS view calls, ${GAP}s apart, account $PROBE_ACCOUNT"
echo

ok=0; fail=0; first_fail=""
for i in $(seq 1 "$CALLS"); do
  body=$(curl -s --max-time 12 -X POST "$RPC" \
    -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$PROBE_ACCOUNT\"}}" 2>/dev/null)
  # SUCCESS IS A POSITIVE MATCH, never "curl exited 0". A throttle reply is a
  # well-formed 200 JSON body carrying an error, so exit status says nothing.
  if printf '%s' "$body" | grep -q '"amount"'; then
    ok=$((ok+1)); printf "."
  else
    fail=$((fail+1)); printf "x"
    if [ -z "$first_fail" ]; then
      first_fail=$(printf '%s' "$body" | tr -d '\n' | cut -c1-160)
      [ -n "$first_fail" ] || first_fail="(empty response — connection failed or timed out)"
    fi
  fi
  sleep "$GAP"
done
echo; echo

pct=$(( ok * 100 / CALLS ))
echo "  ok   $ok/$CALLS  (${pct}%)"
echo "  fail $fail/$CALLS"
[ -n "$first_fail" ] && echo "  first failure: $first_fail"
echo

# POSITIVE CONTROL. 0/N and "the probe itself is broken" are the same output,
# so a total failure must not be reported as a confident throttle verdict.
if [ "$ok" -eq 0 ]; then
  echo "  INCONCLUSIVE — not a single call succeeded."
  echo "  That is also what a wrong URL, a dead endpoint, or no outbound network"
  echo "  looks like. Check the endpoint resolves and answers at all before"
  echo "  concluding anything about rate limits:"
  echo "    curl -sS -X POST $RPC -H 'content-type: application/json' \\"
  echo "      -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"status\",\"params\":[]}' | head -c 300"
  exit 2
fi

if [ "$pct" -ge "$NEED_PCT" ]; then
  echo "  VERDICT: reliable (>= ${NEED_PCT}%). Safe for destructive work from THIS machine."
  exit 0
fi

echo "  VERDICT: THROTTLED (< ${NEED_PCT}%)."
echo
echo "  Do NOT run a teardown, a delete, or anything that treats a failed read"
echo "  as an empty balance. A throttled ft_balance_of becomes \"0\", \"0\" reads as"
echo "  \"nothing to withdraw\", and the account is deleted with funds inside."
echo
echo "  This is usually the IP's own throttle, not the endpoint being bad — and"
echo "  NOT evidence about what a production host would see. Measure there."
exit 1
