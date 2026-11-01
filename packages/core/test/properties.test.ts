// Property tests for the rule core (M2 acceptance: >= 6 properties).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  REASON_CODES,
  VERDICT,
  decide,
  decode,
  emptyState,
  pause,
  recordPayment,
  utcDay,
  type PaymentIntent,
  type State,
} from '../src/index.js';
import { DAY, EMPTY, GOOD, NOW, cents, intent, rules } from './fixtures.js';

const seller = fc.constantFrom(GOOD, EMPTY, { origin: 'https://unlisted.test', payTo: GOOD.payTo });
const amount = fc.bigInt({ min: 1n, max: cents(0.1) });
const step = fc.record({
  s: seller,
  amount,
  dt: fc.integer({ min: 0, max: 6 * 3_600_000 }),
  approved: fc.boolean(),
});

/** Runs a sequence: a payment is recorded only when decide() allows it. */
function run(
  steps: { s: { origin: string; payTo: string }; amount: bigint; dt: number; approved: boolean }[],
) {
  let state: State = emptyState(NOW);
  let now = NOW;
  const trace: { now: number; state: State; allowed: PaymentIntent | undefined }[] = [];
  for (const st of steps) {
    now += st.dt;
    const i = intent({ sellerOrigin: st.s.origin, payTo: st.s.payTo, amount: st.amount, quoteTime: now });
    const d = decide(i, rules, state, now, { ownerApproved: st.approved });
    if (d.outcome === 'ALLOWED') state = recordPayment(state, i, now);
    trace.push({ now, state, allowed: d.outcome === 'ALLOWED' ? i : undefined });
  }
  return trace;
}

describe('rule core properties', () => {
  it('caps are never exceeded, whatever the sequence', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        for (const { state, allowed } of run(steps)) {
          expect(state.spentToday <= rules.dailyCap).toBe(true);
          expect(state.paymentsToday <= rules.maxPaymentsPerDay).toBe(true);
          expect((state.sellerSpentToday[GOOD.origin] ?? 0n) <= cents(0.2)).toBe(true);
          if (allowed) expect(allowed.amount <= rules.perCallCap).toBe(true);
        }
      }),
    );
  });

  it('counters only grow within one UTC day and restart on a new day', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        let prev: { day: string; spent: bigint; count: number } | undefined;
        for (const { state } of run(steps)) {
          if (prev?.day === state.day) {
            expect(state.spentToday >= prev.spent).toBe(true);
            expect(state.paymentsToday >= prev.count).toBe(true);
          }
          prev = { day: state.day, spent: state.spentToday, count: state.paymentsToday };
        }
      }),
    );
  });

  it('unreadable intents are always BLOCKED with REQUIREMENTS_UNREADABLE', () => {
    const bad = fc.oneof(
      fc.record({ amount: fc.bigInt({ max: 0n }) }),
      fc.record({ sellerOrigin: fc.constant('') }),
      fc.record({ payTo: fc.constant('') }),
      fc.record({ network: fc.string().filter((n) => !/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(n)) }),
      fc.record({ quoteTime: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY) }),
    );
    fc.assert(
      fc.property(bad, fc.boolean(), (over, approved) => {
        const d = decide(intent(over), rules, emptyState(NOW), NOW, {
          ownerApproved: approved,
        });
        expect(d).toMatchObject({ outcome: 'BLOCKED', reason: 'REQUIREMENTS_UNREADABLE' });
      }),
    );
  });

  it('decode() only ever returns one of the three verdict forms', () => {
    fc.assert(
      fc.property(fc.constantFrom(...REASON_CODES), (code) => {
        const t = decode(code);
        const ok =
          t === VERDICT.ALLOWED || t.startsWith(VERDICT.BLOCKED) || t.startsWith(VERDICT.NEEDS_OWNER_OK);
        expect(ok).toBe(true);
      }),
    );
  });

  it('owner approval never turns a BLOCKED decision into anything else', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 30 }), seller, amount, (steps, s, a) => {
        const last = run(steps).at(-1);
        const state = last?.state ?? emptyState(NOW);
        const now = last?.now ?? NOW;
        const i = intent({ sellerOrigin: s.origin, payTo: s.payTo, amount: a, quoteTime: now });
        if (decide(i, rules, state, now).outcome === 'BLOCKED') {
          expect(decide(i, rules, state, now, { ownerApproved: true }).outcome).toBe('BLOCKED');
        }
      }),
    );
  });

  it('a paused gate or expired rules never allow a payment', () => {
    fc.assert(
      fc.property(seller, amount, fc.integer({ min: 0, max: 30 }), fc.boolean(), (s, a, days, approved) => {
        const i = intent({ sellerOrigin: s.origin, payTo: s.payTo, amount: a });
        const paused = decide(i, rules, pause(emptyState(NOW), 'guardian'), NOW, { ownerApproved: approved });
        expect(paused.reason).toBe('PAUSED');
        const later = rules.expiresAt + days * DAY;
        const expired = decide(i, rules, emptyState(later), later, { ownerApproved: approved });
        expect(expired.reason).toBe('RULES_EXPIRED');
      }),
    );
  });

  it('decide() is deterministic and does not mutate its inputs', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 20 }), seller, amount, (steps, s, a) => {
        const last = run(steps).at(-1);
        const state = last?.state ?? emptyState(NOW);
        const before = JSON.stringify(state, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
        const i = intent({ sellerOrigin: s.origin, payTo: s.payTo, amount: a });
        expect(decide(i, rules, state, NOW)).toEqual(decide(i, rules, state, NOW));
        const after = JSON.stringify(state, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
        expect(after).toBe(before);
        expect(utcDay(NOW)).toBe('2026-11-02');
      }),
    );
  });
});
