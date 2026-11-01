# ARCHITECTURE.md

This file records the architecture **as built**, milestone by milestone.

- **M1:** pnpm workspace; `packages/cli` (`cp-keys`); CI; Foundry project with no contracts yet.
- **M2 (PR 1):** `packages/core`, the pure rule core. `decide(intent, rules, state, now, opts)` returns
  `{ outcome, reason, verdict }`. The check order is fixed: readable → paused → expired → action → network →
  asset → seller → payTo → probe → quote drift → call cap → payments/day → seller daily cap → daily cap → hold →
  confirm threshold. State updates (`recordPayment`, `recordPaidNoResult`, `releaseHold`, `pause`, `unpause`) are
  pure and immutable. Counters roll over at the UTC day boundary.
- **M2 (PR 2):** `packages/x402`. `parseV2Header()` (PAYMENT-REQUIRED) and `parseV1Body()` (v1 402 body) return
  `{ ok: true, value: { x402Version, resourceUrl, accepts[] } }` or `{ ok: false, reason: 'REQUIREMENTS_UNREADABLE',
  detail }`, and never throw. `toPaymentIntent()` turns one accepts entry into a core intent (action `pay`, seller
  origin from the URL the agent requested, never from the 402).
- **P2:** `packages/paypal`. `normalise()` turns a toolkit tool call into a core intent (strict zod schema, amounts
  in integer cents, agent-named `payee` checked then stripped). `PaypalGate.call(tool, args)` is the agent's only
  door: normalise → `decide()` → only then the `PaypalClient`. `MockPaypal` counts every call, so "blocked → 0
  PayPal calls" is tested. `assertSandboxEnv()`, `assertAllowedHost()` and `toolkitConfiguration()` keep the
  adapter on sandbox. `cp-demo-paypal` runs the 12-call demo in `docs/DEMO_SCRIPT.md` in mock mode.
- **P2 (sandbox + agent):** `SandboxPaypalClient` in `packages/paypal` calls four Orders v2 REST endpoints (token,
  create, get, capture) on sandbox hosts only (D-023). `pay_order` runs `get_order` first and captures only when the
  order is `APPROVED` with the pinned payee and the decided amount. `adoptOrder()` lets the owner resume an approved
  order after a restart. `packages/agent` is the LLM shopping agent (D-025): the model returns JSON intents, each goes
  through `gate.call()`, and a spend guard caps tokens, calls and USD per run. CLIs: `cp-agent`, `cp-sandbox-smoke`,
  `cp-sandbox-resume`.
