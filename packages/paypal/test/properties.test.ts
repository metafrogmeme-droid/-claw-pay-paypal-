// Property tests for the PayPal adapter (P2 acceptance: >= 3).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalise, toMinorUnits, type PaypalConfig } from '../src/index.js';

const config: PaypalConfig = {
  network: 'paypal:sandbox',
  sellers: [{ id: 'seller-a', merchantId: 'SELLERAMERCHANT01' }],
  pinnedSellerId: 'seller-a',
};
const NOW = Date.UTC(2026, 10, 4, 12);
const KINDS = ['payment', 'capture', 'read', 'unreadable', 'unsupported'];

describe('PayPal adapter properties', () => {
  it('decimal → minor units is exact for every whole number of cents', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_000_000_000_000 }), (cents) => {
        expect(toMinorUnits(cents / 100)).toBe(BigInt(cents));
        const s = `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
        expect(toMinorUnits(s)).toBe(BigInt(cents));
      }),
    );
  });

  it('normalise never throws past zod, whatever the tool name and arguments', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom('create_order', 'pay_order', 'get_order')),
        fc.anything(),
        (tool, args) => {
          expect(KINDS).toContain(normalise(tool, args, config, NOW).kind);
        },
      ),
    );
  });

  it('any unknown field on create_order is unreadable', () => {
    const known = new Set([
      'currencyCode',
      'items',
      'discount',
      'shippingCost',
      'shippingAddress',
      'notes',
      'returnUrl',
      'cancelUrl',
      'payee',
    ]);
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((k) => !known.has(k) && k !== '__proto__'),
        fc.jsonValue(),
        (key, value) => {
          const args = {
            currencyCode: 'USD',
            items: [{ name: 'x', quantity: 1, itemCost: 2, taxPercent: 0, itemTotal: 2 }],
            [key]: value,
          };
          expect(normalise('create_order', args, config, NOW)).toEqual({ kind: 'unreadable' });
        },
      ),
    );
  });

  it('the args passed on to the toolkit never contain a payee', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          undefined,
          { merchant_id: 'SELLERAMERCHANT01' },
          { merchant_id: 'OTHERMERCHANT0001' },
        ),
        (payee) => {
          const args = {
            currencyCode: 'USD',
            items: [{ name: 'x', quantity: 1, itemCost: 2, taxPercent: 0, itemTotal: 2 }],
            ...(payee ? { payee } : {}),
          };
          const r = normalise('create_order', args, config, NOW);
          if (r.kind === 'payment') expect(r.toolkitArgs).not.toHaveProperty('payee');
        },
      ),
    );
  });
});
