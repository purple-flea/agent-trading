#!/bin/bash
# Trading Smoke Test — checks all public endpoints return 200
# Usage: ./trading-smoke-test.sh [BASE_URL]
# Default BASE_URL: http://localhost:3003

BASE_URL="${1:-http://localhost:3003}"
PASS=0
FAIL=0
ERRORS=()

check() {
  local method="$1"
  local path="$2"
  local desc="$3"
  local body="$4"
  local expected="${5:-200}"

  if [ -n "$body" ]; then
    status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "${BASE_URL}${path}")
  else
    status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "${BASE_URL}${path}")
  fi

  if [ "$status" = "$expected" ]; then
    echo "  ✓ $method $path ($desc) → $status"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $method $path ($desc) → $status (expected $expected)"
    FAIL=$((FAIL + 1))
    ERRORS+=("$method $path: got $status, expected $expected")
  fi
}

echo "=== Trading Smoke Test ==="
echo "Target: $BASE_URL"
echo ""

echo "--- Public endpoints ---"
check GET /health "health check"
check GET /v1/gossip "gossip"
check GET /v1/public-stats "public stats"
check GET /v1/markets "all markets"
check GET /v1/markets/stocks "stock markets"
check GET /v1/markets/commodities "commodity markets"
check GET /v1/markets/rwa "RWA markets"
check GET /v1/markets/signals "market signals"
check GET "/v1/markets/multi-price?coins=BTC,ETH,SOL" "multi-price batch"
check GET "/v1/markets/BTC" "BTC market details"
check GET "/v1/markets/BTC/price" "BTC price"
check GET /v1/copy/leaderboard "copy leaderboard"
check GET /v1/signals "trading signals"
check GET /v1/markets/heatmap "market heatmap"
check GET "/v1/trade/risk-calc?entry=50000&stop=48000&target=55000&size_usd=1000&leverage=5" "pre-trade risk calculator"
check GET /v1/leaderboard "trading leaderboard"
check POST /v1/backtest "strategy backtester" '{"strategy":"sma_crossover","market":"BTC","days":14}'
check GET /changelog "changelog"
check GET /robots.txt "robots.txt"
check GET /sitemap.xml "sitemap"
check GET /.well-known/agent.json "agent.json"
check GET /.well-known/purpleflea.json "purpleflea.json"
check GET /network "network"
check GET /openapi.json "openapi spec"
check GET /llms.txt "llms.txt"
check GET /favicon.ico "favicon" "" 204
check GET /ping "ping"

echo ""
echo "--- Auth endpoints return 401 without token ---"
check GET /v1/auth/account "account (no auth)" "" 401
check POST /v1/trade/open "trade open (no auth)" '{"coin":"BTC","side":"long","size_usd":100}' 401

echo ""
echo "--- Redirect ---"
check GET /v1/stats "stats redirect" "" 301

echo ""
echo "--- 404 handling ---"
check GET /nonexistent-path "404 handler" "" 404

echo ""
echo "==========================="
echo "Results: $PASS passed, $FAIL failed"
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "FAILURES:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
else
  echo "All checks passed!"
  exit 0
fi
