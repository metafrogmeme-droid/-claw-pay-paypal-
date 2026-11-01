// Stable reason codes plus the additive ACTION_NOT_ALLOWED (docs/DECISIONS.md D-018).
// decode() is the only place that turns a code into user-facing text, and it only uses the three verdicts.

export const REASON_CODES = [
  'OK',
  'SELLER_NOT_LISTED',
  'PAYTO_MISMATCH',
  'NETWORK_NOT_ALLOWED',
  'ASSET_NOT_ALLOWED',
  'ABOVE_CALL_CAP',
  'ABOVE_SELLER_DAILY_CAP',
  'ABOVE_DAILY_CAP',
  'TOO_MANY_PAYMENTS_TODAY',
  'QUOTE_DRIFT',
  'PROBE_FAILED',
  'PAID_NO_RESULT_HOLD',
  'REQUIREMENTS_UNREADABLE',
  'RULES_EXPIRED',
  'PAUSED',
  'NEEDS_OWNER_OK',
  'ACTION_NOT_ALLOWED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];
export type Outcome = 'ALLOWED' | 'BLOCKED' | 'NEEDS_OWNER_OK';

export const VERDICT = {
  ALLOWED: 'Allowed: within your limits',
  BLOCKED: 'Blocked by your rule: ',
  NEEDS_OWNER_OK: 'Needs your OK: ',
} as const;

const DETAIL: Record<ReasonCode, string> = {
  OK: '',
  SELLER_NOT_LISTED: 'this seller is not on your list',
  PAYTO_MISMATCH: 'the pay-to address is not the one on your list for this seller',
  NETWORK_NOT_ALLOWED: 'this network is not allowed',
  ASSET_NOT_ALLOWED: 'this asset or currency is not allowed',
  ABOVE_CALL_CAP: 'above your per-call cap',
  ABOVE_SELLER_DAILY_CAP: "above this seller's daily cap",
  ABOVE_DAILY_CAP: 'above your daily cap',
  TOO_MANY_PAYMENTS_TODAY: 'above your payments-per-day limit',
  QUOTE_DRIFT: "the price is above the seller's declared price by more than your limit",
  PROBE_FAILED: 'the endpoint did not answer the unpaid probe correctly',
  PAID_NO_RESULT_HOLD: 'the last paid call to this seller returned no result',
  REQUIREMENTS_UNREADABLE: 'the payment request could not be read',
  RULES_EXPIRED: 'your rules have expired',
  PAUSED: 'payments are paused',
  NEEDS_OWNER_OK: 'above your confirm threshold',
  ACTION_NOT_ALLOWED: 'this action is not on your allowed list',
};

export function outcomeOf(code: ReasonCode): Outcome {
  if (code === 'OK') return 'ALLOWED';
  if (code === 'NEEDS_OWNER_OK' || code === 'PAID_NO_RESULT_HOLD') return 'NEEDS_OWNER_OK';
  return 'BLOCKED';
}

/** The user-facing text for a code: always one of the three verdict forms. */
export function decode(code: ReasonCode): string {
  const outcome = outcomeOf(code);
  if (outcome === 'ALLOWED') return VERDICT.ALLOWED;
  return `${VERDICT[outcome]}${code} (${DETAIL[code]})`;
}
