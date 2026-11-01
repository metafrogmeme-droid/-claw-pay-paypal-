// `make sandbox-resume ARGS="<order id> --amount 2.00"`: after the buyer approved a sandbox order in the browser,
// re-attach it to a fresh gate (owner side, not an agent tool), let pay_order re-check it with get_order
// (APPROVED, your payee, this amount) and only then capture. One attempt; run again if the buyer has not approved.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PaypalGate,
  loadPaypalRules,
  sandboxClientFromEnv,
  type FetchLike,
  type GateResult,
  type PaypalRulesFile,
} from '@claw-pay/paypal';

import { smokeRules, type Env } from './sandbox-smoke.js';

export interface ResumeDeps {
  readonly fetch?: FetchLike;
  readonly clock?: () => number;
  readonly rulesFile?: PaypalRulesFile;
}

const DEFAULT_RULES = resolve(import.meta.dirname, '../../../demo/paypal/rules.json');
const USAGE = 'usage: cp-sandbox-resume <order id> --amount <USD, e.g. 2.00>';

const line = (r: GateResult): string =>
  [
    r.verdict,
    r.orderId && `order ${r.orderId}`,
    r.status && `status ${r.status}`,
    r.paypalError && `PayPal error ${r.paypalError}`,
  ]
    .filter(Boolean)
    .join(' | ');

export async function runSandboxResume(
  argv: readonly string[],
  env: Env,
  out: (l: string) => void,
  deps: ResumeDeps = {},
): Promise<number> {
  const at = argv.indexOf('--amount');
  const amount = at < 0 ? undefined : argv[at + 1];
  const orderId = argv.find((a, i) => !a.startsWith('--') && i !== at + 1);
  if (orderId === undefined || amount === undefined || !/^[0-9]{1,6}\.[0-9]{2}$/.test(amount)) {
    out(USAGE);
    return 2;
  }
  const payee = env['PAYPAL_SANDBOX_PAYEE_MERCHANT_ID'] ?? '';
  if (payee === '') {
    out('Needs your OK: set PAYPAL_SANDBOX_PAYEE_MERCHANT_ID (your sandbox business account merchant id).');
    return 2;
  }
  let client;
  try {
    client = sandboxClientFromEnv(env, deps.fetch);
  } catch (e) {
    out(`Blocked by your rule: ${(e as Error).message}`); // names the variable, never its value
    return 2;
  }
  const clock = deps.clock ?? Date.now;
  const file = deps.rulesFile ?? (JSON.parse(readFileSync(DEFAULT_RULES, 'utf8')) as PaypalRulesFile);
  const { rules, config } = loadPaypalRules(smokeRules(file, payee), clock());
  const gate = new PaypalGate({ rules, config, client, clock, ownerOk: () => Promise.resolve(false) });

  const cost = Number(amount);
  const adopted = gate.adoptOrder(orderId, {
    currencyCode: 'USD',
    items: [{ name: 'Claw Pay resume', quantity: 1, itemCost: cost, taxPercent: 0, itemTotal: cost }],
  });
  out(`adopt_order -> ${line(adopted)}`);
  if (adopted.reason === 'REQUIREMENTS_UNREADABLE') return 2;
  if (adopted.outcome !== 'ALLOWED') return 1;

  const paid = await gate.call('pay_order', { id: orderId });
  if (paid.paypalError === 'ORDER_NOT_APPROVED') {
    out(
      `Needs your OK: the buyer has not approved this order yet (status ${String(paid.status)}). No capture was sent. Run this again after approval.`,
    );
    return 1;
  }
  out(`pay_order -> ${line(paid)}`);
  return paid.status === 'COMPLETED' ? 0 : 1;
}
