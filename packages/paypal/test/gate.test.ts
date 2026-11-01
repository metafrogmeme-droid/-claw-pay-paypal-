// Tests for the in-process PayPal gate and the mock PayPal client (P2/P3).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MockPaypal, PaypalGate, loadPaypalRules, type PaypalRulesFile } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 4, 12);
const file = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../demo/paypal/rules.json'), 'utf8'),
) as PaypalRulesFile;
const order = (cost: number, extra: Record<string, unknown> = {}) => ({
  currencyCode: 'USD',
  items: [{ name: 'API credits', quantity: 1, itemCost: cost, taxPercent: 0, itemTotal: cost }],
  ...extra,
});
function setup(ownerSays = false, over: Partial<PaypalRulesFile> = {}) {
  const mock = new MockPaypal();
  const { rules, config } = loadPaypalRules({ ...file, ...over }, NOW);
  const gate = new PaypalGate({
    rules,
    config,
    client: mock,
    clock: () => NOW,
    ownerOk: () => Promise.resolve(ownerSays),
  });
  return { mock, gate };
}

describe('loadPaypalRules', () => {
  it('turns decimal strings into minor units and pins the seller', () => {
    const { rules, config } = loadPaypalRules(file, NOW);
    expect(rules).toMatchObject({
      perCallCap: 500n,
      dailyCap: 2000n,
      confirmThreshold: 400n,
      maxPaymentsPerDay: 20,
    });
    expect(rules.sellers).toEqual([
      { origin: 'paypal:seller-a', payTo: 'SELLERAMERCHANT01', perCallCap: 500n, dailyCap: 1100n },
    ]);
    expect(rules.expiresAt).toBe(NOW + 7 * 86_400_000);
    expect(config.pinnedSellerId).toBe('seller-a');
  });

  it.each<[string, Partial<PaypalRulesFile> & Record<string, unknown>]>([
    ['a float amount', { perCallCap: '5.001' }],
    ['an unknown key', { surprise: true }],
    ['a pinned seller that is not listed', { pinnedSeller: 'nobody' }],
    ['a non-sandbox rail', { rail: 'paypal:live' as 'paypal:sandbox' }],
    ['an unknown allowed tool', { allowedActions: ['send_money'] as never }],
  ])('refuses %s with ERR_RULES', (_n, over) => {
    expect(() => loadPaypalRules({ ...file, ...over }, NOW)).toThrow('ERR_RULES');
  });
});

describe('loadPaypalRules optional fields', () => {
  it('accepts a seller without email or daily cap', () => {
    const { rules, config } = loadPaypalRules(
      { ...file, sellers: [{ id: 'seller-a', merchantId: 'M1', maxAmount: '5.00' }] },
      NOW,
    );
    expect(rules.sellers).toEqual([{ origin: 'paypal:seller-a', payTo: 'M1', perCallCap: 500n }]);
    expect(config.sellers).toEqual([{ id: 'seller-a', merchantId: 'M1' }]);
  });
});

describe('MockPaypal', () => {
  it('approve() only moves an order that waits for the buyer; unknown orders are not found', async () => {
    const m = new MockPaypal();
    const o = await m.createOrder({});
    m.approve(o.id);
    m.approve(o.id); // second click is a no-op
    expect((await m.getOrder(o.id)).status).toBe('APPROVED');
    await expect(m.getOrder('NOSUCHORDER000000')).rejects.toThrow('RESOURCE_NOT_FOUND');
  });
});

describe('PaypalGate', () => {
  it('allowed create_order makes exactly one PayPal call, without the payee', async () => {
    const { mock, gate } = setup();
    const r = await gate.call('create_order', order(2, { payee: { merchant_id: 'SELLERAMERCHANT01' } }));
    expect(r).toMatchObject({
      outcome: 'ALLOWED',
      verdict: 'Allowed: within your limits',
      status: 'PAYER_ACTION_REQUIRED',
    });
    expect(r.orderId).toMatch(/^[A-Z0-9]{17,32}$/);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.args).not.toHaveProperty('payee');
  });

  it.each<[string, string, unknown]>([
    ['SELLER_NOT_LISTED', 'create_order', order(2, { payee: { merchant_id: 'UNLISTEDMERCHANT9' } })],
    ['ABOVE_CALL_CAP', 'create_order', order(6)],
    ['ASSET_NOT_ALLOWED', 'create_order', order(2, { currencyCode: 'EUR' })],
    ['REQUIREMENTS_UNREADABLE', 'create_order', order(2, { memo: 'x' })],
    ['ACTION_NOT_ALLOWED', 'create_subscription', { plan_id: 'P-1' }],
    ['ACTION_NOT_ALLOWED', 'update_rules', {}],
    ['REQUIREMENTS_UNREADABLE', 'pay_order', { id: 'UNKNOWNORDERID000' }],
  ])('blocked %s makes zero PayPal calls', async (reason, tool, args) => {
    const { mock, gate } = setup();
    const r = await gate.call(tool, args);
    expect(r).toMatchObject({ outcome: 'BLOCKED', reason });
    expect(r.verdict.startsWith('Blocked by your rule: ')).toBe(true);
    expect(mock.calls).toHaveLength(0);
  });

  it('an allowed tool with no gate schema is unreadable, not passed through', async () => {
    const { mock, gate } = setup(false, { allowedActions: ['create_order', 'create_refund'] });
    expect((await gate.call('create_refund', { capture_id: 'X' })).reason).toBe('REQUIREMENTS_UNREADABLE');
    expect(mock.calls).toHaveLength(0);
  });

  it('needs-your-OK: the owner says no → nothing is sent; yes → one call', async () => {
    const no = setup(false);
    expect(await no.gate.call('create_order', order(4.5))).toMatchObject({
      outcome: 'NEEDS_OWNER_OK',
      reason: 'NEEDS_OWNER_OK',
    });
    expect(no.mock.calls).toHaveLength(0);
    const yes = setup(true);
    expect(await yes.gate.call('create_order', order(4.5))).toMatchObject({
      outcome: 'ALLOWED',
      ownerApproved: true,
    });
    expect(yes.mock.calls).toHaveLength(1);
  });

  it('pause: guardian pauses, only the owner unpauses', async () => {
    const { mock, gate } = setup();
    gate.pause('guardian');
    expect((await gate.call('create_order', order(2))).reason).toBe('PAUSED');
    expect((await gate.call('create_subscription', {})).reason).toBe('PAUSED');
    expect(gate.unpause('guardian')).toBe(false);
    expect(gate.unpause('owner')).toBe(true);
    expect((await gate.call('create_order', order(2))).outcome).toBe('ALLOWED');
    expect(mock.calls).toHaveLength(1);
  });

  it('get_order is read-only: allowed and logged without spend checks', async () => {
    const { mock, gate } = setup();
    const created = await gate.call('create_order', order(2));
    const r = await gate.call('get_order', { id: created.orderId });
    expect(r).toMatchObject({ outcome: 'ALLOWED', status: 'PAYER_ACTION_REQUIRED' });
    expect(mock.calls.map((c) => c.method)).toEqual(['createOrder', 'getOrder']);
  });

  it('pay_order captures only gate-created orders, once (idempotent per order id)', async () => {
    const { mock, gate } = setup();
    const created = await gate.call('create_order', order(2));
    const id = created.orderId ?? '';
    mock.approve(id);
    const first = await gate.call('pay_order', { id });
    expect(first).toMatchObject({ outcome: 'ALLOWED', status: 'COMPLETED', orderId: id });
    const again = await gate.call('pay_order', { id });
    expect(again).toEqual(first);
    expect(mock.calls.filter((c) => c.method === 'captureOrder')).toHaveLength(1);
  });

  it('get_order for an unknown order reports the PayPal error', async () => {
    const { gate } = setup();
    expect(await gate.call('get_order', { id: 'NOSUCHORDER000000' })).toMatchObject({
      outcome: 'ALLOWED',
      paypalError: 'RESOURCE_NOT_FOUND',
    });
  });

  it('expired rules block every tool', async () => {
    const mock = new MockPaypal();
    const { rules, config } = loadPaypalRules(file, NOW);
    const gate = new PaypalGate({
      rules,
      config,
      client: mock,
      clock: () => rules.expiresAt,
      ownerOk: () => Promise.resolve(true),
    });
    expect((await gate.call('get_order', { id: 'NOSUCHORDER000000' })).reason).toBe('RULES_EXPIRED');
    expect((await gate.call('create_order', order(2))).reason).toBe('RULES_EXPIRED');
    expect(mock.calls).toHaveLength(0);
  });

  it('a non-PayPal failure is reported as PAYPAL_CALL_FAILED and not retried', async () => {
    const { rules, config } = loadPaypalRules(file, NOW);
    let calls = 0;
    const client = {
      createOrder: () => {
        calls++;
        return Promise.reject(new Error('socket hang up'));
      },
      getOrder: () => Promise.reject(new Error('x')),
      captureOrder: () => Promise.reject(new Error('x')),
    };
    const gate = new PaypalGate({
      rules,
      config,
      client,
      clock: () => NOW,
      ownerOk: () => Promise.resolve(false),
    });
    expect(await gate.call('create_order', order(2))).toMatchObject({ paypalError: 'PAYPAL_CALL_FAILED' });
    expect(calls).toBe(1);
  });

  it('a PayPal error is reported once and never retried; no spend is recorded', async () => {
    const { mock, gate } = setup();
    const created = await gate.call('create_order', order(2));
    const r = await gate.call('pay_order', { id: created.orderId }); // buyer has not approved
    expect(r).toMatchObject({ outcome: 'ALLOWED', paypalError: 'ORDER_NOT_APPROVED' });
    // The get_order re-check catches it, so the capture is never sent (gate-capture.test.ts).
    expect(mock.calls.filter((c) => c.method === 'captureOrder')).toHaveLength(0);
    mock.failNext('INTERNAL_SERVER_ERROR');
    const failed = await gate.call('create_order', order(2));
    expect(failed).toMatchObject({ outcome: 'ALLOWED', paypalError: 'INTERNAL_SERVER_ERROR' });
    expect(gate.spentToday).toBe(200n); // only the first order counts
  });
});
