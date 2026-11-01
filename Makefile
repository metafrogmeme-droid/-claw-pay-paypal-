.PHONY: install check test lint typecheck format copy-lint gitleaks-selftest secrets contracts demo demo-paypal

install:
	pnpm install --frozen-lockfile

check:
	pnpm run check

test:
	pnpm run coverage

lint:
	pnpm run lint

typecheck:
	pnpm run typecheck

format:
	pnpm run format

copy-lint:
	pnpm run copy-lint

gitleaks-selftest:
	bash scripts/gitleaks-selftest.sh

secrets:
	gitleaks git --no-banner --redact --config .gitleaks.toml .

contracts:
	cd contracts && forge fmt --check && forge build

demo:
	@echo "make demo (x402) arrives in a later milestone." >&2; exit 1

demo-paypal:
	pnpm -r run build
	node packages/cli/dist/bin/cp-demo-paypal.js
