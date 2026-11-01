// Unit tests for the rule core (M2 acceptance).
import { describe, expect, it } from 'vitest';

import {
  REASON_CODES,
  VERDICT,
  decide,
  decode,
  emptyState,
  outcomeOf,
  pause,
  recordPaidNoResult,
  recordPayment,
  releaseHold,
  unpause,
  utcDay,
  type PaymentIntent,
  type ReasonCode,
  type State,
} from '../src/index.js';
import { ASSET, DAY, EMPTY, GOOD, NET, NOW, cents, intent, rules } from './fixtures.js';

const s0 = emptyState(NOW);
const spend = (state: State, times: number, i: PaymentIntent = intent()): State => {
  let s = state;
  for (let k = 0; k < times; k++) s = recordPayment(s, i, NOW);
  return s;
};
const reason = (i: PaymentIntent, s: State = s0, opts = {}): ReasonCode =>
  decide(i, rules, s, NOW, opts).reason;

describe('reason codes and decode()', () => {
  it('has the 16 stable codes plus the additive ACTION_NOT_ALLOWED', () => {
    expect(REASON_CODES).toHaveLength(17);
    expect(REASON_CODES).toContain('ACTION_NOT_ALLOWED');
  });

  it.each(REASON_CODES.map((c) => [c]))('%s decodes to exactly one of the three verdicts', (code) => {
    const text = decode(code);
    const o = outcomeOf(code);
    if (o === 'ALLOWED') expect(text).toBe(VERDICT.ALLOWED);
    else expect(text.startsWith(o === 'BLOCKED' ? VERDICT.BLOCKED : VERDICT.NEEDS_OWNER_OK)).toBe(true);
    if (o !== 'ALLOWED') expect(text).toContain(code);
  });

  it.each([
    ['OK', 'ALLOWED'],
    ['NEEDS_OWNER_OK', 'NEEDS_OWNER_OK'],
    ['PAID_NO_RESULT_HOLD', 'NEEDS_OWNER_OK'],
    ['SELLER_NOT_LISTED', 'BLOCKED'],
    ['REQUIREMENTS_UNREADABLE', 'BLOCKED'],
  ] as const)('%s maps to %s', (code, outcome) => {
    expect(outcomeOf(code)).toBe(outcome);
  });
});

describe('decide(): allowed paths', () => {
  it.each<[string, Partial<PaymentIntent>]>([
    ['baseline', {}],
    ['EVM asset compared case-insensitively', { asset: ASSET.toLowerCase() }],
    ['EVM payTo compared case-insensitively', { payTo: GOOD.payTo.toLowerCase() }],
    ['amount exactly at the confirm threshold', { amount: cents(0.04) }],
    ['price within quote drift', { amount: cents(0.011), declaredAmount: cents(0.01) }],
    ['price drop below the declared price', { amount: cents(0.005), declaredAmount: cents(0.01) }],
    ['ISO-4217 asset on a paypal:* network', { network: 'paypal:sandbox', asset: 'USD' }],
  ])('%s → Allowed', (_name, over) => {
    const d = decide(intent(over), rules, s0, NOW);
    expect(d).toEqual({ outcome: 'ALLOWED', reason: 'OK', verdict: VERDICT.ALLOWED });
  });
});

describe('decide(): one blocked or needs-OK case per rule', () => {
  it.each<[ReasonCode, Partial<PaymentIntent>]>([
    ['ACTION_NOT_ALLOWED', { action: 'create_subscription' }],
    ['NETWORK_NOT_ALLOWED', { network: 'eip155:1' }],
    ['ASSET_NOT_ALLOWED', { asset: '0x00000000000000000000000000000000000000A2' }],
    ['ASSET_NOT_ALLOWED', { asset: 'USD' }], // a symbol on an EVM network never matches an address
    ['ASSET_NOT_ALLOWED', { network: 'paypal:sandbox', asset: 'EUR' }],
    ['SELLER_NOT_LISTED', { sellerOrigin: 'https://unlisted.test' }],
    ['PAYTO_MISMATCH', { payTo: '0x000000000000000000000000000000000000BAD0' }],
    ['QUOTE_DRIFT', { amount: cents(0.02), declaredAmount: cents(0.01) }],
    ['ABOVE_CALL_CAP', { amount: cents(0.08) }],
    ['NEEDS_OWNER_OK', { amount: cents(0.045) }],
  ])('%s (case %#)', (code, over) => {
    const d = decide(intent(over), rules, s0, NOW);
    expect(d.reason).toBe(code);
    expect(d.outcome).toBe(outcomeOf(code));
    expect(d.verdict).toBe(decode(code));
  });

  it('PAUSED beats every other rule', () => {
    expect(reason(intent({ sellerOrigin: 'https://unlisted.test' }), pause(s0, 'guardian'))).toBe('PAUSED');
  });

  it('RULES_EXPIRED at and after expiresAt, but not one ms before', () => {
    expect(decide(intent(), rules, s0, rules.expiresAt).reason).toBe('RULES_EXPIRED');
    expect(decide(intent(), rules, s0, rules.expiresAt + DAY).reason).toBe('RULES_EXPIRED');
    expect(decide(intent(), rules, emptyState(rules.expiresAt - 1), rules.expiresAt - 1).reason).toBe('OK');
  });

  it('PROBE_FAILED when the gate reports a failed probe', () => {
    expect(reason(intent(), s0, { probeOk: false })).toBe('PROBE_FAILED');
    expect(reason(intent(), s0, { probeOk: true })).toBe('OK');
  });

  it('per-seller per-call cap tighter than the global cap', () => {
    const r = { ...rules, sellers: [{ ...GOOD, perCallCap: cents(0.02) }] };
    expect(decide(intent({ amount: cents(0.03) }), r, s0, NOW).reason).toBe('ABOVE_CALL_CAP');
  });

  it('TOO_MANY_PAYMENTS_TODAY after maxPaymentsPerDay', () => {
    const r = { ...rules, maxPaymentsPerDay: 2 };
    expect(decide(intent(), r, spend(s0, 1), NOW).reason).toBe('OK');
    expect(decide(intent(), r, spend(s0, 2), NOW).reason).toBe('TOO_MANY_PAYMENTS_TODAY');
  });

  it('ABOVE_SELLER_DAILY_CAP once the seller total would pass 0.20', () => {
    const r = { ...rules, maxPaymentsPerDay: 100 };
    const s = spend(s0, 20, intent()); // 20 x 0.01 = 0.20 to good
    expect(decide(intent(), r, s, NOW).reason).toBe('ABOVE_SELLER_DAILY_CAP');
  });

  it('ABOVE_DAILY_CAP once the day total would pass 0.30', () => {
    const r = { ...rules, maxPaymentsPerDay: 100 };
    const s = spend(spend(s0, 20, intent()), 10, intent({ sellerOrigin: EMPTY.origin, payTo: EMPTY.payTo }));
    const d = decide(intent({ sellerOrigin: EMPTY.origin, payTo: EMPTY.payTo }), r, s, NOW);
    expect(d.reason).toBe('ABOVE_DAILY_CAP');
  });

  it('PAID_NO_RESULT_HOLD needs the owner, and the owner approval clears only that', () => {
    const held = recordPaidNoResult(s0, EMPTY.origin);
    const i = intent({ sellerOrigin: EMPTY.origin, payTo: EMPTY.payTo });
    expect(decide(i, rules, held, NOW)).toMatchObject({
      outcome: 'NEEDS_OWNER_OK',
      reason: 'PAID_NO_RESULT_HOLD',
    });
    expect(reason(i, held, { ownerApproved: true })).toBe('OK');
    expect(reason(intent(), held)).toBe('OK'); // other sellers are not held
  });

  it('owner approval clears the confirm threshold but never a block', () => {
    expect(reason(intent({ amount: cents(0.045) }), s0, { ownerApproved: true })).toBe('OK');
    expect(reason(intent({ amount: cents(0.08) }), s0, { ownerApproved: true })).toBe('ABOVE_CALL_CAP');
  });

  it('a new UTC day resets the counters', () => {
    const full = spend(s0, 20);
    expect(decide(intent(), rules, full, NOW + DAY).reason).toBe('OK');
  });
});

describe('decide(): unreadable intents fail closed', () => {
  it.each<[string, Partial<PaymentIntent>]>([
    ['zero amount', { amount: 0n }],
    ['negative amount', { amount: -1n }],
    ['amount not a bigint', { amount: 1 as unknown as bigint }],
    ['empty seller origin', { sellerOrigin: '' }],
    ['empty payTo', { payTo: '' }],
    ['empty asset', { asset: '' }],
    ['network not CAIP-2 shaped', { network: 'base-sepolia' }],
    ['quote time not finite', { quoteTime: Number.NaN }],
    ['declared amount not positive', { declaredAmount: 0n }],
  ])('%s → REQUIREMENTS_UNREADABLE', (_name, over) => {
    expect(decide(intent(over), rules, s0, NOW)).toMatchObject({
      outcome: 'BLOCKED',
      reason: 'REQUIREMENTS_UNREADABLE',
    });
  });

  it('a missing intent field is unreadable', () => {
    const rest = Object.fromEntries(Object.entries(intent()).filter(([k]) => k !== 'payTo'));
    expect(reason(rest as unknown as PaymentIntent)).toBe('REQUIREMENTS_UNREADABLE');
  });
});

describe('state transitions', () => {
  it('recordPayment adds spend, count and seller spend without mutating the input', () => {
    const s = recordPayment(s0, intent({ amount: cents(0.03) }), NOW);
    expect(s.spentToday).toBe(cents(0.03));
    expect(s.paymentsToday).toBe(1);
    expect(s.sellerSpentToday[GOOD.origin]).toBe(cents(0.03));
    expect(s0.spentToday).toBe(0n);
  });

  it('recordPayment on a new UTC day starts from zero', () => {
    const s = recordPayment(spend(s0, 5), intent(), NOW + DAY);
    expect(s).toMatchObject({ day: utcDay(NOW + DAY), spentToday: cents(0.01), paymentsToday: 1 });
  });

  it('recordPaidNoResult is idempotent', () => {
    const s = recordPaidNoResult(recordPaidNoResult(s0, EMPTY.origin), EMPTY.origin);
    expect(s.holds).toEqual([EMPTY.origin]);
  });

  it('only the owner releases a hold', () => {
    const held = recordPaidNoResult(s0, EMPTY.origin);
    expect(releaseHold(held, EMPTY.origin, 'guardian')).toEqual({ ok: false, error: 'ONLY_OWNER' });
    const r = releaseHold(held, EMPTY.origin, 'owner');
    expect(r.ok && r.state.holds).toEqual([]);
  });

  it('the guardian or owner may pause; only the owner unpauses', () => {
    const p = pause(s0, 'guardian');
    expect(p.paused).toBe(true);
    expect(pause(s0, 'owner').paused).toBe(true);
    expect(unpause(p, 'guardian')).toEqual({ ok: false, error: 'ONLY_OWNER' });
    const u = unpause(p, 'owner');
    expect(u.ok && u.state.paused).toBe(false);
  });

  it('utcDay formats the UTC calendar day', () => {
    expect(utcDay(Date.UTC(2026, 10, 2, 23, 59, 59))).toBe('2026-11-02');
    expect(utcDay(Date.UTC(2026, 10, 3, 0, 0, 0))).toBe('2026-11-03');
  });

  it('emptyState starts unpaused with zero counters', () => {
    expect(emptyState(NOW)).toEqual({
      paused: false,
      day: '2026-11-02',
      spentToday: 0n,
      paymentsToday: 0,
      sellerSpentToday: {},
      holds: [],
    });
  });

  it('uses the NET fixture as the allowed network', () => {
    expect(rules.networks).toContain(NET);
  });
});
