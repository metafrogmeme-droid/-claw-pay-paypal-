# THREAT_MODEL.md (v1.1, M2 + PayPal sandbox client + LLM agent)

v1.1 covers what exists or is designed as of M2 plus the PayPal sandbox client and
the LLM agent: the rule core, `cp-keys`, CI, the in-process PayPal gate and its sandbox REST client, and the LLM
shopping agent (T21–T28). "Built" means tested on mocks and recorded replies; one live sandbox run went end to end on
1 Nov 2026 (create_order, buyer approval, get_order re-check, capture COMPLETED). It grows every milestone. **Status** says where the mitigation
lives: ✅ built and tested, 🟡 designed (milestone named), ⬜ open.

## Assets
| Asset | Where | Why it matters |
|---|---|---|
| Budget key, owner key, guardian key | user's `.env` (mode 600) | the budget key signs x402 payments; the owner key changes rules and unpauses |
| PayPal client id + secret, access tokens | the owner's own `.env` only | they move sandbox money; on live they would move real money |
| Rules + state (counters, holds, pause) | gate machine | they decide what gets paid |
| Receipt log | gate machine (hash chain), later on chain | proof of every decision |

## Actors
- **Agent / LLM**: may be prompt-injected. It proposes calls, holds no keys, and can't change rules or unpause.
- **Seller**: may be malicious or broken: wrong `payTo`, price jumps, dead endpoint, empty response after payment.
- **Guardian**: may pause, nothing else.
- **Owner**: approves `NEEDS_OWNER_OK`, unpauses, edits rules.
- **Supply chain**: npm packages (PayPal toolkit, viem), GitHub Actions, CI tools.

## Threats and mitigations
| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | Injected text makes the agent pay an unlisted seller or a swapped `payTo` | `decide()` checks the seller allowlist (`SELLER_NOT_LISTED`) and `payTo` per seller (`PAYTO_MISMATCH`, EVM case-insensitive) | ✅ core |
| T2 | Agent drains the budget with many small payments | per-call, per-seller-daily, daily caps and max payments per rolling UTC day; property test: caps never exceeded for any sequence | ✅ core |
| T3 | Seller raises the price between declared quote and 402 | `QUOTE_DRIFT` (basis points over the declared price; drops never block) | ✅ core |
| T4 | Malformed or ambiguous payment request gets through | every field validated; anything unreadable → `REQUIREMENTS_UNREADABLE` (property-tested); x402 parser fuzzed | ✅ core · ✅ parser (strict Base64, size and depth limits, schema, fuzzed) |
| T5 | Paid call returns nothing and the agent retries, paying twice | paid-no-result hold → `NEEDS_OWNER_OK`, never an automatic retry; owner approval clears only that, never a block (property-tested) | ✅ core · 🟡 gate wiring (M3) |
| T6 | Agent or guardian unpauses or releases a hold | `unpause` and `releaseHold` refuse anyone but the owner (`ONLY_OWNER`) | ✅ core · 🟡 key isolation (M3) |
| T7 | Stale rules keep allowing payments | `RULES_EXPIRED` at and after `expiresAt` | ✅ core |
| T8 | Symbol spoofing: a token called "USDC" at a fake address | assets match by contract address on EVM; an ISO code only counts on `paypal:*` networks | ✅ core |
| T9 | Key leak through stdout, logs or a readable `.env` | `cp-keys` prints addresses only, writes mode 600 atomically, refuses symlinks; gitleaks in CI and pre-commit, self-tested | ✅ M1 |
| T10 | Accidental mainnet | `cp-keys` treats every unknown chain id as mainnet and refuses it without `MAINNET_GO=yes`; never in CI | ✅ M1 · 🟡 deploy script (M4) |
| T11 | PayPal calls reach **live** (the toolkit's `context.sandbox` defaults to false; `PAYPAL_ENVIRONMENT` ignored) | the runtime client is our own Orders v2 client (D-023): it has no live setting, checks EVERY request URL against `api-m.sandbox.paypal.com` / `api.sandbox.paypal.com` (https, no port, no lookalikes), refuses `api-m.paypal.com`, `api.paypal.com`, `mcp.paypal.com`, treats a redirect as an error, and drops a payer-action link that is not on `www.sandbox.paypal.com`; `PAYPAL_ENVIRONMENT=SANDBOX` is required to build it; `toolkitConfiguration()` still forces `sandbox: true` | ✅ P2 (tests) · ✅ one live sandbox run end to end on 1 Nov 2026 |
| T12 | An agent-supplied `payee` is dropped and the app owner is paid anyway, or the payee changes on PayPal's side | gate owns the payee: strict zod schema (unknown field → Blocked), `payee` checked then stripped (D-016); before every capture `get_order` must show `APPROVED`, the pinned payee merchant id and the decided amount, else no capture (`PAYTO_MISMATCH` / `REQUIREMENTS_UNREADABLE`) | ✅ P2 |
| T13 | Float maths turns 0.1 + 0.2 into a wrong amount | gate converts to bigint minor units first and rejects more than 2 decimals; the sandbox client builds every amount string (items, tax, totals) from bigint minor units | ✅ P2 |
| T14 | One idempotency key reused across orders | a fresh `PayPal-Request-Id` per create, a fixed `claw-pay-capture-<order id>` per capture; `pay_order` idempotent per order id in the gate; a failed pre-check is not cached | ✅ P2 |
| T15 | Credentials or the access token leak via logs, errors or object dumps | the toolkit is not in the runtime path (no `DEBUG=agent-toolkit:*` logger); the client holds creds and token in private fields (tests: not in `JSON.stringify`, `inspect`, `String`, error messages); OAuth errors never echo PayPal's text; CLIs print order id, status and link only | ✅ P2 |
| T16 | Malicious or broken dependency update | exact pins, lockfile, 7-day minimum release age, `blockExoticSubdeps`, `trustPolicy: no-downgrade`, `pnpm audit`, Semgrep; Actions pinned by SHA | ✅ M1 |
| T17 | Rule set mixes assets with different decimals, so a cap means different amounts | documented constraint (one decimals scale per rule set); rule-file validation will refuse mixed scales | ⬜ M3 (rules loader) |
| T18 | Clock skew moves the UTC day boundary | `decide()` takes `now` from the gate; the gate uses the system clock | ⬜ M3 |

| T19 | Duplicate JSON keys (e.g. two `payTo`): `JSON.parse` silently keeps the last one, so two readers could disagree | the parser and the signer must read the same decoded object; a duplicate-key check before `JSON.parse` is proposed for M3 | ⬜ M3 |
| T20 | A non-`authorization` payment flow (`upfront`, `escrow`) or `upto` scheme commits funds before the resource runs, or charges up to a maximum | the parser keeps `paymentFlow` (default `authorization`) and the full `amount`; for `upto` the amount is treated as the maximum. Accepts selection (M3) skips flows and schemes the gate doesn't support | 🟡 M3 |
| T21 | Injected page text steers the LLM agent to a swapped payee | the agent only proposes JSON intents; each goes through `gate.call()`, so demo row 7 is still `PAYTO_MISMATCH` with 0 PayPal calls (tested with a provider that "obeys" the injection); page text is wrapped as untrusted in the prompt. In the live Flovia run of 1 Nov 2026 the model ignored the injected text and left the payee out, so that run never reached `PAYTO_MISMATCH`; the gate test above is what covers a model that obeys | ✅ agent |
| T22 | The agent approves its own intent | the agent has no owner-OK, pause, unpause or rules handle; `ownerApproved` in args is unreadable; `owner_ok` / `unpause` / `update_rules` tools → `ACTION_NOT_ALLOWED` (tested); the CLIs always answer the owner-OK question with no | ✅ agent |
| T23 | An unreadable or oversized model reply turns into payments | strict envelope `{"intents":[{tool,args,why?}]}`, max 5 intents, unknown keys → zero intents; a reply cut off at the token cap (Flovia `incomplete`, Anthropic `max_tokens`) is logged, then refused (tested) | ✅ agent |
| T24 | LLM spend runs away | `max_tokens` (default 512, hard cap 1024), per-run USD cap checked against the worst case before each call (default 0.05), call cap (default 3), hard stop flag (`LLM_HARD_STOP=yes` or `.claw-pay/LLM_STOP`) checked before every call, JSONL spend log with counts and costs only; cheap Anthropic model by default; no automatic fallback between providers | ✅ agent |
| T25 | LLM API keys leak, or reach the model | keys only from env (`.env` is gitignored); held in private fields; errors carry codes, never response text; the prompt holds the task and page text only (test: env reader never touches `PAYPAL_*`) | ✅ agent |
| T26 | Agent and PayPal credentials share one process (`cp-agent --sandbox`) | today the LLM agent, the gate and the PayPal client run in ONE Node process, so code running in that process could read the PayPal secret. The model only gets text in and JSON out, it can't run code. Separate processes (agent ⇄ gate over MCP) are still the plan for P3 | 🟡 P3 |
| T27 | Tests or CI reach the network | a Vitest setup file replaces the global `fetch` with one that always rejects; providers and the PayPal client take an injected fetch; replies are recorded, scrubbed fixtures | ✅ CI |
| T28 | A resume after a restart captures an order the gate never checked | `adoptOrder` is owner-side only (not a `call()` tool; tested); it rebuilds the intent from your rules, which must still allow it (else no adopt, zero PayPal calls); `pay_order` then re-checks `APPROVED`, payee and amount on PayPal before the one capture (tested on mocks and recorded replies) | ✅ paypal |

## Out of scope (v1)
Compromise of the user's machine itself, malicious facilitators beyond the settlement check (M3), and on-chain
contract risks (M4, Slither in M6).
