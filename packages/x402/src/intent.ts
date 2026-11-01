// One parsed accepts entry → core PaymentIntent (action `pay`).
import type { PaymentIntent } from '@claw-pay/core';

import type { Accept, PaymentRequirements } from './parse.js';

export interface IntentContext {
  /** Origin of the URL the agent requested (not taken from the 402). */
  readonly sellerOrigin: string;
  readonly quoteTime: number;
  /** The seller's declared or probed price, for QUOTE_DRIFT. */
  readonly declaredAmount?: bigint;
}

export function toPaymentIntent(req: PaymentRequirements, accept: Accept, ctx: IntentContext): PaymentIntent {
  return {
    sellerOrigin: ctx.sellerOrigin,
    resourceUrl: req.resourceUrl,
    network: accept.network,
    asset: accept.asset,
    amount: accept.amount,
    payTo: accept.payTo,
    scheme: accept.scheme,
    quoteTime: ctx.quoteTime,
    action: 'pay',
    ...(ctx.declaredAmount === undefined ? {} : { declaredAmount: ctx.declaredAmount }),
  };
}
