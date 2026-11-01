// The sandbox smoke runner on recorded, scrubbed sandbox replies. No network, fake credentials.
import { describe, expect, it } from 'vitest';

import { fakeFetch, fixture, TOKEN } from '../../paypal/test/fake-fetch.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { realSleep, runSandboxSmoke, smokeRules } from '../src/sandbox-smoke.js';

const SECRET = 'test-client-secret-not-real';
const ENV = {
  PAYPAL_ENVIRONMENT: 'SANDBOX',
  PAYPAL_SANDBOX_CLIENT_ID: 'test-client-id-not-real',
  PAYPAL_SANDBOX_CLIENT_SECRET: SECRET,
  PAYPAL_SANDBOX_PAYEE_MERCHANT_ID: 'FAKEMERCHANT01',
};
const CREATED = { status: 201, body: fixture('create-order.json') };
const APPROVED = { status: 200, body: fixture('get-order-approved.json') };
const CAPTURED = { status: 201, body: fixture('capture-completed.json') };
const WAITING = { status: 200, body: { ...(fixture('create-order.json') as object) } };

async function smoke(env: Record<string, string>, replies: { status: number; body: unknown }[]) {
  const { fetch, calls } = fakeFetch(replies);
  const lines: string[] = [];
  let t = Date.UTC(2026, 10, 1, 9);
  const code = await runSandboxSmoke(env, (l) => lines.push(l), {
    fetch,
    clock: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  });
  const text = lines.join('\n');
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('fake-access-token-for-tests');
  return { code, lines, text, calls };
}

describe('runSandboxSmoke', () => {
  it('creates one 2.00 USD order and stops at the buyer step (no capture, no get_order)', async () => {
    const { code, text, calls } = await smoke(ENV, [TOKEN, CREATED]);
    expect(code).toBe(0);
    expect(text).toContain(
      'Allowed: within your limits | order FAKEORDER00000001 | status PAYER_ACTION_REQUIRED',
    );
    expect(text).toContain('https://www.sandbox.paypal.com/checkoutnow?token=FAKEORDER00000001');
    expect(text).toContain('Stopped at PAYER_ACTION_REQUIRED (no capture)');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/oauth2/token',
      'POST /v2/checkout/orders',
    ]);
    const body = JSON.parse(calls[1]?.body ?? '{}') as { purchase_units: { amount: unknown }[] };
    expect(body.purchase_units[0]?.amount).toMatchObject({ currency_code: 'USD', value: '2.00' });
  });

  it('with CP_SMOKE_WAIT_MINUTES: polls get_order, then captures once the buyer approved', async () => {
    const { code, text, calls } = await smoke({ ...ENV, CP_SMOKE_WAIT_MINUTES: '1' }, [
      TOKEN,
      CREATED,
      WAITING,
      APPROVED,
      APPROVED,
      CAPTURED,
    ]);
    expect(code).toBe(0);
    expect(text).toContain(
      'pay_order -> Allowed: within your limits | order FAKEORDER00000001 | status COMPLETED',
    );
    expect(calls.filter((c) => c.url.endsWith('/capture'))).toHaveLength(1);
  });

  it('a capture that does not complete exits 1', async () => {
    const { code, text } = await smoke({ ...ENV, CP_SMOKE_WAIT_MINUTES: '1' }, [
      TOKEN,
      CREATED,
      APPROVED,
      APPROVED,
      { status: 422, body: fixture('capture-not-approved.json') },
    ]);
    expect(code).toBe(1);
    expect(text).toContain('PayPal error ORDER_NOT_APPROVED');
  });

  it('the buyer never approves → no capture is sent, exit 1', async () => {
    const { code, text, calls } = await smoke({ ...ENV, CP_SMOKE_WAIT_MINUTES: '1' }, [
      TOKEN,
      CREATED,
      WAITING,
      WAITING,
      WAITING,
      WAITING,
    ]);
    expect(code).toBe(1);
    expect(text).toContain('No capture was sent');
    expect(calls.some((c) => c.url.endsWith('/capture'))).toBe(false);
  });

  it('a payee that is not yours: the gate blocks the capture (PAYTO_MISMATCH)', async () => {
    const { code, text, calls } = await smoke(
      { ...ENV, PAYPAL_SANDBOX_PAYEE_MERCHANT_ID: 'OTHERMERCHANT9', CP_SMOKE_WAIT_MINUTES: '1' },
      [TOKEN, CREATED, APPROVED, APPROVED],
    );
    expect(code).toBe(1);
    expect(text).toContain('Blocked by your rule: PAYTO_MISMATCH');
    expect(calls.some((c) => c.url.endsWith('/capture'))).toBe(false);
  });

  it('a create that PayPal refuses exits 1', async () => {
    const { code, text } = await smoke(ENV, [TOKEN, { status: 500, body: '' }]);
    expect(code).toBe(1);
    expect(text).toContain('PayPal error HTTP_500');
  });

  it.each<[string, Record<string, string>, string]>([
    ['no payee', { ...ENV, PAYPAL_SANDBOX_PAYEE_MERCHANT_ID: '' }, 'PAYPAL_SANDBOX_PAYEE_MERCHANT_ID'],
    ['a live environment', { ...ENV, PAYPAL_ENVIRONMENT: 'LIVE' }, 'Blocked by your rule:'],
    ['no secret', { ...ENV, PAYPAL_SANDBOX_CLIENT_SECRET: '' }, 'PAYPAL_SANDBOX_CLIENT_SECRET is not set'],
  ])('%s → exit 2 with zero PayPal calls', async (_n, env, msg) => {
    const { code, text, calls } = await smoke(env, []);
    expect(code).toBe(2);
    expect(text).toContain(msg);
    expect(calls).toHaveLength(0);
  });

  it('smokeRules only repoints the pinned seller', () => {
    const file = {
      sellers: [
        { id: 'seller-a', merchantId: 'A', maxAmount: '5.00' },
        { id: 'seller-b', merchantId: 'B', maxAmount: '5.00' },
      ],
      pinnedSeller: 'seller-a',
    } as never;
    expect(smokeRules(file, 'MINE').sellers.map((s) => s.merchantId)).toEqual(['MINE', 'B']);
  });

  it('defaults: real clock, demo rules; a missing payee variable → exit 2', async () => {
    const { fetch } = fakeFetch([TOKEN, CREATED]);
    const lines: string[] = [];
    expect(await runSandboxSmoke(ENV, (l) => lines.push(l), { fetch })).toBe(0);
    const { PAYPAL_SANDBOX_PAYEE_MERCHANT_ID: _p, ...noPayee } = ENV;
    expect(await runSandboxSmoke(noPayee, (l) => lines.push(l), { fetch })).toBe(2);
  });

  it('the smoke never says yes for you: an order above your confirm threshold is not sent', async () => {
    const path = resolve(import.meta.dirname, '../../../demo/paypal/rules.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const { fetch, calls } = fakeFetch([]);
    const lines: string[] = [];
    const code = await runSandboxSmoke(ENV, (l) => lines.push(l), {
      fetch,
      rulesFile: { ...file, confirmThreshold: '1.00' } as never,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Needs your OK:');
    expect(calls).toHaveLength(0);
  });

  it('realSleep waits', async () => {
    const t = Date.now();
    await realSleep(5);
    expect(Date.now() - t).toBeGreaterThanOrEqual(4);
  });
});
