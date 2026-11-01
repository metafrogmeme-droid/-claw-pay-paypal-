// adoptOrder: after a restart, the owner re-attaches a sandbox order created earlier, so pay_order can re-check
// it (APPROVED, pinned payee, same amount) and capture. The agent cannot reach this; call() has no such tool.
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
const gateOn = (mock: MockPaypal) => {
  const { rules, config } = loadPaypalRules(file, NOW);
  return new PaypalGate({
    rules,
    config,
    client: mock,
    clock: () => NOW,
    ownerOk: () => Promise.resolve(false),
  });
};

/** "Process 1" creates the order and exits; "process 2" is a fresh gate on the same PayPal. */
async function restarted(cost = 2) {
  const mock = new MockPaypal();
  const first = await gateOn(mock).call('create_order', order(cost));
  const id = first.orderId ?? '';
  const gate = gateOn(mock);
  const before = mock.calls.length;
  const calls = () => mock.calls.slice(before).map((c) => c.method);
  return { mock, gate, id, calls };
}

describe('PaypalGate.adoptOrder (owner-side resume after a restart)', () => {
  it('a fresh gate refuses to capture an order it did not create or adopt', async () => {
    const { mock, gate, id, calls } = await restarted();
    mock.approve(id);
    expect((await gate.call('pay_order', { id })).reason).toBe('REQUIREMENTS_UNREADABLE');
    expect(calls()).toEqual([]);
  });

  it('adopt makes no PayPal call; capture before the buyer approves sends nothing', async () => {
    const { gate, id, calls } = await restarted();
    const a = gate.adoptOrder(id, order(2));
    expect(a).toMatchObject({ outcome: 'ALLOWED', verdict: 'Allowed: within your limits', orderId: id });
    expect(calls()).toEqual([]);
    const r = await gate.call('pay_order', { id });
    expect(r).toMatchObject({
      outcome: 'ALLOWED',
      status: 'PAYER_ACTION_REQUIRED',
      paypalError: 'ORDER_NOT_APPROVED',
    });
    expect(calls()).toEqual(['getOrder']);
  });

  it('after the buyer approves: get_order re-check, then exactly one capture', async () => {
    const { mock, gate, id, calls } = await restarted();
    gate.adoptOrder(id, order(2));
    mock.approve(id);
    expect(await gate.call('pay_order', { id })).toMatchObject({ outcome: 'ALLOWED', status: 'COMPLETED' });
    expect(await gate.call('pay_order', { id })).toMatchObject({ status: 'COMPLETED' });
    expect(calls()).toEqual(['getOrder', 'captureOrder']);
  });

  it('a wrong amount on resume is caught by the re-check: no capture', async () => {
    const { mock, gate, id, calls } = await restarted(2);
    expect(gate.adoptOrder(id, order(2.5)).outcome).toBe('ALLOWED');
    mock.approve(id);
    expect((await gate.call('pay_order', { id })).reason).toBe('REQUIREMENTS_UNREADABLE');
    expect(calls()).toEqual(['getOrder']);
  });

  it('a swapped payee on PayPal is caught by the re-check: PAYTO_MISMATCH, no capture', async () => {
    const { mock, gate, id, calls } = await restarted();
    gate.adoptOrder(id, order(2));
    mock.setPayee(id, 'ATTACKERMERCHANT1');
    mock.approve(id);
    expect((await gate.call('pay_order', { id })).verdict).toMatch(/^Blocked by your rule: PAYTO_MISMATCH/);
    expect(calls()).toEqual(['getOrder']);
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    ['over the seller max', order(6), 'BLOCKED', 'Blocked by your rule:'],
    [
      'to another payee',
      order(2, { payee: { merchant_id: 'ATTACKERMERCHANT1' } }),
      'BLOCKED',
      'Blocked by your rule:',
    ],
    ['above the confirm threshold', order(4.5), 'NEEDS_OWNER_OK', 'Needs your OK:'],
  ])('an intent %s is not adopted, and pay_order then sends nothing', async (_n, args, outcome, prefix) => {
    const { mock, gate, id, calls } = await restarted();
    const a = gate.adoptOrder(id, args);
    expect(a.outcome).toBe(outcome);
    expect(a.verdict.startsWith(prefix)).toBe(true);
    mock.approve(id);
    expect((await gate.call('pay_order', { id })).reason).toBe('REQUIREMENTS_UNREADABLE');
    expect(calls()).toEqual([]);
  });

  it('refuses an unreadable order id or order, and works while paused only for reading', async () => {
    const { gate, id, calls } = await restarted();
    for (const bad of ['', 'abc', 'has space 123', 'X'.repeat(40), '../../etc']) {
      expect(gate.adoptOrder(bad, order(2)).reason).toBe('REQUIREMENTS_UNREADABLE');
    }
    expect(gate.adoptOrder(id, { currencyCode: 'USD' }).reason).toBe('REQUIREMENTS_UNREADABLE');
    gate.pause('owner');
    expect(gate.adoptOrder(id, order(2)).reason).toBe('PAUSED');
    expect(calls()).toEqual([]);
  });

  it('adopting the same id twice counts once', async () => {
    const { gate, id } = await restarted();
    gate.adoptOrder(id, order(2));
    const spent = gate.spentToday;
    expect(gate.adoptOrder(id, order(2)).outcome).toBe('ALLOWED');
    expect(gate.spentToday).toBe(spent);
    expect(spent).toBe(200n);
  });

  it('the agent cannot reach it through call()', async () => {
    const { gate, id, calls } = await restarted();
    for (const tool of ['adopt_order', 'adoptOrder', 'resume_order']) {
      expect((await gate.call(tool, { id, ...order(2) })).outcome).toBe('BLOCKED');
    }
    expect(calls()).toEqual([]);
  });
});
