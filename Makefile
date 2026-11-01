.PHONY: install check test lint typecheck format copy-lint gitleaks-selftest secrets contracts demo demo-paypal sandbox-smoke sandbox-resume agent

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

# One real PayPal SANDBOX create_order (2.00 USD) through the gate. Needs PAYPAL_ENVIRONMENT=SANDBOX,
# PAYPAL_SANDBOX_CLIENT_ID/SECRET and PAYPAL_SANDBOX_PAYEE_MERCHANT_ID in the environment. Stops at the buyer step.
sandbox-smoke:
	pnpm -r run build
	node packages/cli/dist/bin/cp-sandbox-smoke.js

# After the buyer approved a sandbox order: get_order re-check (APPROVED, your payee, same amount), then one capture.
# ARGS="<order id> --amount 2.00". Same env as sandbox-smoke.
sandbox-resume:
	pnpm -r run build
	node packages/cli/dist/bin/cp-sandbox-resume.js $(ARGS)

# One LLM shopping-agent run (Flovia unless LLM_PROVIDER=anthropic). Mock PayPal; ARGS="--inject" or "--sandbox".
agent:
	pnpm -r run build
	node packages/cli/dist/bin/cp-agent.js $(ARGS)
