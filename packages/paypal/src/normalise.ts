// PayPal tool call → PaymentIntent (docs/DECISIONS.md D-016).
// Field names mirror @paypal/agent-toolkit 1.11.0 createOrderParameters plus ONE Claw Pay
// field, `payee`, shaped like Orders v2 payee_base { email_address, merchant_id }. Strict: unknown → unreadable.
import type { PaymentIntent } from '@claw-pay/core';
import { z } from 'zod';

import { toMinorUnits } from './money.js';
import { PaypalGuardError } from './sandbox.js';

export interface PaypalSeller {
  /** Label used in rules as origin `paypal:<id>`. */
  readonly id: string;
  /** Sandbox business account merchant id. */
  readonly merchantId: string;
  readonly email?: string;
}

export interface PaypalConfig {
  /** CAIP-2-shaped network for intents (D-019). */
  readonly network: 'paypal:sandbox';
  readonly sellers: readonly PaypalSeller[];
  /** The seller whose REST app credentials the gate uses: the only account the toolkit can pay. */
  readonly pinnedSellerId: string;
}

export type NormaliseResult =
  | {
      readonly kind: 'payment';
      readonly intent: PaymentIntent;
      readonly toolkitArgs: Record<string, unknown>;
    }
  | { readonly kind: 'capture'; readonly orderId: string }
  | { readonly kind: 'read'; readonly action: string; readonly toolkitArgs: Record<string, unknown> }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'unsupported'; readonly action: string };

const ORDER_ID = /^[A-Z0-9]{17,32}$/;
const optString = z.string().optional();
const lineItem = z.strictObject({
  name: z.string().min(1),
  quantity: z.number().int().min(1).optional(),
  description: optString,
  itemCost: z.number(),
  taxPercent: z.number().optional(),
  itemTotal: z.number(),
});
const shippingAddress = z.strictObject({
  address_line_1: optString,
  address_line_2: optString,
  admin_area_2: optString,
  admin_area_1: optString,
  postal_code: optString,
  country_code: z.string().length(2).optional(),
});
const payee = z
  .strictObject({ email_address: z.string().min(3).optional(), merchant_id: z.string().min(1).optional() })
  .refine((p) => p.email_address !== undefined || p.merchant_id !== undefined);
const createOrder = z.strictObject({
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  items: z.array(lineItem).min(1).max(50),
  discount: z.number().optional(),
  shippingCost: z.number().optional(),
  shippingAddress: shippingAddress.nullable().optional(),
  notes: z.string().nullable().optional(),
  returnUrl: optString,
  cancelUrl: optString,
  payee: payee.optional(),
});
const byOrderId = z.strictObject({ id: z.string().regex(ORDER_ID) });

type CreateOrder = z.infer<typeof createOrder>;

/** Exact total in minor units using the toolkit's formula; undefined if any amount is not exact. */
function orderTotal(o: CreateOrder): bigint | undefined {
  let total = 0n;
  for (const it of o.items) {
    const cost = toMinorUnits(it.itemCost);
    const itemTotal = toMinorUnits(it.itemTotal);
    const taxBp = toMinorUnits(it.taxPercent ?? 0); // percent with 2 decimals → hundredths of a percent
    if (cost === undefined || itemTotal === undefined || taxBp === undefined) return undefined;
    const qty = BigInt(it.quantity ?? 1);
    if (itemTotal !== cost * qty) return undefined; // the toolkit ignores itemTotal; a mismatch is a red flag
    const unitTaxScaled = cost * taxBp; // minor units × 10_000
    if (unitTaxScaled % 10_000n !== 0n) return undefined; // tax would need a fraction of a cent
    total += cost * qty + (unitTaxScaled / 10_000n) * qty;
  }
  const shipping = toMinorUnits(o.shippingCost ?? 0);
  const discount = toMinorUnits(o.discount ?? 0);
  if (shipping === undefined || discount === undefined) return undefined;
  total += shipping - discount;
  return total > 0n ? total : undefined;
}

function resolvePayee(o: CreateOrder, cfg: PaypalConfig): { sellerOrigin: string; payTo: string } {
  const pinned = cfg.sellers.find((s) => s.id === cfg.pinnedSellerId);
  if (!pinned) throw new PaypalGuardError('ERR_CONFIG', 'pinned seller is not in the seller list');
  const p = o.payee;
  if (!p) return { sellerOrigin: `paypal:${pinned.id}`, payTo: pinned.merchantId };
  const found =
    p.email_address !== undefined
      ? cfg.sellers.find((s) => s.email === p.email_address)
      : cfg.sellers.find((s) => s.merchantId === p.merchant_id);
  if (!found) {
    // Never a rules origin (rules use `paypal:`), so the core answers SELLER_NOT_LISTED.
    return {
      sellerOrigin: `paypal-unlisted:${String(p.merchant_id ?? p.email_address)}`,
      payTo: p.merchant_id ?? '-',
    };
  }
  // The toolkit can only pay the pinned account, so for any other listed seller the money would go to the pin.
  const payTo = found.id === pinned.id ? (p.merchant_id ?? found.merchantId) : pinned.merchantId;
  return { sellerOrigin: `paypal:${found.id}`, payTo };
}

/** Parse or return undefined (any error, including a throwing getter, fails closed). */
function read<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  try {
    return schema.parse(value);
  } catch {
    return undefined;
  }
}

/** Normalise one proxied tool call. Never throws for bad agent input; throws only for a bad gate config. */
export function normalise(tool: string, args: unknown, cfg: PaypalConfig, now: number): NormaliseResult {
  switch (tool) {
    case 'create_order': {
      const o = read(createOrder, args);
      if (o === undefined) return { kind: 'unreadable' };
      const amount = orderTotal(o);
      if (amount === undefined) return { kind: 'unreadable' };
      const { payee: _payee, ...toolkitArgs } = o; // the gate owns `payee`; the toolkit never sees it
      const { sellerOrigin, payTo } = resolvePayee(o, cfg);
      const intent: PaymentIntent = {
        sellerOrigin,
        resourceUrl: 'paypal:/v2/checkout/orders',
        network: cfg.network,
        asset: o.currencyCode,
        amount,
        payTo,
        scheme: 'orders-v2-capture',
        quoteTime: now,
        action: 'create_order',
      };
      return { kind: 'payment', intent, toolkitArgs };
    }
    case 'pay_order': {
      const r = read(byOrderId, args);
      return r ? { kind: 'capture', orderId: r.id } : { kind: 'unreadable' };
    }
    case 'get_order': {
      const r = read(byOrderId, args);
      return r ? { kind: 'read', action: tool, toolkitArgs: r } : { kind: 'unreadable' };
    }
    default:
      return { kind: 'unsupported', action: tool };
  }
}
