# Gallery

Screenshots used on the [Devpost project page](https://devpost.com/software/claw-pay).
1920×1080, PayPal sandbox only.

| File | What it shows |
|---|---|
| [01-title-architecture.png](01-title-architecture.png) | Agent → Claw Pay gate → PayPal Orders v2, and the three verdicts |
| [02-blocked.png](02-blocked.png) | Blocked by your rule (payee / cap / currency / inject) with zero PayPal calls |
| [03-allowed.png](03-allowed.png) | Allowed: within your limits — call reaches PayPal |
| [04-needs-your-ok.png](04-needs-your-ok.png) | Needs your OK — nothing sent until the owner says yes |
| [05-capture-completed.png](05-capture-completed.png) | Sandbox capture COMPLETED after buyer approval + `get_order` re-check |
| [06-tests-ci.png](06-tests-ci.png) | `make check`: 454 tests, coverage gate, copy-lint, gitleaks, Semgrep |

Demo video (unlisted): https://youtu.be/7YqZqlEq_gA
