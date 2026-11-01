// Resume after the buyer approved: re-attach the order, get_order re-check, then one capture. Recorded replies only.
import { describe, expect, it } from 'vitest';

import { fakeFetch, fixture, TOKEN } from '../../paypal/test/fake-fetch.js';
import { runSandboxResume } from '../src/sandbox-resume.js';

const SECRET = 'test-client-secret-not-real';
const ENV = {
  PAYPAL_ENVIRONMENT: 'SANDBOX',
  PAYPAL_SANDBOX_CLIENT_ID: 'test-client-id-not-real',
  PAYPAL_SANDBOX_CLIENT_SECRET: SECRET,
  PAYPAL_SANDBOX_PAYEE_MERCHANT_ID: 'FAKEMERCHANT01',
};
const ID = 'FAKEORDER00000001';
const APPROVED = { status: 200, body: fixture('get-order-approved.json') };
const WAITING = { status: 200, body: fixture('create-order.json') };
const CAPTURED = { status: 201, body: fixture('capture-completed.json') };

async function resume(
  argv: string[],
  replies: { status: number; body: unknown }[],
  env: Record<string, string> = ENV,
) {
  const { fetch, calls } = fakeFetch(replies);
  const lines: string[] = [];
  const code = await runSandboxResume(argv, env, (l) => lines.push(l), {
    fetch,
    clock: () => Date.UTC(2026, 10, 1, 9),
  });
  const text = lines.join('\n');
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('fake-access-token-for-tests');
  const sent = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  return { code, text, sent };
}

describe('runSandboxResume', () => {
  it('approved, your payee, same amount: get_order re-check, then exactly one capture', async () => {
    const r = await resume([ID, '--amount', '2.00'], [TOKEN, APPROVED, CAPTURED]);
    expect(r.code).toBe(0);
    expect(r.text).toContain(`adopt_order -> Allowed: within your limits | order ${ID}`);
    expect(r.text).toContain(`pay_order -> Allowed: within your limits | order ${ID} | status COMPLETED`);
    expect(r.sent).toEqual([
      'POST /v1/oauth2/token',
      `GET /v2/checkout/orders/${ID}`,
      `POST /v2/checkout/orders/${ID}/capture`,
    ]);
  });

  it('not approved yet: no capture, says so, exit 1', async () => {
    const r = await resume([ID, '--amount', '2.00'], [TOKEN, WAITING]);
    expect(r.code).toBe(1);
    expect(r.text).toContain(
      'Needs your OK: the buyer has not approved this order yet (status PAYER_ACTION_REQUIRED)',
    );
    expect(r.text).toContain('No capture was sent');
    expect(r.sent).toEqual(['POST /v1/oauth2/token', `GET /v2/checkout/orders/${ID}`]);
  });

  it('a different amount than PayPal holds: blocked, no capture', async () => {
    const r = await resume([ID, '--amount', '2.50'], [TOKEN, APPROVED]);
    expect(r.code).toBe(1);
    expect(r.text).toContain('pay_order -> Blocked by your rule: REQUIREMENTS_UNREADABLE');
    expect(r.sent).toEqual(['POST /v1/oauth2/token', `GET /v2/checkout/orders/${ID}`]);
  });

  it('PayPal shows another payee than yours: PAYTO_MISMATCH, no capture', async () => {
    const env = { ...ENV, PAYPAL_SANDBOX_PAYEE_MERCHANT_ID: 'OTHERMERCHANT01' };
    const r = await resume([ID, '--amount', '2.00'], [TOKEN, APPROVED], env);
    expect(r.code).toBe(1);
    expect(r.text).toContain('pay_order -> Blocked by your rule: PAYTO_MISMATCH');
    expect(r.sent).toHaveLength(2);
  });

  it('an amount your rules do not allow without your OK is not resumed: zero PayPal calls', async () => {
    for (const [amount, prefix] of [
      ['4.50', 'adopt_order -> Needs your OK:'],
      ['6.00', 'adopt_order -> Blocked by your rule:'],
    ] as const) {
      const r = await resume([ID, '--amount', amount], []);
      expect(r.code).toBe(1);
      expect(r.text).toContain(prefix);
      expect(r.sent).toEqual([]);
    }
  });

  it.each<[string, string[], Record<string, string>, string]>([
    ['no order id', ['--amount', '2.00'], ENV, 'usage'],
    ['no amount', [ID], ENV, 'usage'],
    ['an odd amount', [ID, '--amount', '2'], ENV, 'usage'],
    ['a bad order id', ['bad id', '--amount', '2.00'], ENV, 'Blocked by your rule: REQUIREMENTS_UNREADABLE'],
    [
      'no payee merchant id',
      [ID, '--amount', '2.00'],
      { ...ENV, PAYPAL_SANDBOX_PAYEE_MERCHANT_ID: '' },
      'PAYPAL_SANDBOX_PAYEE_MERCHANT_ID',
    ],
    [
      'no credentials',
      [ID, '--amount', '2.00'],
      { PAYPAL_SANDBOX_PAYEE_MERCHANT_ID: 'FAKEMERCHANT01' },
      'Blocked by your rule:',
    ],
  ])('%s: exit 2, zero PayPal calls', async (_n, argv, env, want) => {
    const r = await resume(argv, [], env);
    expect(r.code).toBe(2);
    expect(r.text).toContain(want);
    expect(r.sent).toEqual([]);
  });

  it('a PayPal error on get_order is shown as a code, no capture', async () => {
    const r = await resume(
      [ID, '--amount', '2.00'],
      [TOKEN, { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } }],
    );
    expect(r.code).toBe(1);
    expect(r.text).toMatch(
      /pay_order -> Allowed: within your limits \| order FAKEORDER00000001 \| PayPal error /,
    );
    expect(r.sent).toHaveLength(2);
  });
});
