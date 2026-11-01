// Tests for the PayPal adapter (docs/DECISIONS.md D-004, D-016).
// Merchant ids and emails are obviously fake test values.
import { decide, emptyState, type Rules } from '@claw-pay/core';
import { describe, expect, it } from 'vitest';

import {
  LIVE_HOSTS,
  SANDBOX_HOSTS,
  TOOL_ACTIONS,
  assertAllowedHost,
  assertSandboxEnv,
  formatMinor,
  normalise,
  toMinorUnits,
  toolkitConfiguration,
  type PaypalConfig,
} from '../src/index.js';

const NOW = Date.UTC(2026, 10, 4, 12);
const PIN = 'SELLERAMERCHANT01';
const config: PaypalConfig = {
  network: 'paypal:sandbox',
  sellers: [{ id: 'seller-a', merchantId: PIN, email: 'seller-a@business.example.com' }],
  pinnedSellerId: 'seller-a',
};
const rules: Rules = {
  version: 1,
  sellers: [{ origin: 'paypal:seller-a', payTo: PIN, perCallCap: 500n, dailyCap: 1000n }],
  perCallCap: 500n,
  dailyCap: 2000n,
  maxPaymentsPerDay: 20,
  networks: ['paypal:sandbox'],
  assets: [{ network: 'paypal:sandbox', asset: 'USD' }],
  confirmThreshold: 400n,
  quoteDriftBps: 0,
  expiresAt: NOW + 7 * 86_400_000,
  actions: ['create_order', 'pay_order', 'get_order'],
};
const item = (cost: number, extra: Record<string, unknown> = {}) => ({
  name: 'API credits',
  quantity: 1,
  itemCost: cost,
  taxPercent: 0,
  itemTotal: cost,
  ...extra,
});
const order = (extra: Record<string, unknown> = {}) => ({ currencyCode: 'USD', items: [item(2)], ...extra });
const decideFor = (args: unknown) => {
  const r = normalise('create_order', args, config, NOW);
  if (r.kind !== 'payment') throw new Error(`expected payment, got ${r.kind}`);
  return decide(r.intent, rules, emptyState(NOW), NOW).reason;
};

describe('toMinorUnits / formatMinor', () => {
  it.each<[number | string, bigint]>([
    [2, 200n],
    [2.5, 250n],
    [0.1, 10n],
    [4.5, 450n],
    [0, 0n],
    ['2.00', 200n],
    ['0.01', 1n],
    ['10', 1000n],
  ])('%s → %s', (v, minor) => {
    expect(toMinorUnits(v)).toBe(minor);
  });

  it.each<[number | string]>([
    [2.005],
    [-1],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [1e21],
    [1e-7],
    ['2.'],
    ['.5'],
    ['-2'],
    ['2.001'],
    ['1e3'],
    [''],
    [' 2'],
  ])('rejects %s', (v) => {
    expect(toMinorUnits(v)).toBeUndefined();
  });

  it.each<[unknown]>([[null], [2n], [{}]])('rejects a non-number, non-string %s', (v) => {
    expect(toMinorUnits(v)).toBeUndefined();
  });

  it('formats minor units back to a 2-decimal string', () => {
    expect(formatMinor(200n)).toBe('2.00');
    expect(formatMinor(5n)).toBe('0.05');
    expect(formatMinor(123456n)).toBe('1234.56');
  });
});

describe('sandbox guard (hard rule)', () => {
  it('accepts only PAYPAL_ENVIRONMENT=SANDBOX exactly', () => {
    expect(() => {
      assertSandboxEnv({ PAYPAL_ENVIRONMENT: 'SANDBOX' });
    }).not.toThrow();
    for (const v of ['PRODUCTION', 'production', 'sandbox', '', undefined]) {
      expect(() => {
        assertSandboxEnv({ PAYPAL_ENVIRONMENT: v });
      }).toThrow('ERR_PRODUCTION_REFUSED');
    }
  });

  it('allows only the two sandbox API hosts over https', () => {
    expect([...SANDBOX_HOSTS]).toEqual(['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com']);
    for (const h of SANDBOX_HOSTS) {
      expect(() => {
        assertAllowedHost(`https://${h}/v2/checkout/orders`);
      }).not.toThrow();
    }
  });

  it.each([
    ...LIVE_HOSTS.map((h) => `https://${h}/v2/checkout/orders`),
    'http://api-m.sandbox.paypal.com/v2/checkout/orders',
    'https://api-m.sandbox.paypal.com.evil.test/',
    'https://mcp.sandbox.paypal.com/sse',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => {
      assertAllowedHost(url);
    }).toThrow('ERR_HOST_REFUSED');
  });

  it('refuses all three live hosts by name', () => {
    expect([...LIVE_HOSTS]).toEqual(['api-m.paypal.com', 'api.paypal.com', 'mcp.paypal.com']);
  });

  it('toolkit configuration always sets context.sandbox = true and never a global request_id', () => {
    const c = toolkitConfiguration(['create_order', 'get_order', 'pay_order']);
    expect(c.context).toEqual({ sandbox: true });
    expect('request_id' in c.context).toBe(false);
    expect(c.actions).toEqual({ orders: { create: true, get: true, capture: true } });
  });

  it('maps tool names to the toolkit action keys from the shipped code', () => {
    expect(TOOL_ACTIONS).toMatchObject({
      create_order: ['orders', 'create'],
      get_order: ['orders', 'get'],
      pay_order: ['orders', 'capture'],
      create_refund: ['payments', 'createRefund'],
      create_subscription: ['subscriptions', 'create'],
    });
    expect(() => toolkitConfiguration(['no_such_tool'])).toThrow('ERR_UNKNOWN_TOOL');
  });
});

describe('normalise(create_order)', () => {
  it('builds a USD payment intent for the pinned seller and strips nothing it does not own', () => {
    const r = normalise('create_order', order(), config, NOW);
    expect(r).toMatchObject({
      kind: 'payment',
      intent: {
        sellerOrigin: 'paypal:seller-a',
        payTo: PIN,
        network: 'paypal:sandbox',
        asset: 'USD',
        amount: 200n,
        action: 'create_order',
      },
      toolkitArgs: order(),
    });
  });

  it.each([
    ['merchant id of the pinned seller', { merchant_id: PIN }],
    ['email of the pinned seller', { email_address: 'seller-a@business.example.com' }],
  ])('accepts payee = %s and strips it before the toolkit call', (_n, payee) => {
    const r = normalise('create_order', order({ payee }), config, NOW);
    expect(r.kind).toBe('payment');
    if (r.kind === 'payment') {
      expect(r.toolkitArgs).not.toHaveProperty('payee');
      expect(decide(r.intent, rules, emptyState(NOW), NOW).reason).toBe('OK');
    }
  });

  it('row 4: an unlisted payee → SELLER_NOT_LISTED in the core', () => {
    expect(decideFor(order({ payee: { merchant_id: 'UNLISTEDMERCHANT9' } }))).toBe('SELLER_NOT_LISTED');
  });

  it("row 7: seller-a's email with a swapped merchant id → PAYTO_MISMATCH in the core", () => {
    const payee = { email_address: 'seller-a@business.example.com', merchant_id: 'ATTACKERMERCHANT1' };
    expect(decideFor(order({ payee }))).toBe('PAYTO_MISMATCH');
  });

  it('an unlisted payee given only by email → SELLER_NOT_LISTED', () => {
    expect(decideFor(order({ payee: { email_address: 'someone@else.example.com' } }))).toBe(
      'SELLER_NOT_LISTED',
    );
  });

  it('a listed seller who is not the pinned account → PAYTO_MISMATCH (the toolkit would pay the pin)', () => {
    const two: PaypalConfig = {
      ...config,
      sellers: [...config.sellers, { id: 'seller-b', merchantId: 'SELLERBMERCHANT01' }],
    };
    const r = normalise('create_order', order({ payee: { merchant_id: 'SELLERBMERCHANT01' } }), two, NOW);
    const rulesB = {
      ...rules,
      sellers: [...rules.sellers, { origin: 'paypal:seller-b', payTo: 'SELLERBMERCHANT01' }],
    };
    expect(r.kind === 'payment' && decide(r.intent, rulesB, emptyState(NOW), NOW).reason).toBe(
      'PAYTO_MISMATCH',
    );
  });

  it('row 6: EUR reaches the core as the asset and is ASSET_NOT_ALLOWED', () => {
    expect(decideFor(order({ currencyCode: 'EUR' }))).toBe('ASSET_NOT_ALLOWED');
  });

  it('row 5 and row 8: 6.00 is above the call cap, 4.50 needs the owner', () => {
    expect(decideFor(order({ items: [item(6)] }))).toBe('ABOVE_CALL_CAP');
    expect(decideFor(order({ items: [item(4.5)] }))).toBe('NEEDS_OWNER_OK');
  });

  it('totals quantity, tax, shipping and discount exactly in minor units', () => {
    const args = order({
      items: [item(1.5, { quantity: 2, itemTotal: 3, taxPercent: 10 })],
      shippingCost: 1,
      discount: 0.5,
    });
    const r = normalise('create_order', args, config, NOW);
    expect(r.kind === 'payment' && r.intent.amount).toBe(380n); // 3.00 + 0.30 + 1.00 - 0.50
  });

  it('defaults quantity to 1', () => {
    const r = normalise(
      'create_order',
      order({ items: [{ name: 'x', itemCost: 2, itemTotal: 2 }] }),
      config,
      NOW,
    );
    expect(r.kind === 'payment' && r.intent.amount).toBe(200n);
  });

  it.each<[string, unknown]>([
    ['unknown top-level field', order({ memo: 'x' })],
    ['unknown item field', order({ items: [item(2, { sku: 'x' })] })],
    ['unknown payee field', order({ payee: { merchant_id: PIN, note: 'x' } })],
    ['empty payee object', order({ payee: {} })],
    ['more than 2 decimals', order({ items: [item(2.005)] })],
    ['negative item cost', order({ items: [item(-2)] })],
    ['itemTotal does not match cost x quantity', order({ items: [item(2, { itemTotal: 0.02 })] })],
    ['non-integer quantity', order({ items: [item(2, { quantity: 1.5, itemTotal: 3 })] })],
    ['tax that creates a fraction of a cent', order({ items: [item(0.05, { taxPercent: 10 })] })],
    ['discount larger than the total', order({ discount: 3 })],
    ['shipping with 3 decimals', order({ shippingCost: 1.001 })],
    ['discount with 3 decimals', order({ discount: 0.001 })],
    ['tax percent with 3 decimals', order({ items: [item(2, { taxPercent: 1.001 })] })],
    ['no items', order({ items: [] })],
    ['51 items', order({ items: Array.from({ length: 51 }, () => item(0.01)) })],
    ['lower-case currency', order({ currencyCode: 'usd' })],
    ['args not an object', 'create an order for $2'],
    ['args null', null],
    ['args array', [order()]],
  ])('%s → unreadable', (_n, args) => {
    expect(normalise('create_order', args, config, NOW)).toEqual({ kind: 'unreadable' });
  });
});

describe('normalise(other tools)', () => {
  it('pay_order with a valid order id → capture request', () => {
    expect(normalise('pay_order', { id: '5O190127TN364715T' }, config, NOW)).toEqual({
      kind: 'capture',
      orderId: '5O190127TN364715T',
    });
  });

  it('get_order → read-only', () => {
    expect(normalise('get_order', { id: '5O190127TN364715T' }, config, NOW)).toEqual({
      kind: 'read',
      action: 'get_order',
      toolkitArgs: { id: '5O190127TN364715T' },
    });
  });

  it.each<[string, unknown]>([
    ['pay_order', { id: 'not-an-order-id' }],
    ['pay_order', { id: '5O190127TN364715T', amount: 1 }],
    ['get_order', {}],
  ])('%s with %j → unreadable', (tool, args) => {
    expect(normalise(tool, args, config, NOW)).toEqual({ kind: 'unreadable' });
  });

  it('tools without a gate schema are unsupported (the gate decides ACTION_NOT_ALLOWED or unreadable)', () => {
    expect(normalise('create_subscription', {}, config, NOW)).toEqual({
      kind: 'unsupported',
      action: 'create_subscription',
    });
    expect(normalise('create_refund', { capture_id: 'X' }, config, NOW)).toEqual({
      kind: 'unsupported',
      action: 'create_refund',
    });
  });

  it('rejects a config whose pinned seller is missing', () => {
    expect(() => normalise('create_order', order(), { ...config, pinnedSellerId: 'nobody' }, NOW)).toThrow(
      'ERR_CONFIG',
    );
  });
});
