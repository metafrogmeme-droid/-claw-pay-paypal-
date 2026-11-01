// Test fixture. Addresses are obviously fake; amounts are atomic units (6 dp).
import type { PaymentIntent, Rules } from '../src/index.js';

export const NOW = Date.UTC(2026, 10, 2, 12, 0, 0); // Mon 2 Nov 2026 12:00 UTC
export const DAY = 86_400_000;
export const NET = 'eip155:84532';
export const ASSET = '0x00000000000000000000000000000000000000A1';
export const GOOD = { origin: 'https://good.test', payTo: '0x000000000000000000000000000000000000B0B0' };
export const EMPTY = { origin: 'https://empty.test', payTo: '0x000000000000000000000000000000000000E0E0' };
export const cents = (n: number): bigint => BigInt(Math.round(n * 100)) * 10_000n; // 0.01 -> 10_000n

export const rules: Rules = {
  version: 1,
  sellers: [
    { origin: GOOD.origin, payTo: GOOD.payTo, dailyCap: cents(0.2) },
    { origin: EMPTY.origin, payTo: EMPTY.payTo },
  ],
  perCallCap: cents(0.05),
  dailyCap: cents(0.3),
  maxPaymentsPerDay: 20,
  networks: [NET, 'paypal:sandbox'],
  assets: [
    { network: NET, asset: ASSET },
    { network: 'paypal:sandbox', asset: 'USD' },
  ],
  confirmThreshold: cents(0.04),
  quoteDriftBps: 1000,
  expiresAt: NOW + 7 * DAY,
  actions: ['pay'],
};

export function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    sellerOrigin: GOOD.origin,
    resourceUrl: `${GOOD.origin}/v1/data`,
    network: NET,
    asset: ASSET,
    amount: cents(0.01),
    payTo: GOOD.payTo,
    scheme: 'exact',
    quoteTime: NOW,
    action: 'pay',
    ...over,
  };
}
