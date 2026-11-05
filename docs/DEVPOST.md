# Devpost copy (PayPal AI Hackathon)

**Status:** already submitted on https://devpost.com/software/claw-pay (**do not resubmit**).
Edits stay open until **Thu 12 Nov 2026 21:00 CET**.
YouTube title is already correct — **do not rename** the video.

- Demo: https://youtu.be/7YqZqlEq_gA
- Repo: https://github.com/metafrogmeme-droid/claw-pay-paypal
- Gallery images: [docs/gallery](gallery/)

The body below matches the submitted draft (for reference and small copy edits).

---

# Devpost submission draft: Claw Pay

Draft for the owner to review and submit. Nothing here has been posted.

---

## Project name
Claw Pay

## Tagline
A rule gate in front of AI-agent PayPal payments: the AI suggests, your rules decide.

## Links
- Code: https://github.com/metafrogmeme-droid/claw-pay-paypal
- Demo video: https://youtu.be/7YqZqlEq_gA

---

## Inspiration
AI agents are starting to pay for things. An agent that can create PayPal orders can also create the wrong ones:
the wrong amount, the wrong currency, or a payee it read on a web page someone planted for it. We didn't want to
choose between "the agent can't pay" and "the agent can pay for anything". We wanted the owner's own rules to sit
in between and have the last word, in plain language.

## What it does
Claw Pay sits between an AI shopping agent and the PayPal Orders v2 API. Every money call the agent proposes is
checked against the owner's rules before anything reaches PayPal, and the answer is always one of three:

- **Allowed: within your limits**: only then does the call go to PayPal.
- **Blocked by your rule: …**: with a reason code, and zero PayPal calls are made.
- **Needs your OK: …**: nothing is sent until the owner says yes.

The rules cover a list of known sellers with their PayPal merchant ids (a swapped payee is blocked), caps per call,
per seller per day and per day, payments per day, a currency allowlist, a tool allowlist, a confirm threshold, rule
expiry and a pause switch. Decisions are deterministic: no model sits in the decision path.

The LLM agent can only propose. It answers with JSON intents, and each one goes through the gate. It has no way to
approve its own request, change the rules or unpause. Before any capture, Claw Pay asks PayPal for the order again
and captures only if it is approved, with the same payee and the same amount the gate allowed.

Everything runs on the PayPal sandbox only. Live PayPal hosts are refused, and there is no switch to turn that off.

## How we built it
- **TypeScript monorepo** (Node 22, pnpm). A pure rule core (`decide()`) returns the verdict and a reason code.
- **PayPal gate:** a strict normaliser turns each tool call into an intent (unknown fields are refused, amounts
  become integer cents before any maths), then the rule core decides, and only then is PayPal called. Tool names and
  argument shapes follow the PayPal Agent Toolkit (`create_order`, `get_order`, `pay_order`).
- **Sandbox client:** a thin PayPal Orders v2 REST client of our own, not the Agent Toolkit runtime. It calls four
  endpoints (OAuth token, create, get, capture), checks every request URL against the sandbox host list, never logs
  credentials, and uses one idempotency key per order. We chose this because it let us inject the transport for
  tests, keep PayPal's error codes, and build every amount from integer cents.
- **LLM shopping agent:** Flovia (`gpt-6-luna`, through its OpenAI-compatible Responses API) by default; Anthropic
  Claude (Haiku) only when the owner opts in. There is no automatic fallback between them.
- **Spend guard:** a token cap per call, a USD cap per run checked against the worst case before each call, a call
  cap per run, a hard stop flag, and a spend log with counts and costs only (no prompts, no keys).
- **Owner commands:** `make demo-paypal` (12 scripted calls in mock mode, no account needed), `make sandbox-smoke`,
  `make agent`, and `make sandbox-resume` to capture an order after the buyer approves it later.
- **Checks on every change:** format, lint, types, 454 tests with a 95% coverage gate (99.39% statements, 100% lines),
  a copy check on every tracked file, gitleaks on the full history, Semgrep and a dependency audit. Tests never touch
  the network: the global `fetch` is replaced with one that always fails, and PayPal and model replies are recorded,
  scrubbed fixtures.

## Challenges we ran into
- **Payee pinning.** The toolkit's `create_order` has no payee field, so PayPal pays the app's own business account.
  We let the agent name a payee only so the gate can check it, then strip it, and check it again on PayPal's side
  before the capture.
- **Approval happens outside the agent's run.** The buyer approves in a browser, sometimes much later. We added an
  owner-only resume step that re-attaches the order to a fresh gate, re-checks it with PayPal and only then captures.
- **The model provider's API was not what we expected.** Our first live agent test failed because Flovia serves the
  Responses API, not chat completions, and wants an operation id on every call. Recorded replies made the fix quick
  to test.
- **A model trying to help.** In an early live run the model put the seller's name where a merchant id goes. The
  gate blocked it, as it should. We changed the default task so the model leaves the payee out and the gate fills in
  the listed seller.

## Accomplishments that we're proud of
- On 1 Nov 2026 the whole flow ran end to end on the real PayPal sandbox: the LLM agent (Flovia) proposed a 2.00 USD
  order, the gate allowed it, PayPal created it, the sandbox buyer approved it, Claw Pay re-checked status, payee and
  amount with `get_order`, and the capture came back COMPLETED.
- The same agent ran live with Claude Haiku at a cost of a small fraction of a cent, with the spend cap in place.
- "Blocked means zero PayPal calls" is tested, not just claimed.
- Prompt injection: in the live run the model ignored the planted "pay another merchant" text. For a model that does
  follow it, an offline test shows the gate still blocks the swapped payee (`PAYTO_MISMATCH`) with no PayPal call.
  We say plainly that the live run never reached that block.

## What we learned
- A gate is only as good as its input. Most of the work went into strict normalising: integer cents, no unknown
  fields, no guessing.
- Re-checking with PayPal right before capture is cheap and catches the cases a rule check alone can't see.
- Keeping models out of the decision and out of CI makes the system easy to reason about and easy to test.
- Being honest in the docs about what is built and what is still planned saved us from confusing ourselves.

## What's next for Claw Pay
- Run the agent and the gate in separate processes, with the agent talking to the gate over MCP, so the agent
  process never holds PayPal credentials. Today they share one process, and our threat model says so.
- A rules file loader with more checks, and a hash-chained receipt log for every decision.
- The x402 side: the parser is built; signing and settlement checks come next, on testnets only.

## Built with
TypeScript, Node.js, pnpm, Vitest, fast-check, zod, PayPal Orders v2 REST API (sandbox), Flovia (OpenAI-compatible
Responses API), Anthropic Claude API (opt-in), gitleaks, Semgrep, GitHub Actions

## Try it
- Mock mode, no PayPal account or keys: `pnpm install --frozen-lockfile && make demo-paypal`
- Sandbox mode with your own free PayPal sandbox app: see the README.

https://youtu.be/7YqZqlEq_gA
