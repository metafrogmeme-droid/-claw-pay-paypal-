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
