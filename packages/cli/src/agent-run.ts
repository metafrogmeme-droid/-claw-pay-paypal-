// `make agent`: one LLM shopping-agent run. Mock PayPal by default; --sandbox uses the real sandbox client.
// --inject adds the demo row 7 page text, so you can watch the gate block the swapped payee.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertAgentEnabled,
  providerFromEnv,
  runShoppingAgent,
  spendGuardFromEnv,
  type AgentRun,
  type EnvDeps,
  type FetchLike,
} from '@claw-pay/agent';
import {
  MockPaypal,
  PaypalGate,
  formatMinor,
  normalise,
  loadPaypalRules,
  sandboxClientFromEnv,
  type FetchLike as PaypalFetch,
  type PaypalClient,
  type PaypalRulesFile,
} from '@claw-pay/paypal';

import { INJECTED_TEXT } from './demo-paypal.js';
import { smokeRules, type Env } from './sandbox-smoke.js';

const DEFAULT_RULES = resolve(import.meta.dirname, '../../../demo/paypal/rules.json');
// seller-a is the pinned seller, so the gate fills in its pay-to. "seller-a" is a name, not a merchant id: the
// first live run sent payee {"merchant_id":"seller-a"} and was blocked as SELLER_NOT_LISTED.
export const DEFAULT_TASK =
  'Buy 2.00 USD of API credits from seller-a (one item, quantity 1, no tax). seller-a is the pinned seller: leave payee out.';

export interface AgentCliDeps extends EnvDeps {
  readonly llmFetch?: FetchLike;
  readonly paypalFetch?: PaypalFetch;
  readonly rulesFile?: PaypalRulesFile;
  /** Feeds the Flovia-Operation-Id of each call. Random per run unless given (tests fix it). */
  readonly runId?: string;
}

const usd = (nano: bigint): string =>
  `${String(nano / 1_000_000_000n)}.${String(nano % 1_000_000_000n).padStart(9, '0')}`;

export async function runAgentCli(
  argv: readonly string[],
  env: Env,
  out: (l: string) => void,
  deps: AgentCliDeps = {},
): Promise<number> {
  const sandbox = argv.includes('--sandbox');
  const inject = argv.includes('--inject');
  const task = argv.filter((a) => !a.startsWith('--')).join(' ') || DEFAULT_TASK;
  const runId = deps.runId ?? randomUUID();
  let file = deps.rulesFile ?? (JSON.parse(readFileSync(DEFAULT_RULES, 'utf8')) as PaypalRulesFile);
  let client: PaypalClient;
  let provider;
  let guard;
  try {
    assertAgentEnabled(env);
    provider = providerFromEnv(env, deps.llmFetch, runId);
    guard = spendGuardFromEnv(env, deps);
    if (sandbox) {
      const payee = env['PAYPAL_SANDBOX_PAYEE_MERCHANT_ID'] ?? '';
      if (payee === '') throw new Error('PAYPAL_SANDBOX_PAYEE_MERCHANT_ID is not set');
      file = smokeRules(file, payee);
      client = sandboxClientFromEnv(env, deps.paypalFetch);
    } else {
      client = new MockPaypal();
    }
  } catch (e) {
    out(`Blocked by your rule: ${(e as Error).message}`); // codes and variable names only, never values
    return 2;
  }
  const now = Date.now();
  const { rules, config } = loadPaypalRules(file, now);
  // The owner OK is not something the agent can give. In this CLI the answer is always no.
  const gate = new PaypalGate({
    rules,
    config,
    client,
    clock: Date.now,
    ownerOk: () => Promise.resolve(false),
  });
  out(
    `Claw Pay agent run ${runId}: ${provider.name} ${provider.model}, PayPal ${sandbox ? 'sandbox' : 'mock'}.`,
  );
  const run: AgentRun = await runShoppingAgent(
    { task, ...(inject ? { page: INJECTED_TEXT } : {}) },
    { provider, guard, gate: (t, a) => gate.call(t, a) },
  );
  for (const s of run.steps) {
    const extra =
      s.result.orderId === undefined ? '' : ` [order ${s.result.orderId}, ${String(s.result.status)}]`;
    out(`${s.tool} -> ${s.result.verdict}${extra}`);
    // What the model proposed, so a run shows why the gate decided. Model output only, never env values.
    out(`  proposed: ${JSON.stringify(s.args).slice(0, 300)}`);
    if (s.result.payerActionUrl !== undefined) out(`  buyer step: ${s.result.payerActionUrl}`);
    const n = normalise(s.tool, s.args, config, now);
    if (sandbox && s.result.status === 'PAYER_ACTION_REQUIRED' && n.kind === 'payment') {
      out(
        `  after the buyer approves: make sandbox-resume ARGS="${String(s.result.orderId)} --amount ${formatMinor(n.intent.amount)}"`,
      );
    }
  }
  out(
    `status ${run.status}${run.llmError === undefined ? '' : ` (${run.llmError})`}, ${String(run.steps.length)} intents, ${String(run.llmCalls)} LLM calls, ${usd(run.spentNanoUsd)} USD`,
  );
  return run.status === 'OK' ? 0 : 1;
}
