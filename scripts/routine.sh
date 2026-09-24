#!/usr/bin/env bash
# One scheduled session: trade for N minutes, then print a status summary.
# Used by the hourly Claude Code routine; also fine for any cron.
set -euo pipefail
cd "$(dirname "$0")/.."
MINUTES="${1:-55}"
if [[ -z "${AGENT_SECRET_KEY:-}" || -z "${FAMILIARS_API_KEY:-}" ]]; then
  echo "AGENT_SECRET_KEY / FAMILIARS_API_KEY are not set in this environment; nothing to do." >&2
  exit 2
fi
export TRADING_MODE="${TRADING_MODE:-live}"
npm ci --no-audit --no-fund --silent
npx tsx src/cli/run.ts --interval 60 --minutes "$MINUTES"
npx tsx src/cli/status.ts
