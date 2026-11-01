# Claw Pay for PayPal: a rule gate in front of AI-agent payments

An AI agent that can create PayPal orders can also create the wrong ones: the wrong amount, the wrong currency,
a payee it read in a prompt-injected web page. **Claw Pay sits between the agent and PayPal.** Every money call
is checked against the owner's rules first. The answer is always one of three:

- **Allowed: within your limits**: only then does the call reach PayPal.
- **Blocked by your rule: …**: with a reason code. **Zero PayPal calls are made.**
- **Needs your OK: …**: the owner decides; nothing is sent until they say yes.

The AI suggests and the rules decide. Verdicts are deterministic, with no model in the decision path.

**PayPal sandbox only.** Claw Pay never talks to live PayPal (see [Sandbox only](#sandbox-only) below).

## Status

Work in progress. What is in this repo today:

| Part | State |
|---|---|
| Rule core (`packages/core`): `decide()`, reason codes, verdict text | built, unit- and property-tested |
| PayPal gate (`packages/paypal`): strict normaliser, payee pinning, caps, sandbox guard | built and tested against a mock PayPal client |
| `make demo-paypal`: 12 scripted agent calls in mock mode | built, runs in CI |
| Sandbox PayPal client wrapping the PayPal Agent Toolkit | next milestone |
| LLM agent (behind `ENABLE_LLM_AGENT`, off by default) | next milestone |
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
- **Captures** (`pay_order`) only for orders the gate created, at most once per order id. A PayPal error is
  reported once and never retried. Pause and unpause are gate methods, not tools the agent can call.

## Sandbox only
- `PAYPAL_ENVIRONMENT` must be exactly `SANDBOX`, otherwise `ERR_PRODUCTION_REFUSED`.
- The PayPal Agent Toolkit defaults to live, so the toolkit configuration Claw Pay builds always sets
  `context.sandbox: true`.
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

## Sandbox setup with **your own** PayPal sandbox app
Credentials are never shared. You use your own free sandbox app. *(The sandbox run command lands with the
sandbox client in the next milestone; these are the setup steps.)*

1. Log in at the PayPal Developer Dashboard → **Apps & Credentials** → toggle **Sandbox** → **Create App**
   (type Merchant, linked to your default sandbox **Business** account).
2. Copy `.env.example` to `.env` and fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and
   `PAYPAL_ENVIRONMENT=SANDBOX`. `.env` is git-ignored. Never paste these anywhere else.
3. **Testing Tools → Sandbox Accounts**: put your sandbox Business account's merchant id into
   `demo/paypal/rules.json` (`sellers[0].merchantId`), and note your sandbox **Personal** (buyer) login.
4. Each new order needs a buyer approval: open its `payer-action` link in a private window and log in as your
   sandbox **Personal** account (logging in as the Business account that receives the money is refused by PayPal).

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
| `packages/paypal` | PayPal gate, normaliser, sandbox guard, mock client, rules file loader |
| `packages/x402` | fail-closed x402 parsers |
| `packages/cli` | `cp-keys`, `cp-demo-paypal` |
| `demo/paypal` | demo rules |
| `scripts/` | copy-lint, gitleaks self-test, docs checks |
| `docs/` | [architecture](docs/ARCHITECTURE.md), [decisions](docs/DECISIONS.md), [threat model](docs/THREAT_MODEL.md), [demo script](docs/DEMO_SCRIPT.md) |

## AI and PayPal tools used
- **PayPal:** Orders v2 (create, get, capture) through the tool names and argument shapes of the PayPal Agent
  Toolkit (`@paypal/agent-toolkit`), sandbox only.
- **AI:** an LLM agent proposes tool calls (next milestone, behind `ENABLE_LLM_AGENT`, off by default). CI and the
  mock demo use a scripted agent and make no LLM calls.

## Licence
MIT. See [`LICENSE`](LICENSE).
