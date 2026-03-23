#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is not installed or not in PATH."
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Error: .env file is missing in ${ROOT_DIR}"
  echo "Create it first: cp env.example .env"
  exit 1
fi

# zsh/bash: ensure sourced vars are exported to child processes (bun).
set -a
source ./.env
set +a

export JOBDONE_ORGANIZATION_NAME="${JOBDONE_ORGANIZATION_NAME:-lightspeed-example}"
export IS_DRY_RUN="${IS_DRY_RUN:-true}"
export RUN_ONCE="${RUN_ONCE:-true}"
export CRON_TIME="${CRON_TIME:-0 * * * *}"

required_vars=(
  JOBDONE_ORGANIZATION_ID
  JOBDONE_ORGANIZATION_NAME
  JOBDONE_ORGANIZATION_USER_ID
  JOBDONE_USERNAME
  JOBDONE_PASSWORD
  JOBDONE_AUTH_REGION
  JOBDONE_USER_POOL_ID
  JOBDONE_USER_POOL_WEB_CLIENT_ID
  JOBDONE_GRAPHQL_ENDPOINT
  JOBDONE_GRAPHQL_ADMIN_SECRET
  JOBDONE_CLIENT_ID
  JOBDONE_CLIENT_NAME
  DISCORD_WEBHOOK_URL
  LSK_CLIENT_ID
  LSK_CLIENT_SECRET
  LSK_REFRESH_TOKEN
  LSK_REDIRECT_URI
  LSK_BUSINESS_LOCATION_ID_1
)

missing=()
for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("${name}")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "Error: missing required environment variables:"
  for name in "${missing[@]}"; do
    echo "  - ${name}"
  done
  exit 1
fi

echo "Environment check passed."
echo "JOBDONE_ORGANIZATION_NAME=${JOBDONE_ORGANIZATION_NAME}"
echo "IS_DRY_RUN=${IS_DRY_RUN}"
echo "RUN_ONCE=${RUN_ONCE}"
echo "LSK_BUSINESS_LOCATION_ID_1=${LSK_BUSINESS_LOCATION_ID_1}"

bun run start
