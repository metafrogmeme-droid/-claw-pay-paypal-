# THREAT_MODEL.md (v1, M2)

v1 covers what exists or is designed as of M2: the rule core, `cp-keys`, CI, and the
designed gate and PayPal adapter. It grows every milestone. **Status** says where the mitigation
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
| T11 | PayPal toolkit talks to **live** by default (`context.sandbox` defaults to false; `PAYPAL_ENVIRONMENT` ignored) | gate always passes `context.sandbox: true`, asserts it in a test, allows only `api-m.sandbox.paypal.com` and `api.sandbox.paypal.com`, refuses `api-m.paypal.com`, `api.paypal.com`, `mcp.paypal.com` | 🟡 P2 |
| T12 | Toolkit silently drops an agent-supplied `payee` and pays the app owner anyway | gate owns the payee: strict zod schema (unknown field → Blocked), `payee` checked then stripped (D-016) | 🟡 P2 |
| T13 | Float maths in the toolkit turns 0.1 + 0.2 into a wrong amount | gate converts to bigint minor units first and rejects more than 2 decimals | 🟡 P2 |
| T14 | One idempotency key reused across orders | never set a global `context.request_id`; `pay_order` idempotent per order id in the gate | 🟡 P3 |
| T15 | Access token leaks via `DEBUG=agent-toolkit:*` logs | gate clears that `DEBUG` namespace; log-redaction test | 🟡 P3 |
| T16 | Malicious or broken dependency update | exact pins, lockfile, 7-day minimum release age, `blockExoticSubdeps`, `trustPolicy: no-downgrade`, `pnpm audit`, Semgrep; Actions pinned by SHA | ✅ M1 |
| T17 | Rule set mixes assets with different decimals, so a cap means different amounts | documented constraint (one decimals scale per rule set); rule-file validation will refuse mixed scales | ⬜ M3 (rules loader) |
| T18 | Clock skew moves the UTC day boundary | `decide()` takes `now` from the gate; the gate uses the system clock | ⬜ M3 |

| T19 | Duplicate JSON keys (e.g. two `payTo`): `JSON.parse` silently keeps the last one, so two readers could disagree | the parser and the signer must read the same decoded object; a duplicate-key check before `JSON.parse` is proposed for M3 | ⬜ M3 |
| T20 | A non-`authorization` payment flow (`upfront`, `escrow`) or `upto` scheme commits funds before the resource runs, or charges up to a maximum | the parser keeps `paymentFlow` (default `authorization`) and the full `amount`; for `upto` the amount is treated as the maximum. Accepts selection (M3) skips flows and schemes the gate doesn't support | 🟡 M3 |

## Out of scope (v1)
Compromise of the user's machine itself, malicious facilitators beyond the settlement check (M3), and on-chain
contract risks (M4, Slither in M6).
