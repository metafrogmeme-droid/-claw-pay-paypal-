// demo/paypal/rules.json → core Rules + PaypalConfig. Strict; amounts are decimal strings.
import type { Rules } from '@claw-pay/core';
import { z } from 'zod';

import { toMinorUnits } from './money.js';
import type { PaypalConfig, PaypalSeller } from './normalise.js';
import { PaypalGuardError, TOOL_NAMES } from './sandbox.js';

const amount = z.string().transform((v, ctx) => {
  const m = toMinorUnits(v);
  if (m === undefined) {
    ctx.addIssue({ code: 'custom', message: 'amount: digits with at most 2 decimals' });
    return z.NEVER;
  }
  return m;
});
const seller = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  merchantId: z.string().min(1),
  email: z.string().min(3).optional(),
  maxAmount: amount,
  dailyCap: amount.optional(),
});
const rulesFile = z
  .strictObject({
    _note: z.string().optional(),
    rail: z.literal('paypal:sandbox'),
    currency: z.literal('USD'),
    sellers: z.array(seller).min(1),
    pinnedSeller: z.string(),
    perCallCap: amount,
    dailyCap: amount,
    maxPaymentsPerDay: z.number().int().min(1),
    confirmThreshold: amount,
    expiresInDays: z.number().int().min(1).max(365),
    allowedActions: z.array(z.enum(TOOL_NAMES)).min(1),
  })
  .refine((f) => f.sellers.some((s) => s.id === f.pinnedSeller), 'pinnedSeller must be listed');

export type PaypalRulesFile = z.input<typeof rulesFile>;

export function loadPaypalRules(json: unknown, now: number): { rules: Rules; config: PaypalConfig } {
  let f: z.output<typeof rulesFile>;
  try {
    f = rulesFile.parse(json);
  } catch (e) {
    throw new PaypalGuardError('ERR_RULES', `invalid rules file: ${(e as Error).message}`);
  }
  const sellers: PaypalSeller[] = f.sellers.map((s) => ({
    id: s.id,
    merchantId: s.merchantId,
    ...(s.email === undefined ? {} : { email: s.email }),
  }));
  const rules: Rules = {
    version: 1,
    sellers: f.sellers.map((s) => ({
      origin: `paypal:${s.id}`,
      payTo: s.merchantId,
      perCallCap: s.maxAmount,
      ...(s.dailyCap === undefined ? {} : { dailyCap: s.dailyCap }),
    })),
    perCallCap: f.perCallCap,
    dailyCap: f.dailyCap,
    maxPaymentsPerDay: f.maxPaymentsPerDay,
    networks: [f.rail],
    assets: [{ network: f.rail, asset: f.currency }],
    confirmThreshold: f.confirmThreshold,
    quoteDriftBps: 0,
    expiresAt: now + f.expiresInDays * 86_400_000,
    actions: f.allowedActions,
  };
  return { rules, config: { network: f.rail, sellers, pinnedSellerId: f.pinnedSeller } };
}
