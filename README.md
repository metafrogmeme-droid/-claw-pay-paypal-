# Claw Pay for PayPal: a rule gate in front of AI-agent payments

An AI agent that can create PayPal orders can also create the wrong ones: the wrong amount, the wrong currency,
a payee it read in a prompt-injected web page. **Claw Pay sits between the agent and PayPal.** Every money call
is checked against the owner's rules first. The answer is always one of three:

- **Allowed: within your limits**: only then does the call reach PayPal.
- **Blocked by your rule: …**: with a reason code. **Zero PayPal calls are made.**
- **Needs your OK: …**: the owner decides; nothing is sent until they say yes.

The AI suggests and the rules decide. Verdicts are deterministic, with no model in the decision path.

**PayPal sandbox only.** Claw Pay never talks to live PayPal (see [Sandbox only](#sandbox-only) below).

## How to test (judges)

**1. Zero setup: no keys, no PayPal account, no network (about 2 minutes).** Needs Node 22.13+ and pnpm 10
(`corepack enable`).

```sh
pnpm install --frozen-lockfile
make check         # format, lint, types, 454 tests + coverage gate, copy-lint
make demo-paypal   # 12 scripted agent calls against a mock PayPal
```

No `make`? Use `pnpm run check`, then `pnpm -r run build && node packages/cli/dist/bin/cp-demo-paypal.js`.
You will see each call's verdict: small orders get `Allowed: within your limits`, an unlisted payee, a 6.00 USD
order, a EUR order and the row 7 prompt-injected payee swap get `Blocked by your rule: …` (with zero PayPal calls),
and a 4.50 USD order gets `Needs your OK: …`. The last line must be the `PAYPAL DEMO OK (…)` line shown in
[Quick start](#quick-start-mock-mode-no-paypal-account-no-keys-no-network).

**2. Real PayPal sandbox, with your own free sandbox app (about 3 steps).**

1. PayPal Developer Dashboard → **Apps & Credentials** → **Sandbox** → **Create App** (Merchant). In **Testing
   Tools → Sandbox Accounts**, note your sandbox Business merchant id and your sandbox Personal (buyer) login.
2. In `.env` (copied from `.env.example`, git-ignored) set `PAYPAL_ENVIRONMENT=SANDBOX`, `PAYPAL_SANDBOX_CLIENT_ID`,
   `PAYPAL_SANDBOX_CLIENT_SECRET` and `PAYPAL_SANDBOX_PAYEE_MERCHANT_ID`, then load it: `set -a; . ./.env; set +a`.
3. Run `CP_SMOKE_WAIT_MINUTES=5 make sandbox-smoke`. It creates one 2.00 USD order (`create_order -> Allowed: within your
   limits`) and prints a **Buyer step** link. Open it in a private window, log in as the sandbox **Personal** buyer and
   approve. The gate re-checks the order (`APPROVED`, your payee, same amount) and sends one capture:
   `pay_order -> Allowed: within your limits | order … | status COMPLETED`. Approved later? `make sandbox-resume ARGS="<order id> --amount 2.00"`.

Without these variables the commands stop before any network call, for example
`Needs your OK: set PAYPAL_SANDBOX_PAYEE_MERCHANT_ID (your sandbox business account merchant id).`

**3. Optional: live LLM agent.** Off by default (`Blocked by your rule: LLM_AGENT_DISABLED`). Set
`ENABLE_LLM_AGENT=yes` and `FLOVIA_API_KEY` (default provider), or `LLM_PROVIDER=anthropic` with
`ANTHROPIC_API_KEY` (opt-in). Then `make agent` (mock PayPal), `make agent ARGS=--inject` (injected page text) or
`make agent ARGS=--sandbox`. The model only proposes; the gate decides. Spend cap and hard stop:
[`.env.example`](.env.example). CI and the mock demo make no LLM calls and use no secrets.

## Status

Work in progress. What is in this repo today:

| Part | State |
|---|---|
| Rule core (`packages/core`): `decide()`, reason codes, verdict text | built, unit- and property-tested |
| PayPal gate (`packages/paypal`): strict normaliser, payee pinning, caps, sandbox guard | built and tested against a mock PayPal client |
| `make demo-paypal`: 12 scripted agent calls in mock mode | built, runs in CI |
| Sandbox PayPal client (`packages/paypal`): a thin Orders v2 REST client, sandbox hosts only | built, tested on recorded replies; one live sandbox run end to end (create, buyer approval, `get_order` re-check, capture) |
| LLM shopping agent (`packages/agent`, behind `ENABLE_LLM_AGENT`, off by default): proposes calls, never approves them; spend cap and hard stop | built, tested on recorded replies; live runs with Flovia (default) and Anthropic (opt-in) |
| `make sandbox-smoke`, `make sandbox-resume`, `make agent` | built and tested |
| x402 parser (`packages/x402`), testnet key tool (`cp-keys`) | built and tested |

## What it checks
- **Payee pinning.** The toolkit's `create_order` has no payee field, so PayPal always pays the REST app's own
  business account. Claw Pay lets the agent name a payee only so it can be checked: an unlisted payee →
  `SELLER_NOT_LISTED`; a known seller with a swapped merchant id (a classic prompt injection) → `PAYTO_MISMATCH`.
  The payee is removed before the call goes on.
- **Caps:** per call, per seller per day, per day, and payments per day (rolling UTC day).
- **Currency** allowlist (`ASSET_NOT_ALLOWED`; the PayPal rules file accepts USD only), **tool** allowlist
  (`ACTION_NOT_ALLOWED`), rule expiry (`RULES_EXPIRED`), pause (`PAUSED`).
- **Confirm threshold** → `NEEDS_OWNER_OK`. Owner approval clears only a needs-OK step, never a block.
- **Strict input.** Unknown fields, more than 2 decimals, tax that needs a fraction of a cent, or an `itemTotal`
  that doesn't match the price → `REQUIREMENTS_UNREADABLE`. Amounts become integer cents before any float maths.
- **Captures** (`pay_order`) only for orders the gate created, at most once per order id, and only after
  `get_order` shows `APPROVED` with the payee and amount the gate decided on. A PayPal error is
  reported once and never retried. Pause and unpause are gate methods, not tools the agent can call.

## Sandbox only
- `PAYPAL_ENVIRONMENT` must be exactly `SANDBOX`, otherwise `ERR_PRODUCTION_REFUSED`.
- The PayPal Agent Toolkit defaults to live, so the toolkit configuration Claw Pay builds always sets
  `context.sandbox: true`. The REST client Claw Pay uses today refuses any non-sandbox host on every request.
- Outbound hosts are an allowlist: `api-m.sandbox.paypal.com` and `api.sandbox.paypal.com` (https, default port).
  `api-m.paypal.com`, `api.paypal.com` and `mcp.paypal.com` are refused by name in tests. There is no override.
- Tool argument names follow `@paypal/agent-toolkit` 1.11.0 (Orders v2: `create_order`, `get_order`,
  `pay_order`).

## Quick start (mock mode: no PayPal account, no keys, no network)
Needs Node 22.13+ and pnpm 10 (`corepack enable`).

```sh
pnpm install --frozen-lockfile
make demo-paypal
```

Expected last line:

```
PAYPAL DEMO OK (5 allowed, 6 blocked, 1 needed your OK, 5 PayPal calls, 0 calls when blocked, pause works, creds isolated)
```

The 12 scripted agent calls and their expected verdicts are in [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).
Edit [`demo/paypal/rules.json`](demo/paypal/rules.json) (caps, threshold, allowed tools) and run it again to see
the verdicts change; the demo exits non-zero when the results no longer match the table.

## Sandbox mode with **your own** PayPal sandbox app
Credentials are never shared. You use your own free sandbox app.

1. Log in at the PayPal Developer Dashboard → **Apps & Credentials** → toggle **Sandbox** → **Create App**
   (type Merchant, linked to your default sandbox **Business** account).
2. Copy `.env.example` to `.env` and fill in `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET` and
   `PAYPAL_ENVIRONMENT=SANDBOX`. `.env` is git-ignored. Never paste these anywhere else.
3. **Testing Tools → Sandbox Accounts**: put your sandbox Business account's merchant id into
   `PAYPAL_SANDBOX_PAYEE_MERCHANT_ID`, and note your sandbox **Personal** (buyer) login.
4. Load the variables into your shell and run `make sandbox-smoke`. It creates ONE 2.00 USD order through the gate
   and stops at `PAYER_ACTION_REQUIRED`, printing the order id and the `payer-action` link. Open the link in a
   private window and log in as your sandbox **Personal** account (logging in as the Business account that
   receives the money is refused by PayPal). To capture too, run it with `CP_SMOKE_WAIT_MINUTES=5`: it polls
   `get_order`, and only when the order is `APPROVED` with your payee and the same amount does it send the capture.
5. Approved later, or in another run (also after `make agent ARGS=--sandbox`, which prints this command)? Run
   `make sandbox-resume ARGS="<order id> --amount 2.00"`. This is an owner command, not an agent tool. It re-attaches
   the order to a fresh gate (your rules must still allow that amount), re-checks it with `get_order` (`APPROVED`,
   your payee, same amount) and only then sends one capture. If the buyer has not approved yet, nothing is sent.

## LLM agent (optional, off by default)
`make agent` runs one LLM shopping-agent turn against the **mock** PayPal; `make agent ARGS=--inject` adds the
row 7 injected page text; `ARGS=--sandbox` uses your sandbox app. Set `ENABLE_LLM_AGENT=yes` and either
`FLOVIA_API_KEY` (default; base URL and model default to `https://api.flovia.dev/openai/v1` and `gpt-6-luna`) or
`LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`. Each run prints its run id and what the model proposed. The
model proposes; the gate decides. Limits and the hard stop are in [`.env.example`](.env.example).

## Developers
Needs gitleaks for the pre-commit hook: `go install github.com/zricethezav/gitleaks/v8@v8.30.1` (same version
as CI), or your OS package manager.

```sh
pnpm install            # also enables .githooks (pre-commit: gitleaks + copy-lint)
make check              # format, lint, types, tests + coverage gate, copy-lint
make gitleaks-selftest  # proves .gitleaks.toml catches planted fake secrets
```

### Testnet keys: `cp-keys`

```sh
pnpm --filter @claw-pay/cli run build
node packages/cli/dist/bin/cp-keys.js --chain-id 84532   # Base Sepolia
```

Writes `CP_BUDGET_PRIVATE_KEY`, `CP_OWNER_PRIVATE_KEY` and `CP_GUARDIAN_PRIVATE_KEY` to `.env` (mode 600) and
prints **addresses only**. Any chain id that isn't a known testnet is refused (`ERR_MAINNET_REFUSED`) unless
`MAINNET_GO=yes` is set on that machine, and it is always refused in CI.

## Layout

| Path | What |
|---|---|
| `packages/core` | rule core: `decide()`, reason codes, `decode()` |
| `packages/paypal` | PayPal gate, normaliser, sandbox guard, sandbox REST client, mock client, rules file loader |
| `packages/agent` | LLM shopping agent: Flovia and Anthropic providers, spend guard |
| `packages/x402` | fail-closed x402 parsers |
| `packages/cli` | `cp-keys`, `cp-demo-paypal`, `cp-agent`, `cp-sandbox-smoke`, `cp-sandbox-resume` |
| `demo/paypal` | demo rules |
| `scripts/` | copy-lint, gitleaks self-test, docs checks |
| `docs/` | [architecture](docs/ARCHITECTURE.md), [decisions](docs/DECISIONS.md), [threat model](docs/THREAT_MODEL.md), [demo script](docs/DEMO_SCRIPT.md) |

## AI and PayPal tools used
- **PayPal Orders v2 REST API** (sandbox only): create, get, capture, called by Claw Pay's own small client
  (D-023). The PayPal Agent Toolkit's tool names and argument shapes (`@paypal/agent-toolkit` 1.11.0) are kept;
  the toolkit package itself is not a dependency.
- **AI:** an LLM agent proposes tool calls (behind `ENABLE_LLM_AGENT`, off by default): Flovia by default, Anthropic
  only when chosen. CI and the mock demo use a scripted agent and make no LLM calls.

## Licence
MIT. See [`LICENSE`](LICENSE).
