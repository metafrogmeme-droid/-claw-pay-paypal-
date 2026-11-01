// Tests for the PayPal sandbox REST client. Recorded, scrubbed fixtures only: no network, no real ids.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  PaypalApiError,
  PaypalGuardError,
  SandboxPaypalClient,
  ordersV2Body,
  sandboxClientFromEnv,
} from '../src/index.js';
import { TOKEN, fakeFetch, fixture } from './fake-fetch.js';

const ID = 'test-client-id-not-real';
const SECRET = 'test-client-secret-not-real';
const ORDER = 'FAKEORDER00000001';
const args = {
  currencyCode: 'USD',
  items: [{ name: 'API credits', quantity: 1, itemCost: 2, taxPercent: 0, itemTotal: 2 }],
};
const mk = (replies: { status: number; body: unknown }[]) => {
  const f = fakeFetch(replies);
  return { ...f, client: new SandboxPaypalClient({ clientId: ID, clientSecret: SECRET, fetch: f.fetch }) };
};

describe('ordersV2Body', () => {
  it('builds exact decimal strings from bigint minor units (no float maths)', () => {
    const body = ordersV2Body({
      currencyCode: 'USD',
      items: [
        { name: 'A', quantity: 3, itemCost: 0.1, taxPercent: 10, itemTotal: 0.3 },
        { name: 'B', itemCost: 0.2, itemTotal: 0.2, description: 'second' },
      ],
      shippingCost: 1.5,
      discount: 0.05,
    });
    expect(body).toEqual({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: '1.98',
            breakdown: {
              item_total: { currency_code: 'USD', value: '0.50' },
              tax_total: { currency_code: 'USD', value: '0.03' },
              shipping: { currency_code: 'USD', value: '1.50' },
              discount: { currency_code: 'USD', value: '0.05' },
            },
          },
          items: [
            {
              name: 'A',
              quantity: '3',
              unit_amount: { currency_code: 'USD', value: '0.10' },
              tax: { currency_code: 'USD', value: '0.01' },
            },
            {
              name: 'B',
              quantity: '1',
              unit_amount: { currency_code: 'USD', value: '0.20' },
              description: 'second',
            },
          ],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: 'https://example.com/returnUrl',
            cancel_url: 'https://example.com/cancelUrl',
          },
        },
      },
    });
  });

  it('keeps custom return/cancel URLs, notes and a shipping address', () => {
    const body = ordersV2Body({
      ...args,
      returnUrl: 'https://shop.example/ok',
      cancelUrl: 'https://shop.example/no',
      notes: 'demo order',
      shippingAddress: { address_line_1: '1 Example Street', country_code: 'NL' },
    }) as { purchase_units: Record<string, unknown>[]; payment_source: unknown };
    expect(body.purchase_units[0]).toMatchObject({
      description: 'demo order',
      shipping: { address: { address_line_1: '1 Example Street', country_code: 'NL' } },
    });
    expect(body.payment_source).toEqual({
      paypal: {
        experience_context: { return_url: 'https://shop.example/ok', cancel_url: 'https://shop.example/no' },
      },
    });
  });

  it.each<[string, unknown]>([
    ['EUR (orders are USD only)', { ...args, currencyCode: 'EUR' }],
    ['a payee field (the gate strips it; never sent)', { ...args, payee: { merchant_id: 'X' } }],
    ['three decimals', { ...args, items: [{ name: 'A', itemCost: 2.001, itemTotal: 2.001 }] }],
    ['an itemTotal mismatch', { ...args, items: [{ name: 'A', itemCost: 2, itemTotal: 3 }] }],
    ['a zero total', { ...args, items: [{ name: 'A', itemCost: 0, itemTotal: 0 }] }],
    ['not an object', 'create me an order'],
  ])('refuses %s with REQUIREMENTS_UNREADABLE', (_n, bad) => {
    expect(() => ordersV2Body(bad as Record<string, unknown>)).toThrow('REQUIREMENTS_UNREADABLE');
  });
});

describe('SandboxPaypalClient', () => {
  it('creates an order on the sandbox host and returns the payer-action URL', async () => {
    const { client, calls } = mk([TOKEN, { status: 201, body: fixture('create-order.json') }]);
    const o = await client.createOrder(args);
    expect(o).toEqual({
      id: ORDER,
      status: 'PAYER_ACTION_REQUIRED',
      payerActionUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER}`,
      payeeMerchantId: 'FAKEMERCHANT01',
      amount: { currency: 'USD', minor: 200n },
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api-m.sandbox.paypal.com/v1/oauth2/token',
      'POST https://api-m.sandbox.paypal.com/v2/checkout/orders',
    ]);
    expect(calls[0]?.headers['Authorization']).toBe(
      `Basic ${Buffer.from(`${ID}:${SECRET}`).toString('base64')}`,
    );
    expect(calls[0]?.body).toBe('grant_type=client_credentials');
    expect(calls[1]?.headers['Authorization']).toBe('Bearer fake-access-token-for-tests');
    expect(calls[1]?.headers['Prefer']).toBe('return=representation');
    expect(calls.every((c) => c.redirect === 'error')).toBe(true);
    expect(calls[1]?.headers['PayPal-Request-Id']).toMatch(/^claw-pay-create-[0-9a-f-]{36}$/);
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual(ordersV2Body(args));
  });

  it('uses a fresh idempotency key per create and a fixed one per capture', async () => {
    const { client, calls } = mk([
      TOKEN,
      { status: 201, body: fixture('create-order.json') },
      { status: 201, body: fixture('create-order.json') },
      { status: 201, body: fixture('capture-completed.json') },
    ]);
    await client.createOrder(args);
    await client.createOrder(args);
    await client.captureOrder(ORDER);
    const keys = calls.slice(1).map((c) => c.headers['PayPal-Request-Id']);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(`claw-pay-capture-${ORDER}`);
    expect(calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(1); // token reused
  });

  it('get_order reads status, payee and amount', async () => {
    const { client, calls } = mk([TOKEN, { status: 200, body: fixture('get-order-approved.json') }]);
    expect(await client.getOrder(ORDER)).toEqual({
      id: ORDER,
      status: 'APPROVED',
      payeeMerchantId: 'FAKEMERCHANT01',
      amount: { currency: 'USD', minor: 200n },
    });
    expect(calls[1]).toMatchObject({
      method: 'GET',
      url: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${ORDER}`,
      body: undefined,
    });
  });

  it('capture returns COMPLETED and the capture id', async () => {
    const { client, calls } = mk([TOKEN, { status: 201, body: fixture('capture-completed.json') }]);
    expect(await client.captureOrder(ORDER)).toEqual({
      id: ORDER,
      status: 'COMPLETED',
      captureId: 'FAKECAPTURE000001',
      amount: { currency: 'USD', minor: 200n },
    });
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${ORDER}/capture`,
      body: '{}',
    });
  });

  it('capture before approval surfaces 422 ORDER_NOT_APPROVED as a PaypalApiError', async () => {
    const { client } = mk([TOKEN, { status: 422, body: fixture('capture-not-approved.json') }]);
    const err = await client.captureOrder(ORDER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaypalApiError);
    expect((err as PaypalApiError).code).toBe('ORDER_NOT_APPROVED');
  });

  it.each<[string, { status: number; body: unknown }, string]>([
    [
      'an error name without details',
      { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } },
      'RESOURCE_NOT_FOUND',
    ],
    ['an empty error body', { status: 500, body: '' }, 'HTTP_500'],
    ['a non-JSON error body', { status: 502, body: '<html>bad gateway</html>' }, 'HTTP_502'],
    ['a 200 with an unreadable order', { status: 200, body: { id: 'lower-case-id' } }, 'RESPONSE_UNREADABLE'],
    ['a 200 with non-JSON', { status: 200, body: 'not json' }, 'RESPONSE_UNREADABLE'],
  ])('maps %s to %s', async (_n, reply, code) => {
    const { client } = mk([TOKEN, reply]);
    await expect(client.getOrder(ORDER)).rejects.toMatchObject({ code });
  });

  it('a failed token request is OAUTH_FAILED and never echoes the secret', async () => {
    const { client } = mk([{ status: 401, body: { error: 'invalid_client', error_description: SECRET } }]);
    const err = (await client.getOrder(ORDER).catch((e: unknown) => e)) as PaypalApiError;
    expect(err.code).toBe('OAUTH_FAILED');
    expect(err.message).not.toContain(SECRET);
    const bad = mk([{ status: 200, body: { nope: true } }]);
    await expect(bad.client.getOrder(ORDER)).rejects.toMatchObject({ code: 'OAUTH_FAILED' });
  });

  it('refreshes the token after it expires', async () => {
    let now = 0;
    const f = fakeFetch([
      { status: 200, body: { access_token: 'tok-one-fake', expires_in: 100 } },
      { status: 200, body: fixture('get-order-approved.json') },
      { status: 200, body: { access_token: 'tok-two-fake', expires_in: 100 } },
      { status: 200, body: fixture('get-order-approved.json') },
    ]);
    const client = new SandboxPaypalClient({
      clientId: ID,
      clientSecret: SECRET,
      fetch: f.fetch,
      clock: () => now,
    });
    await client.getOrder(ORDER);
    now = 100_000; // expires_in 100 s, refreshed 60 s early
    await client.getOrder(ORDER);
    expect(f.calls.map((c) => c.headers['Authorization']?.slice(0, 12))).toEqual([
      'Basic dGVzdC',
      'Bearer tok-o',
      'Basic dGVzdC',
      'Bearer tok-t',
    ]);
  });

  it('drops a payer-action link that is not on www.sandbox.paypal.com', async () => {
    const live = structuredClone(fixture('create-order.json')) as { links: { href: string; rel: string }[] };
    live.links[1] = { href: `https://www.paypal.com/checkoutnow?token=${ORDER}`, rel: 'payer-action' };
    const { client } = mk([TOKEN, { status: 201, body: live }]);
    await expect(client.createOrder(args)).rejects.toMatchObject({ code: 'PAYER_ACTION_HOST_REFUSED' });
  });

  it('refuses an order id that does not match the PayPal id pattern, before any call', async () => {
    const { client, calls } = mk([]);
    await expect(client.getOrder('../../v1/oauth2')).rejects.toMatchObject({
      code: 'REQUIREMENTS_UNREADABLE',
    });
    await expect(client.captureOrder('short')).rejects.toMatchObject({ code: 'REQUIREMENTS_UNREADABLE' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    'https://api-m.paypal.com',
    'https://api.paypal.com',
    'https://mcp.paypal.com',
    'http://api-m.sandbox.paypal.com',
    'https://api-m.sandbox.paypal.com.evil.example',
  ])('refuses base URL %s at construction (no call made)', (baseUrl) => {
    const f = fakeFetch([]);
    expect(
      () => new SandboxPaypalClient({ clientId: ID, clientSecret: SECRET, fetch: f.fetch, baseUrl }),
    ).toThrow('ERR_HOST_REFUSED');
    expect(f.calls).toHaveLength(0);
  });

  it('accepts the second sandbox host', async () => {
    const f = fakeFetch([TOKEN, { status: 200, body: fixture('get-order-approved.json') }]);
    const client = new SandboxPaypalClient({
      clientId: ID,
      clientSecret: SECRET,
      fetch: f.fetch,
      baseUrl: 'https://api.sandbox.paypal.com',
    });
    await client.getOrder(ORDER);
    expect(f.calls.every((c) => c.url.startsWith('https://api.sandbox.paypal.com/'))).toBe(true);
  });

  it('refuses empty credentials', () => {
    expect(() => new SandboxPaypalClient({ clientId: '', clientSecret: SECRET })).toThrow('ERR_CONFIG');
    expect(() => new SandboxPaypalClient({ clientId: ID, clientSecret: '' })).toThrow('ERR_CONFIG');
  });

  it('never exposes credentials through JSON, inspect or String', () => {
    const { client } = mk([]);
    for (const s of [JSON.stringify(client), inspect(client, { depth: 9 }), String(client)]) {
      expect(s).not.toContain(SECRET);
      expect(s).not.toContain(ID);
    }
  });
});

describe('sandboxClientFromEnv', () => {
  const env = {
    PAYPAL_ENVIRONMENT: 'SANDBOX',
    PAYPAL_SANDBOX_CLIENT_ID: ID,
    PAYPAL_SANDBOX_CLIENT_SECRET: SECRET,
  };

  it('builds a client from the sandbox env names', async () => {
    const f = fakeFetch([TOKEN, { status: 200, body: fixture('get-order-approved.json') }]);
    const client = sandboxClientFromEnv(env, f.fetch);
    expect((await client.getOrder(ORDER)).status).toBe('APPROVED');
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['PRODUCTION', { ...env, PAYPAL_ENVIRONMENT: 'PRODUCTION' }, 'ERR_PRODUCTION_REFUSED'],
    ['no environment', { ...env, PAYPAL_ENVIRONMENT: undefined }, 'ERR_PRODUCTION_REFUSED'],
    ['no client id', { ...env, PAYPAL_SANDBOX_CLIENT_ID: undefined }, 'PAYPAL_SANDBOX_CLIENT_ID'],
    ['no secret', { ...env, PAYPAL_SANDBOX_CLIENT_SECRET: '' }, 'PAYPAL_SANDBOX_CLIENT_SECRET'],
  ])('refuses %s', (_n, e, msg) => {
    expect(() => sandboxClientFromEnv(e)).toThrow(msg);
    try {
      sandboxClientFromEnv(e);
    } catch (err) {
      expect(err).toBeInstanceOf(PaypalGuardError);
      expect(String(err)).not.toContain(SECRET);
    }
  });

  it('uses global fetch by default without calling it at construction', () => {
    expect(sandboxClientFromEnv(env)).toBeInstanceOf(SandboxPaypalClient);
  });
});
