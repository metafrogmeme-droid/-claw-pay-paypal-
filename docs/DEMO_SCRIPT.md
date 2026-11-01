# DEMO_SCRIPT.md

Demos with exact expected counts. Each demo exits non-zero on any mismatch.

## PayPal demo: `make demo-paypal` (mock mode, built in P2)

Rules: `demo/paypal/rules.json`.
- One listed payee, `seller-a`, pinned. Rail `paypal:sandbox`, currency USD.
- Per-call cap 5.00; seller-a daily cap **11.00** (so row 8 reaches the confirm threshold before the seller cap); daily cap 20.00; max 20 payments a day.
- Confirm threshold 4.00; expiry 7 days.
- Allowed tools: `create_order`, `pay_order`, `get_order`.

The scripted owner says **no** to every "Needs your OK".

| # | Agent call | Expected | PayPal calls |
|---|---|---|---|
| 1–3 | `create_order` 2.00 USD | **Allowed: within your limits** (3) | 3 |
| 4 | `create_order` with `payee.merchant_id` unlisted | **Blocked by your rule:** `SELLER_NOT_LISTED` | 0 |
| 5 | `create_order` 6.00 | **Blocked by your rule:** `ABOVE_CALL_CAP` | 0 |
| 6 | `create_order` 2.00 **EUR** | **Blocked by your rule:** `ASSET_NOT_ALLOWED` | 0 |
| 7 | Injected text (demo fixture) → seller-a's email with merchant id `ATTACKERMERCHANT1` | **Blocked by your rule:** `PAYTO_MISMATCH` | 0 |
| 8 | `create_order` 4.50 | **Needs your OK:** `NEEDS_OWNER_OK` (owner says no, nothing sent) | 0 |
| 9 | `create_subscription` | **Blocked by your rule:** `ACTION_NOT_ALLOWED` | 0 |
| 10–11 | `create_order` 2.00 | **Allowed** (2); seller-a total 10.00 | 2 |
| 12 | `create_order` 2.00 (total would be 12.00) | **Blocked by your rule:** `ABOVE_SELLER_DAILY_CAP` | 0 |

Then, on fresh gates and counted separately:
- **pause:** the guardian pauses → `PAUSED`; the guardian can't unpause; the owner unpauses → the next call is allowed.
- **keys:** the agent asks for `get_credentials`, `update_rules` or `unpause` → all `ACTION_NOT_ALLOWED`. In mock
  mode this checks the agent's only door (`gate.call`). The process-level test (the agent process can't read
  `PAYPAL_SANDBOX_CLIENT_SECRET`) comes with the MCP server in P3.

Last line:

`PAYPAL DEMO OK (5 allowed, 6 blocked, 1 needed your OK, 5 PayPal calls, 0 calls when blocked, pause works, creds isolated)`

## x402 demo: `make demo` (M3)

Not built yet. Its expected counts will be added here when it lands.
