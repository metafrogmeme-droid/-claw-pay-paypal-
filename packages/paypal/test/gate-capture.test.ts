// The get_order re-check before every capture: APPROVED, the pinned payee and the decided amount, or no capture.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MockPaypal,
  PaypalApiError,
  PaypalGate,
  loadPaypalRules,
  type PaypalClient,
  type PaypalOrder,
  type PaypalRulesFile,
} from '../src/index.js';

const NOW = Date.UTC(2026, 10, 4, 12);
const file = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../demo/paypal/rules.json'), 'utf8'),
) as PaypalRulesFile;
const order = (cost: number) => ({
  currencyCode: 'USD',
  items: [{ name: 'API credits', quantity: 1, itemCost: cost, taxPercent: 0, itemTotal: cost }],
});

/** Wraps the mock so a test can rewrite what get_order reports or fail the capture itself. */
class Twisted implements PaypalClient {
  readonly inner: MockPaypal;
  reported: ((o: PaypalOrder) => PaypalOrder) | undefined;
  captureFails: string | undefined;
  constructor(inner = new MockPaypal()) {
    this.inner = inner;
  }
  createOrder(args: Readonly<Record<string, unknown>>) {
    return this.inner.createOrder(args);
  }
  async getOrder(id: string) {
    const o = await this.inner.getOrder(id);
    return this.reported ? this.reported(o) : o;
  }
  captureOrder(id: string) {
    if (this.captureFails !== undefined) {
      this.inner.calls.push({ method: 'captureOrder', args: { id } });
      return Promise.reject(new PaypalApiError(this.captureFails));
    }
    return this.inner.captureOrder(id);
  }
}

function setup() {
  const client = new Twisted();
  const { rules, config } = loadPaypalRules(file, NOW);
  const gate = new PaypalGate({
    rules,
    config,
    client,
    clock: () => NOW,
    ownerOk: () => Promise.resolve(false),
  });
  return { client, mock: client.inner, gate };
}
const methods = (m: MockPaypal) => m.calls.map((c) => c.method);

describe('pay_order re-checks the order with get_order before capturing', () => {
  it('APPROVED, pinned payee and same amount → one get_order, then one capture', async () => {
    const { mock, gate } = setup();
    const { orderId: id = '' } = await gate.call('create_order', order(2));
    mock.approve(id);
    const r = await gate.call('pay_order', { id });
    expect(r).toMatchObject({ outcome: 'ALLOWED', status: 'COMPLETED', orderId: id });
    expect(methods(mock)).toEqual(['createOrder', 'getOrder', 'captureOrder']);
  });

  it('before the buyer approves: ORDER_NOT_APPROVED, zero capture calls, and a later try still works', async () => {
    const { mock, gate } = setup();
    const { orderId: id = '' } = await gate.call('create_order', order(2));
    const early = await gate.call('pay_order', { id });
    expect(early).toMatchObject({
      outcome: 'ALLOWED',
      status: 'PAYER_ACTION_REQUIRED',
      paypalError: 'ORDER_NOT_APPROVED',
    });
    expect(methods(mock)).toEqual(['createOrder', 'getOrder']);
    mock.approve(id);
    expect(await gate.call('pay_order', { id })).toMatchObject({ status: 'COMPLETED' });
  });

  it('a different payee on PayPal’s side → Blocked by your rule: PAYTO_MISMATCH, no capture', async () => {
    const { mock, gate } = setup();
    const { orderId: id = '' } = await gate.call('create_order', order(2));
    mock.approve(id);
    mock.setPayee(id, 'ATTACKERMERCHANT1');
    const r = await gate.call('pay_order', { id });
    expect(r).toMatchObject({ outcome: 'BLOCKED', reason: 'PAYTO_MISMATCH', orderId: id });
    expect(r.verdict).toMatch(/^Blocked by your rule: /);
    expect(methods(mock)).not.toContain('captureOrder');
  });

  it('no payee in the get_order reply → PAYTO_MISMATCH (fails closed), no capture', async () => {
    const { mock, gate } = setup();
    const { orderId: id = '' } = await gate.call('create_order', order(2));
    mock.approve(id);
    mock.setPayee(id, undefined);
    expect(await gate.call('pay_order', { id })).toMatchObject({ reason: 'PAYTO_MISMATCH' });
    expect(methods(mock)).not.toContain('captureOrder');
  });

  it.each<[string, PaypalOrder['amount']]>([
    ['a higher amount', { currency: 'USD', minor: 201n }],
    ['another currency', { currency: 'EUR', minor: 200n }],
    ['no amount', undefined],
  ])('%s on PayPal’s side → REQUIREMENTS_UNREADABLE, no capture', async (_n, amount) => {
    const { client, mock, gate } = setup();
    const { orderId: id = '' } = await gate.call('create_order', order(2));
    mock.approve(id);
    client.reported = (o) => {
      const { amount: _drop, ...rest } = o;
      return amount === undefined ? rest : { ...rest, amount };
    };
    expect(await gate.call('pay_order', { id })).toMatchObject({
      outcome: 'BLOCKED',
      reason: 'REQUIREMENTS_UNREADABLE',
    });
    expect(methods(mock)).not.toContain('captureOrder');
  });

  it('get_order fails → the error is reported, no capture', async () => {
    const { mock, gate } = setup();
    const { orderId: id = '' } = await gate.call('create_order', order(2));
    mock.failNext('INTERNAL_SERVER_ERROR');
    expect(await gate.call('pay_order', { id })).toMatchObject({ paypalError: 'INTERNAL_SERVER_ERROR' });
    expect(methods(mock)).toEqual(['createOrder', 'getOrder']);
  });

  it('PayPal still answers 422 ORDER_NOT_APPROVED on capture → reported once, not cached', async () => {
    const { client, mock, gate } = setup();
    const { orderId: id = '' } = await gate.call('create_order', order(2));
    mock.approve(id);
    client.captureFails = 'ORDER_NOT_APPROVED';
    expect(await gate.call('pay_order', { id })).toMatchObject({ paypalError: 'ORDER_NOT_APPROVED' });
    client.captureFails = undefined;
    expect(await gate.call('pay_order', { id })).toMatchObject({ status: 'COMPLETED' });
    expect(methods(mock).filter((m) => m === 'captureOrder')).toHaveLength(2);
  });

  it('pause blocks pay_order with zero PayPal calls, even for an approved order', async () => {
    const { mock, gate } = setup();
    const { orderId: id = '' } = await gate.call('create_order', order(2));
    mock.approve(id);
    gate.pause('guardian');
    const before = mock.calls.length;
    expect(await gate.call('pay_order', { id })).toMatchObject({ reason: 'PAUSED' });
    expect(mock.calls.length).toBe(before);
  });
});

describe('MockPaypal reports payee and amount on get_order', () => {
  it('uses the constructor payee and the exact order total', async () => {
    const m = new MockPaypal('PAYEE00000000001');
    const o = await m.createOrder(order(4.5));
    expect(await m.getOrder(o.id)).toMatchObject({
      payeeMerchantId: 'PAYEE00000000001',
      amount: { currency: 'USD', minor: 450n },
    });
  });

  it('reports no amount for args the sandbox client would refuse; setPayee ignores unknown ids', async () => {
    const m = new MockPaypal();
    const o = await m.createOrder({ currencyCode: 'EUR', items: [] });
    m.setPayee('NOSUCHORDER', 'X');
    const got = await m.getOrder(o.id);
    expect(got.amount).toBeUndefined();
    expect(got.payeeMerchantId).toBe('SELLERAMERCHANT01');
  });
});
