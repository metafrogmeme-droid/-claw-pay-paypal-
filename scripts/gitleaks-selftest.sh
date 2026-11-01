#!/usr/bin/env bash
# gitleaks self-test: plant fake secrets in a temp dir and require .gitleaks.toml to catch each one,
# and require a clean file to pass. Fake values are generated at run time, so none live in the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/.gitleaks.toml"
GITLEAKS="${GITLEAKS:-gitleaks}"
command -v "$GITLEAKS" >/dev/null || { echo "gitleaks-selftest: gitleaks not found (set GITLEAKS=...)" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

hex64() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
alnum() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }

fail=0
expect() { # expect <want-exit> <name> <content>
  local want="$1" name="$2" content="$3" got=0
  mkdir -p "$WORK/$name"
  printf '%s\n' "$content" >"$WORK/$name/file.txt"
  "$GITLEAKS" dir --no-banner --log-level error --redact --config "$CONFIG" "$WORK/$name" >/dev/null 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    echo "ok   $name (exit $got)"
  else
    echo "FAIL $name: want exit $want, got $got" >&2
    fail=1
  fi
}

expect 1 evm-key-env      "CP_BUDGET_PRIVATE_KEY=0x$(hex64)"
expect 1 evm-key-json     "{\"ownerKey\": \"$(hex64)\"}"
expect 1 paypal-secret    "PAYPAL_CLIENT_SECRET=E$(alnum 60)"
expect 1 paypal-token-env "PAYPAL_ACCESS_TOKEN=\"$(alnum 40)\""
expect 1 paypal-token-raw "Authorization: Bearer A21AA$(alnum 80)"
expect 0 clean-example    "$(cat "$ROOT/.env.example")"
expect 0 tx-hash-in-docs  "| deploy tx | 0x$(hex64) |"

if [[ "$fail" != 0 ]]; then echo "gitleaks-selftest: FAILED" >&2; exit 1; fi
echo "gitleaks-selftest: all cases passed"
