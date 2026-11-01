// `make sandbox-smoke`: one real sandbox create_order (2.00 USD) through the gate, then stop at the buyer step.
// Prints the order id, status and payer-action URL. Never prints credentials. Never approves for the buyer.
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

export type Env = Readonly<Record<string, string | undefined>>;

export interface SmokeDeps {
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
  readonly rulesFile?: PaypalRulesFile;
}

const DEFAULT_RULES = resolve(import.meta.dirname, '../../../demo/paypal/rules.json');
const POLL_MS = 15_000;
export const realSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
const SMOKE_ORDER = {
  currencyCode: 'USD',
  items: [{ name: 'Claw Pay sandbox smoke', quantity: 1, itemCost: 2, taxPercent: 0, itemTotal: 2 }],
};

const line = (r: GateResult): string =>
  [
    r.verdict,
    r.orderId && `order ${r.orderId}`,
    r.status && `status ${r.status}`,
    r.paypalError && `PayPal error ${r.paypalError}`,
  ]
    .filter(Boolean)
    .join(' | ');

/** Demo rules, with seller-a pointed at YOUR sandbox business account (the REST app owner). */
export function smokeRules(file: PaypalRulesFile, payee: string): PaypalRulesFile {
  return {
    ...file,
    sellers: file.sellers.map((s) => (s.id === file.pinnedSeller ? { ...s, merchantId: payee } : s)),
  };
}

export async function runSandboxSmoke(
  env: Env,
  out: (l: string) => void,
  deps: SmokeDeps = {},
): Promise<number> {
  const payee = env['PAYPAL_SANDBOX_PAYEE_MERCHANT_ID'] ?? '';
  if (payee === '') {
    out('Needs your OK: set PAYPAL_SANDBOX_PAYEE_MERCHANT_ID (your sandbox business account merchant id).');
    return 2;
  }
  let client;
  try {
    client = sandboxClientFromEnv(env, deps.fetch);
  } catch (e) {
    out(`Blocked by your rule: ${(e as Error).message}`); // messages name the variable, never its value
    return 2;
  }
  const clock = deps.clock ?? Date.now;
  const file = deps.rulesFile ?? (JSON.parse(readFileSync(DEFAULT_RULES, 'utf8')) as PaypalRulesFile);
  const { rules, config } = loadPaypalRules(smokeRules(file, payee), clock());
  const gate = new PaypalGate({ rules, config, client, clock, ownerOk: () => Promise.resolve(false) });

  out('Claw Pay sandbox smoke: create_order 2.00 USD through the gate (PayPal sandbox only).');
  const created = await gate.call('create_order', SMOKE_ORDER);
  out(`create_order -> ${line(created)}`);
  if (created.orderId === undefined || created.status !== 'PAYER_ACTION_REQUIRED') return 1;
  out(
    `Buyer step (open in a browser, log in as the sandbox PERSONAL account): ${String(created.payerActionUrl)}`,
  );

  const waitMin = Number(env['CP_SMOKE_WAIT_MINUTES'] ?? '0');
  if (!Number.isInteger(waitMin) || waitMin <= 0) {
    out('Stopped at PAYER_ACTION_REQUIRED (no capture). Set CP_SMOKE_WAIT_MINUTES to wait and capture.');
    return 0;
  }
  const sleep = deps.sleep ?? realSleep;
  const until = clock() + waitMin * 60_000;
  while (clock() < until) {
    await sleep(POLL_MS);
    const now = await gate.call('get_order', { id: created.orderId });
    if (now.status === 'APPROVED') {
      const paid = await gate.call('pay_order', { id: created.orderId });
      out(`pay_order -> ${line(paid)}`);
      return paid.status === 'COMPLETED' ? 0 : 1;
    }
  }
  out('The buyer did not approve in time. No capture was sent.');
  return 1;
}
