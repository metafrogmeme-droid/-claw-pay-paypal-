// In-process PayPal gate: normalise → core.decide → only then PayPal (D-021).
// A blocked call makes zero PayPal calls. pay_order works only for orders this gate created, once per order id,
// and only after get_order shows APPROVED with the payee and amount the gate decided on.
import {
  decide,
  decode,
  emptyState,
  pause,
  recordPayment,
  rollDay,
  unpause,
  type Actor,
  type Decision,
  type Outcome,
  type PaymentIntent,
  type ReasonCode,
  type Rules,
  type State,
} from '@claw-pay/core';

import { PaypalApiError, type PaypalClient, type PaypalOrder } from './client.js';
import { normalise, type PaypalConfig } from './normalise.js';

export interface GateResult {
  readonly outcome: Outcome;
  readonly reason: ReasonCode;
  readonly verdict: string;
  readonly orderId?: string;
  readonly status?: string;
  readonly payerActionUrl?: string;
  readonly ownerApproved?: boolean;
  readonly paypalError?: string;
}

export interface GateOptions {
  readonly rules: Rules;
  readonly config: PaypalConfig;
  readonly client: PaypalClient;
  readonly clock: () => number;
  /** Asked for every NEEDS_OWNER_OK decision. The scripted demo owner says no. */
  readonly ownerOk: (intent: PaymentIntent, decision: Decision) => Promise<boolean>;
}

function fromDecision(d: Pick<Decision, 'outcome' | 'reason' | 'verdict'>): GateResult {
  return { outcome: d.outcome, reason: d.reason, verdict: d.verdict };
}
/** PayPal order ids are short upper-case alphanumerics (17 chars today). */
const ORDER_ID = /^[A-Z0-9]{8,36}$/;
const errorCode = (e: unknown): string => (e instanceof PaypalApiError ? e.code : 'PAYPAL_CALL_FAILED');
const orderFields = (o: PaypalOrder): Partial<GateResult> => ({
  orderId: o.id,
  status: o.status,
  ...(o.payerActionUrl === undefined ? {} : { payerActionUrl: o.payerActionUrl }),
});

export class PaypalGate {
  readonly #o: GateOptions;
  #state: State;
  readonly #orders = new Map<string, { intent: PaymentIntent; capture?: GateResult }>();
  /** Every decision, in order (the hash-chained receipt log replaces this in P3). */
  readonly log: { readonly tool: string; readonly result: GateResult }[] = [];

  constructor(opts: GateOptions) {
    this.#o = opts;
    this.#state = emptyState(opts.clock());
  }

  get spentToday(): bigint {
    return rollDay(this.#state, this.#o.clock()).spentToday;
  }

  /** Guardian or owner. Not reachable through call(). */
  pause(by: Actor): void {
    this.#state = pause(this.#state, by);
  }

  /** Owner only. Not reachable through call(). */
  unpause(by: Actor): boolean {
    const r = unpause(this.#state, by);
    if (r.ok) this.#state = r.state;
    return r.ok;
  }

  /**
   * Owner only, not reachable through call(). After a restart, re-attach a sandbox order that an earlier gate run
   * created, so pay_order can capture it. `createArgs` are the create_order args the owner expects (same amount,
   * same payee rules). The intent must still be ALLOWED under these rules; then pay_order re-checks on PayPal
   * (APPROVED, pinned payee, this amount) before any capture. Makes no PayPal call itself.
   */
  adoptOrder(orderId: string, createArgs: unknown): GateResult {
    if (!ORDER_ID.test(orderId)) return blocked('REQUIREMENTS_UNREADABLE');
    const now = this.#o.clock();
    const n = normalise('create_order', createArgs, this.#o.config, now);
    if (n.kind !== 'payment') return blocked('REQUIREMENTS_UNREADABLE');
    const ok = fromDecision({ outcome: 'ALLOWED', reason: 'OK', verdict: decode('OK') });
    if (this.#orders.has(orderId)) return { ...ok, orderId };
    const d = decide(n.intent, this.#o.rules, this.#state, now);
    if (d.outcome !== 'ALLOWED') return fromDecision(d);
    this.#state = recordPayment(this.#state, n.intent, now);
    this.#orders.set(orderId, { intent: n.intent });
    const result = { ...fromDecision(d), orderId };
    this.log.push({ tool: 'adopt_order (owner)', result });
    return result;
  }

  /** The agent's only entry point. */
  async call(tool: string, args: unknown): Promise<GateResult> {
    const result = await this.#handle(tool, args);
    this.log.push({ tool, result });
    return result;
  }

  async #handle(tool: string, args: unknown): Promise<GateResult> {
    const now = this.#o.clock();
    const n = normalise(tool, args, this.#o.config, now);
    switch (n.kind) {
      case 'payment':
        return this.#pay(n.intent, n.toolkitArgs, now);
      case 'capture':
        return this.#gateCheck(tool, now) ?? this.#capture(n.orderId);
      case 'read':
        return this.#gateCheck(tool, now, true) ?? this.#read(n.toolkitArgs['id'] as string);
      case 'unreadable':
        return blocked('REQUIREMENTS_UNREADABLE');
      case 'unsupported':
        return this.#gateCheck(tool, now) ?? blocked('REQUIREMENTS_UNREADABLE');
    }
  }

  /** Pause, expiry and the action allowlist for calls that are not priced payments (reads skip pause). */
  #gateCheck(tool: string, now: number, readOnly = false): GateResult | undefined {
    if (!readOnly && this.#state.paused) return blocked('PAUSED');
    if (now >= this.#o.rules.expiresAt) return blocked('RULES_EXPIRED');
    if (!this.#o.rules.actions.includes(tool)) return blocked('ACTION_NOT_ALLOWED');
    return undefined;
  }

  async #pay(intent: PaymentIntent, toolkitArgs: Record<string, unknown>, now: number): Promise<GateResult> {
    let d = decide(intent, this.#o.rules, this.#state, now);
    let approved = false;
    if (d.outcome === 'NEEDS_OWNER_OK') {
      if (!(await this.#o.ownerOk(intent, d))) return fromDecision(d);
      d = decide(intent, this.#o.rules, this.#state, now, { ownerApproved: true });
      approved = true; // same state and clock: only the needs-OK step changes, blocks were already passed
    }
    if (d.outcome !== 'ALLOWED') return fromDecision(d);
    const base = { ...fromDecision(d), ...(approved ? { ownerApproved: true } : {}) };
    let order: PaypalOrder;
    try {
      order = await this.#o.client.createOrder(toolkitArgs);
    } catch (e) {
      return { ...base, paypalError: errorCode(e) };
    }
    this.#state = recordPayment(this.#state, intent, now);
    this.#orders.set(order.id, { intent });
    return { ...base, ...orderFields(order) };
  }

  async #capture(orderId: string): Promise<GateResult> {
    const rec = this.#orders.get(orderId);
    if (!rec) return blocked('REQUIREMENTS_UNREADABLE');
    if (rec.capture) return rec.capture; // idempotent per order id: no second PayPal call
    const ok = fromDecision({ outcome: 'ALLOWED', reason: 'OK', verdict: decode('OK') });
    // Re-check on PayPal's side first. A failed pre-check is not cached: the buyer may approve later.
    let current: PaypalOrder;
    try {
      current = await this.#o.client.getOrder(orderId);
    } catch (e) {
      return { ...ok, orderId, paypalError: errorCode(e) };
    }
    if (current.status !== 'APPROVED') {
      return { ...ok, orderId, status: current.status, paypalError: 'ORDER_NOT_APPROVED' };
    }
    const { intent } = rec;
    if (current.payeeMerchantId === undefined || current.payeeMerchantId !== intent.payTo) {
      return { ...blocked('PAYTO_MISMATCH'), orderId };
    }
    if (current.amount?.currency !== intent.asset || current.amount.minor !== intent.amount) {
      return { ...blocked('REQUIREMENTS_UNREADABLE'), orderId };
    }
    try {
      const o = await this.#o.client.captureOrder(orderId);
      rec.capture = { ...ok, ...orderFields(o) };
      return rec.capture;
    } catch (e) {
      return { ...ok, orderId, paypalError: errorCode(e) };
    }
  }

  async #read(id: string): Promise<GateResult> {
    const ok = fromDecision({ outcome: 'ALLOWED', reason: 'OK', verdict: decode('OK') });
    try {
      return { ...ok, ...orderFields(await this.#o.client.getOrder(id)) };
    } catch (e) {
      return { ...ok, orderId: id, paypalError: errorCode(e) };
    }
  }
}

function blocked(reason: ReasonCode): GateResult {
  return { outcome: 'BLOCKED', reason, verdict: decode(reason) };
}
