# DECISIONS.md

One short entry per design choice. **Status** is *Decided* (built or binding) or
*Planned* (the direction for a part that isn't built yet). Pinned sources:

- **S1:** npm `@paypal/agent-toolkit@1.11.0` (tarball sha256
  `e0c5ca9bd01703c5646a94cb39dcb1ef0c85a99fd88ee59c34dae49800e1f805`).
- **S2:** npm `@paypal/mcp@1.8.1` (tarball sha256
  `7447903566e370f9fed9dce9a1e6c51f4b90bc3af0c2c03aa7cbec5278792042`).
- **S4:** github.com/paypal/ai-toolkit @ `1401791aca82568525bd60aa40aaeb3e9a9615d0` (README, MCP tool reference).
- **S5:** github.com/paypal/paypal-rest-api-specifications @ `90e8041ffe02d80c452d2b476bedd59a8d219bdc`
  (`openapi/checkout_orders_v2.json`, Orders 2.32).

---

## D-001 Licence: MIT
- **Status:** Decided.
- **What:** `LICENSE` is MIT. Every package gets `"license": "MIT"`.
- **Note:** the dependencies we plan to use are ISC (`@paypal/agent-toolkit`, S1) and Apache-2.0
  (`@paypal/mcp`, S2). Both work with an MIT repo when we keep their notices. Neither is vendored.
- **Copyright line:** "Copyright (c) 2026 Patrick Baur (RUNECLAW)".

## D-002 PayPal integration: the Agent Toolkit as a library inside the gate, not the `@paypal/mcp` server
- **Status:** Superseded for the money path by D-023: the gate calls PayPal through its own Orders v2 REST
  client and keeps the toolkit's tool names and argument shapes.
- **Options:**
  1. The gate spawns `npx @paypal/mcp` (S2) and forwards MCP calls to it.
  2. The gate imports `@paypal/agent-toolkit` (S1) in-process and calls only the tools that pass `core.decide`.
  3. The gate talks to the remote `mcp.sandbox.paypal.com/sse` (S4).
- **Choice:** option 2.
- **Why:**
  - The decision and the PayPal call share one process and one stack trace, so "blocked → 0 PayPal calls" can be
    proved by a call counter on a mock client.
  - The secret never crosses a process boundary we don't own.
  - We can assert sandbox after construction (`client.getBaseUrl()`, S1).
  - We pin an exact version. Option 1 pulls `@paypal/agent-toolkit@latest` at run time (S2 `package.json`), which
    breaks reproducibility.
  - Option 3 sends access tokens to a remote server we can't mock in CI, and its tool schemas aren't published.
- **Cost / risk:**
  - We depend on the toolkit's internals (its tool `method` names and parameter zod schemas), so we pin
    1.11.0 and add a contract test that fails if the exported tool list or schemas change.
  - The toolkit defaults to live (S1), so the wrapper must force sandbox and check it.
- **Revisit if** we want the remote commerce tools. Those only exist on the remote server.

## D-003 Agent side: the AI SDK through our own MCP server, not the toolkit's AI SDK tools
- **Status:** Planned (P3). Today the LLM agent (D-025) calls `gate.call()` in the same process; see THREAT_MODEL T26.
- **Options:**
  1. The LLM agent uses `PayPalAgentToolkit` from `@paypal/agent-toolkit/ai-sdk` directly.
  2. The LLM agent is an MCP client of **our** Claw Pay MCP server, which exposes the same tool names.
- **Choice:** option 2, for every agent (scripted and LLM). The LLM agent may use the AI SDK as its MCP client.
- **Why:**
  - With option 1 the agent process holds `clientId` and `clientSecret` and calls PayPal itself, which breaks the
    rule "the agent never calls PayPal directly" and the key-isolation test.
  - With option 2 the scripted agent (CI) and the LLM agent (`ENABLE_LLM_AGENT`, off by default) go through the
    exact same path, so CI tests what the demo shows.
- **Cost / risk:**
  - The toolkit's AI SDK entry is built for AI SDK v4 (`LanguageModelV1`, `ai@^4`, S1). Which AI SDK major and
    model the agent uses is still open, so that pin waits.
  - The toolkit's tool names and argument shapes stay the interface; the runtime client is our own (D-023).

## D-004 Sandbox enforcement: hosts on an allowlist, `context.sandbox` forced on
- **Status:** Decided.
- **What:**
  - The process refuses to start unless `PAYPAL_ENVIRONMENT === "SANDBOX"`; otherwise it fails with
    `ERR_PRODUCTION_REFUSED`.
  - The wrapper always passes `configuration.context.sandbox = true` and then asserts the toolkit's base URL.
  - Outbound HTTP is allowed only to `api-m.sandbox.paypal.com` and `api.sandbox.paypal.com` (the remote MCP
    host is not on the allowlist). `api.paypal.com`, `api-m.paypal.com` and `mcp.paypal.com` are
    refused by name in tests. There is no override flag.
- **Why:** the toolkit itself defaults to live and uses both the `api.` and `api-m.` hosts (S1). A deny-list
  of only `api-m.paypal.com` and `mcp.paypal.com` would miss `api.paypal.com`.

## D-005 Sandbox order approval: the owner approves in a browser, and the gate re-checks before capture
- **Status:** Planned for the sandbox client. Built today: capture only for orders the gate created, once per
  order id (D-021).
- **What:**
  - The owner approves orders as the sandbox buyer at the `approve` / `payer-action` link.
  - Before `pay_order`, the gate checks four things: it created that order id; `get_order` shows `APPROVED`
    with the same amount and currency; the order is not already captured; and `core.decide` allows it.
  - Mock mode simulates approval.
- **Why:**
  - The toolkit's `pay_order` sends an empty capture body, so the spec's no-browser route (a `payment_source` on
    capture or confirm) isn't available without bypassing the toolkit and handling card-shaped test data (S5, S1).
  - The toolkit can't send a per-call `PayPal-Request-Id`, so the gate's own captured-order set is what makes
    capture idempotent per order id.

## D-006 Name provenance: pinned PayPal artefacts
- **Status:** Decided.
- **What:** every PayPal name in code must trace to one of these:
  - a pinned npm tarball (by sha256),
  - a commit-pinned file in a `github.com/paypal/*` repo, or
  - a `developer.paypal.com` page once it's reachable.

  Where the README and the code disagree, the shipped code wins.
- **Why:** PayPal's own OpenAPI specs and packages are the same facts in a form we can check by machine and pin.

---

## D-007 Workspace and toolchain (M1)
- **Status:** Decided.
- **What:**
  - pnpm 10 workspace (`packages/*`, `apps/*`), Node ≥ 22.13 (CI on Node 24 LTS), ESM only.
  - **TypeScript 6.0.3** with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
    `verbatimModuleSyntax`. Scripts are type-checked too (`checkJs`).
  - ESLint 10 + typescript-eslint `strictTypeChecked`.
  - Prettier for code (markdown is hand-formatted).
  - Vitest 5 with v8 coverage and a 95% gate on lines, branches, functions and statements.
  - All versions are pinned exactly (`save-exact`).
- **Why not TypeScript 7.0.2 (latest):** typescript-eslint 8.72.1 supports only `>=4.8.4 <6.1.0` (npm
  peerDependencies, checked 31 Oct 2026). Move to 7 when typescript-eslint supports it.

## D-008 Key generation: viem `generatePrivateKey` / `privateKeyToAccount`
- **Status:** Decided.
- **Why:** viem is also planned for the owner UI and the x402 EVM signing path. Its key functions
  sit on the audited noble curves. One dependency, pinned (2.57.13). No hand-rolled crypto.

## D-009 `cp-keys`: testnet allowlist, everything else counts as mainnet
- **Status:** Decided.
- **What:**
  - Known testnets are 31337 (anvil) and 84532 (Base Sepolia). Any other chain id is refused with
    `ERR_MAINNET_REFUSED` unless `MAINNET_GO` is exactly `yes`, and it is **always** refused when `CI` is set.
  - `--chain-id` is required: there is no default network.
  - `--replace-owner-key` needs `--force`; `--force` alone can't replace an owner key.
  - A symlinked `.env` is refused.
  - Unknown errors print only their type, so file contents can't leak.
- **Why:** fail closed. A mainnet deny-list would let any chain we forgot through. New testnets join the list
  only from their official docs.

## D-010 gitleaks via `go install`, pinned v8.30.1, with Claw Pay rules
- **Status:** Decided.
- **What:**
  - CI installs gitleaks with `go install …@v8.30.1`, so the module is verified against the Go checksum database.
    No unverified release-binary download.
  - `.gitleaks.toml` extends the default rules with three of ours:
    - a hex private key assigned to a `*KEY` or `*SECRET` name;
    - a PayPal client secret or access token assigned any value;
    - the PayPal access-token prefix `A21AA`, sourced from PayPal's ai-toolkit README (S4).
  - `scripts/gitleaks-selftest.sh` plants fake values generated at run time (none live in the repo). It also
    checks that `.env.example` and a tx hash in a docs table do **not** trigger.
- **Why:** a secret scanner is only useful if it is proven to catch our secret shapes. Bare `0x` + 64 hex isn't
  flagged, because `docs/VERIFY.md` will list tx hashes.

## D-011 Semgrep: pinned CLI, registry `p/default` plus local rules
- **Status:** Decided.
- **What:** `semgrep==1.183.0` runs with `--config p/default --config .semgrep --error --metrics=off`. Local rules:
  - no `Math.random()`;
  - no `parseFloat` or `toFixed` (money is bigint);
  - no logging of values named key, secret or token.
- **Limits:** registry rules are fetched at run time, so they're not pinned. A file with planted violations
  raises all 3 local rules.

## D-013 copy-lint: substring match, only the lockfile excluded
- **Status:** Decided.
- **What:** `scripts/copy-lint.mjs` checks every **tracked** text file for the two banned words,
  case-insensitively and **anywhere**, including inside identifiers, so "don't name our own helpers with those
  words" is enforced too. Only `pnpm-lock.yaml` is excluded (third-party identifiers).

  The pattern is built from pieces, so the script and its tests pass their own lint.

## D-014 GitHub Actions: SHA-pinned, read-only, no credentials persisted
- **Status:** Decided.
- **What:**
  - Every action is pinned by full commit SHA, with the version in a comment.
  - Top-level `permissions: contents: read`.
  - `persist-credentials: false` on checkout.
  - No secrets of any kind in CI.
  - Tool versions (gitleaks, Semgrep, Foundry v1.8.7) are pinned in `env`.

## D-015 Package-manager supply-chain settings
- **Status:** Decided (fixes 4 blocking Semgrep `p/default` findings).
- **What:**
  - `pnpm-workspace.yaml`: `minimumReleaseAge: 10080` (7 days), `blockExoticSubdeps: true`,
    `trustPolicy: no-downgrade`.
  - `.npmrc`: `min-release-age=7`.
- **Effect:** re-resolving under the 7-day rule moved a few too-new transitive packages back one patch
  (rolldown 1.2.16 → 1.2.15, @oxc-project/types 0.156 → 0.155). All direct pins already met it.
- **Known advisory:** `pnpm audit` reports 1 moderate, `minimatch <11.0.1` (DoS via crafted glob patterns), only
  through `eslint` (a dev tool, never shipped). CI fails at `high`. It clears when eslint's range allows
  `minimatch ≥ 11.0.1` and that release is older than 7 days.

## D-016 The gate owns the payee (PayPal)
- **Status:** Decided.
- **What:**
  - Config pins `sellerProfile { merchantId, currency: "USD", maxAmount }`.
  - The gate's proxied `create_order` schema is the toolkit's `create_order` params plus one optional Claw Pay
    field `payee`, under strict zod (an unknown field → `REQUIREMENTS_UNREADABLE`).
  - `payee` is checked against the seller allowlist (`SELLER_NOT_LISTED`) and against the order context
    (`PAYTO_MISMATCH`), then **stripped** before the toolkit call. A missing `payee` means the pinned profile.
  - Amounts become bigint minor units before the toolkit's float maths; more than 2 decimals → Blocked.
- **Why:** the toolkit has no payee field; PayPal pays the REST app's own business account (S1, S5). So the
  only place to stop a wrong payee is our own schema, and a blocked call makes 0 PayPal calls.

## D-018 Reason code `ACTION_NOT_ALLOWED` (additive)
- **Status:** Decided. It is additive.
- **What:** appended to the end of the enum; outcome BLOCKED. Rules carry an `actions` allowlist (x402 uses
  `pay`; PayPal uses the toolkit tool names). It is checked right after pause and expiry.

## D-019 PayPal in `PaymentIntent`: `paypal:sandbox` network, ISO-4217 asset
- **Status:** Decided.
- **What:** network `paypal:sandbox` (CAIP-2-shaped, our own namespace) and asset = ISO-4217 code (`USD`). An ISO
  code only matches on a `paypal:*` network; on EVM networks assets match by contract address only, so a symbol
  there is `ASSET_NOT_ALLOWED`.

## D-020 Rule core shape
- **Status:** Decided.
- **What:**
  - The signature is `decide(intent, rules, state, now, opts)`. `now` is passed in, so the core has no clock
    and is deterministic (property-tested). `opts.ownerApproved` clears only the NEEDS_OWNER_OK outcomes (hold,
    confirm threshold), never a block (property-tested). `opts.probeOk === false` → `PROBE_FAILED`.
  - The check order is fixed and documented in ARCHITECTURE.md: blocks are evaluated before needs-OK, so an
    approval can never skip a cap.
  - Property tests use **fast-check 4.10.2** (MIT; the newest release older than the 7-day minimum release age).
  - `decode()` is the single place that renders user text: `Blocked by your rule: CODE (detail)`,
    `Needs your OK: CODE (detail)`, or exactly `Allowed: within your limits`.

## D-021 PayPal gate runs in-process; spend counts at order creation
- **Status:** Decided.
- **What:**
  - `PaypalGate.call(tool, args)` is the agent's only door: normalise → `decide()` → only then the PayPal client.
  - Allowed `create_order` records the spend at creation (a reservation; the money moves at capture), so the
    agent can't create unlimited orders and capture them later.
  - `pay_order` is accepted only for orders this gate created, and at most once per order id (idempotent: a repeat
    returns the stored result without a PayPal call).
  - PayPal errors are reported once and never retried; a failed create records no spend.
  - `get_order` is read-only: it isn't priced and isn't blocked by pause.
  - Owner operations (`pause`, `unpause`) are methods on the gate, not tools the agent can call.
- **Why:** it meets "blocked = 0 PayPal calls" structurally (tested), and fails closed: no auto-retry,
  idempotent capture. The planned MCP server wraps the same class.

## D-022 x402 parsing: own strict parser, spec-pinned names, explicit v1 network table
- **Status:** Decided.
- **Sources (pinned):**
  - github.com/x402-foundation/x402 @ `e208bd39030be35a0f807eb3bf4f043354273866`: `specs/x402-specification-v2.md`
    §5.1 and §6.1, `specs/transports-v2/http.md`, `specs/x402-specification-v1.md` §5.1, `specs/transports-v1/http.md`.
  - The v1 network table comes from npm `x402@1.2.0` (Apache-2.0, tarball sha256
    `66d586c18d0b44f8a66b0688f9df13273b3a13c14613be2ac624749fe34853d8`), `EvmNetworkToChainId`.
- **What:**
  - v2 reads the `PAYMENT-REQUIRED` header: strict RFC 4648 Base64 (padding optional, canonical trailing bits),
    strict UTF-8, ≤ 128 KiB, JSON depth ≤ 64, at most 32 `accepts`.
  - v1 reads the 402 JSON body: ≤ 1 MiB, the same depth limit, and all `accepts` must name one `resource`.
  - Amounts must be positive canonical integers ≤ 2^256 − 1, parsed to bigint.
  - v2 networks must be CAIP-2 shaped. v1 names map only through the table (EVM only: the package's Solana ids
    101/103 aren't CAIP-2, so they stay unreadable). Anything else → `REQUIREMENTS_UNREADABLE`.
  - Only modelled fields are kept; unknown fields are ignored, not passed on.
  - `extra.paymentFlow` defaults to `authorization` (spec §6.1); `assetTransferMethod` is kept when present.
- **Why not `@x402/core` for parsing:** our parser is small (about 200 lines), dependency-free apart from zod, and
  every rule above is ours to test and fuzz. `@x402/core` (2.29.0) stays the candidate for **signing** in M3,
  where reusing the official implementation matters more.

## D-023 PayPal sandbox calls: a thin Orders v2 REST client, not the toolkit runtime
- **Status:** Decided (built; one live sandbox run end to end on 1 Nov 2026).
- **What:** `SandboxPaypalClient` (`packages/paypal/src/sandbox-client.ts`) calls exactly four endpoints:
  `POST /v1/oauth2/token`, `POST /v2/checkout/orders`, `GET /v2/checkout/orders/{id}`,
  `POST /v2/checkout/orders/{id}/capture`. Same paths and body shape the toolkit's `create_order`,
  `get_order` and `pay_order` send, so the tool names and the action allowlist stay the same.
- **Why not `@paypal/agent-toolkit` 1.11.0 at run time (supersedes D-002 for the money path):**
  - It uses axios internally, so we can't inject a transport. With our own `fetch` hook, every request URL is
    checked against the sandbox host allowlist, and CI tests run on recorded replies with no network.
  - `PayPalAPI.run()` turns PayPal errors into a JSON string, which loses the `ORDER_NOT_APPROVED` code we need.
  - It totals amounts in floats. We build every amount string from bigint minor units.
  - It pulls in about a dozen runtime packages (AI SDK v4, LangChain, OpenAI, mathjs, `@dotenvx/dotenvx`, ...)
    for four HTTP calls.
  - The sandbox switch defaults to LIVE. Here the base URL can only be a sandbox host; there is no live setting.
- **Idempotency:** a fresh `PayPal-Request-Id` per create and a fixed `claw-pay-capture-<order id>` per capture.
- **Kept:** `toolkitConfiguration()` (always `sandbox: true`) stays for a later MCP/toolkit path, still tested.

## D-024 PayPal env names: `PAYPAL_SANDBOX_CLIENT_ID` / `PAYPAL_SANDBOX_CLIENT_SECRET`
- **Status:** Decided.
- **What:** `.env.example` uses the sandbox-prefixed names, plus
  `PAYPAL_SANDBOX_PAYEE_MERCHANT_ID`, the payee the gate expects on `get_order` before a capture.
  `PAYPAL_ENVIRONMENT=SANDBOX` is still required. The gitleaks PayPal rule already matched both names; the
  self-test now plants the sandbox name too.

## D-025 LLM shopping agent: Flovia by default, Anthropic opt-in, a hard spend guard
- **Status:** Decided (built; the limits below are defaults you can lower in `.env`).
- **What:** `packages/agent`. The model gets the task and the (untrusted) page text and answers with
  `{"intents":[{tool,args,why?}]}`, at most 5. Each intent goes to `gate.call()`; the agent has no other handle.
  Off unless `ENABLE_LLM_AGENT=yes`.
- **Providers:** Flovia through its OpenAI Responses API, `POST https://api.flovia.dev/openai/v1/responses`
  (`FLOVIA_API_KEY`; `FLOVIA_BASE_URL` and `FLOVIA_MODEL` default to that base URL and `gpt-6-luna`). The relay
  does not serve `/chat/completions` (404, found in the first live test). Each call sends a `Flovia-Operation-Id`
  `claw-pay:<run id>:<call n>`; we never retry, so every call is a new generation with a new id. The relay takes one
  text input, so system prompt and task are joined. A reply with status `incomplete` (or Anthropic `stop_reason`
  `max_tokens`) is logged and counted, then refused. Used unless `LLM_PROVIDER=anthropic`, then Anthropic Messages (`ANTHROPIC_API_KEY`, cheap model
  `claude-haiku-5-5` by default). A missing variable is an error. There is never a fallback to the other provider,
  so the paid key is used only when you pick it.
- **Spend guard (both providers):** `max_tokens` 512 (hard cap 1024), per-run cap 0.05 USD checked against the
  worst case BEFORE each call, 3 calls per run, hard stop flag (`LLM_HARD_STOP=yes` or `.claw-pay/LLM_STOP`) read
  before every call, JSONL spend log (counts and nano-USD costs, no prompts, no keys). Flovia counts as 0 USD.
- **CI:** no LLM or network calls. The global `fetch` rejects in every test; providers take an injected fetch;
  replies are recorded, scrubbed fixtures.
- **Checked live (1 Nov 2026):** Flovia `gpt-6-luna` (the only model `/models` lists) and Anthropic
  `claude-haiku-5-5` (in `/v1/models`, one Messages call). Haiku 5.5 price per anthropic.com/pricing on 1 Nov 2026:
  0.10 / 0.50 USD per million input / output tokens for prompts up to 100K tokens (the higher tier is not modelled).
