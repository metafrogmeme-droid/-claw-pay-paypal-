// Gate state: counters per rolling UTC day, holds, pause. Pure, immutable updates.
import type { PaymentIntent } from './types.js';

export interface State {
  readonly paused: boolean;
  /** UTC calendar day (YYYY-MM-DD) the counters belong to. */
  readonly day: string;
  readonly spentToday: bigint;
  readonly paymentsToday: number;
  readonly sellerSpentToday: Readonly<Record<string, bigint>>;
  /** Seller origins held after a paid call returned no result. */
  readonly holds: readonly string[];
}

export type Actor = 'owner' | 'guardian';
export type StateResult = { ok: true; state: State } | { ok: false; error: 'ONLY_OWNER' };

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function emptyState(now: number): State {
  return {
    paused: false,
    day: utcDay(now),
    spentToday: 0n,
    paymentsToday: 0,
    sellerSpentToday: {},
    holds: [],
  };
}

/** Counters as of `now`: a new UTC day starts from zero (holds and pause carry over). */
export function rollDay(state: State, now: number): State {
  const day = utcDay(now);
  return day === state.day
    ? state
    : { ...state, day, spentToday: 0n, paymentsToday: 0, sellerSpentToday: {} };
}

/** Record a payment the gate actually made (only after an ALLOWED or owner-approved decision). */
export function recordPayment(state: State, intent: PaymentIntent, now: number): State {
  const s = rollDay(state, now);
  const seller = s.sellerSpentToday[intent.sellerOrigin] ?? 0n;
  return {
    ...s,
    spentToday: s.spentToday + intent.amount,
    paymentsToday: s.paymentsToday + 1,
    sellerSpentToday: { ...s.sellerSpentToday, [intent.sellerOrigin]: seller + intent.amount },
  };
}

/** A settled payment returned empty/error/invalid: hold the seller (never auto-retry). */
export function recordPaidNoResult(state: State, sellerOrigin: string): State {
  return state.holds.includes(sellerOrigin) ? state : { ...state, holds: [...state.holds, sellerOrigin] };
}

export function releaseHold(state: State, sellerOrigin: string, by: Actor): StateResult {
  if (by !== 'owner') return { ok: false, error: 'ONLY_OWNER' };
  return { ok: true, state: { ...state, holds: state.holds.filter((h) => h !== sellerOrigin) } };
}

/** The guardian or the owner may pause. `by` is kept for the receipt log. */
export function pause(state: State, _by: Actor): State {
  return { ...state, paused: true };
}

export function unpause(state: State, by: Actor): StateResult {
  if (by !== 'owner') return { ok: false, error: 'ONLY_OWNER' };
  return { ok: true, state: { ...state, paused: false } };
}
