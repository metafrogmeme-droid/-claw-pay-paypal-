// The pure rule core: decide(intent, rules, state, now). No I/O, no clock, no randomness.
import { decode, outcomeOf, type Outcome, type ReasonCode } from './reasons.js';
import { rollDay, type State } from './state.js';
import type { DecideOptions, PaymentIntent, Rules } from './types.js';

export interface Decision {
  readonly outcome: Outcome;
  readonly reason: ReasonCode;
  readonly verdict: string;
}

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const isEvm = (network: string): boolean => network.startsWith('eip155:');
const sameAddress = (network: string, a: string, b: string): boolean =>
  isEvm(network) ? a.toLowerCase() === b.toLowerCase() : a === b;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const positive = (v: unknown): v is bigint => typeof v === 'bigint' && v > 0n;

function readable(i: PaymentIntent): boolean {
  return (
    nonEmpty(i.sellerOrigin) &&
    nonEmpty(i.resourceUrl) &&
    nonEmpty(i.network) &&
    CAIP2.test(i.network) &&
    nonEmpty(i.asset) &&
    nonEmpty(i.payTo) &&
    nonEmpty(i.scheme) &&
    nonEmpty(i.action) &&
    positive(i.amount) &&
    Number.isFinite(i.quoteTime) &&
    (i.declaredAmount === undefined || positive(i.declaredAmount))
  );
}

function assetAllowed(rules: Rules, i: PaymentIntent): boolean {
  // An ISO-4217 code is only an asset on paypal:* networks; on EVM a symbol never matches an address.
  return rules.assets.some((a) => a.network === i.network && sameAddress(i.network, a.asset, i.asset));
}

function check(i: PaymentIntent, rules: Rules, state: State, now: number, opts: DecideOptions): ReasonCode {
  if (!readable(i)) return 'REQUIREMENTS_UNREADABLE';
  if (state.paused) return 'PAUSED';
  if (now >= rules.expiresAt) return 'RULES_EXPIRED';
  if (!rules.actions.includes(i.action)) return 'ACTION_NOT_ALLOWED';
  if (!rules.networks.includes(i.network)) return 'NETWORK_NOT_ALLOWED';
  if (!assetAllowed(rules, i)) return 'ASSET_NOT_ALLOWED';
  const seller = rules.sellers.find((s) => s.origin === i.sellerOrigin);
  if (!seller) return 'SELLER_NOT_LISTED';
  if (!sameAddress(i.network, seller.payTo, i.payTo)) return 'PAYTO_MISMATCH';
  if (opts.probeOk === false) return 'PROBE_FAILED';
  if (
    i.declaredAmount !== undefined &&
    i.amount * 10_000n > i.declaredAmount * BigInt(10_000 + rules.quoteDriftBps)
  ) {
    return 'QUOTE_DRIFT';
  }
  const callCap =
    seller.perCallCap !== undefined && seller.perCallCap < rules.perCallCap
      ? seller.perCallCap
      : rules.perCallCap;
  if (i.amount > callCap) return 'ABOVE_CALL_CAP';
  const s = rollDay(state, now);
  if (s.paymentsToday + 1 > rules.maxPaymentsPerDay) return 'TOO_MANY_PAYMENTS_TODAY';
  const sellerSpent = s.sellerSpentToday[seller.origin] ?? 0n;
  if (seller.dailyCap !== undefined && sellerSpent + i.amount > seller.dailyCap)
    return 'ABOVE_SELLER_DAILY_CAP';
  if (s.spentToday + i.amount > rules.dailyCap) return 'ABOVE_DAILY_CAP';
  if (opts.ownerApproved !== true) {
    if (s.holds.includes(seller.origin)) return 'PAID_NO_RESULT_HOLD';
    if (i.amount > rules.confirmThreshold) return 'NEEDS_OWNER_OK';
  }
  return 'OK';
}

/** Decide one payment. Fail closed: anything unreadable is BLOCKED (REQUIREMENTS_UNREADABLE). */
export function decide(
  intent: PaymentIntent,
  rules: Rules,
  state: State,
  now: number,
  opts: DecideOptions = {},
): Decision {
  const reason = check(intent, rules, state, now, opts);
  return { outcome: outcomeOf(reason), reason, verdict: decode(reason) };
}
