// The PayPal calls the gate makes, and a mock that counts them (CI and judges' mock mode).
import { ordersV2Body } from './sandbox-client.js';

export interface PaypalOrder {
  readonly id: string;
  readonly status: string;
  readonly payerActionUrl?: string;
  /** `purchase_units[0].payee.merchant_id`, when PayPal returns it (create and get_order in sandbox do). */
  readonly payeeMerchantId?: string;
  /** Order amount (or capture amount) in minor units. */
  readonly amount?: { readonly currency: string; readonly minor: bigint };
  readonly captureId?: string;
}

/** The only PayPal operations the gate performs. `SandboxPaypalClient` is the real one (D-023). */
export interface PaypalClient {
  createOrder(args: Readonly<Record<string, unknown>>): Promise<PaypalOrder>;
  getOrder(id: string): Promise<PaypalOrder>;
  captureOrder(id: string): Promise<PaypalOrder>;
}

/** An error PayPal returned (e.g. 422 ORDER_NOT_APPROVED). Reported once; the gate never retries a money call. */
export class PaypalApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type Method = 'createOrder' | 'getOrder' | 'captureOrder';

/**
 * Mock PayPal with the Orders v2 response shapes: create → PAYER_ACTION_REQUIRED + payer-action link;
 * capture before approval → ORDER_NOT_APPROVED; approve() stands in for the sandbox buyer's browser click.
 */
export class MockPaypal implements PaypalClient {
  readonly calls: { readonly method: Method; readonly args: unknown }[] = [];
  readonly #status = new Map<string, string>();
  readonly #details = new Map<string, Pick<PaypalOrder, 'payeeMerchantId' | 'amount'>>();
  #next = 0;
  #failure: string | undefined;

  /** `payee` is the merchant id the mock reports on get_order (the demo's seller-a by default). */
  constructor(private readonly payee = 'SELLERAMERCHANT01') {}

  /** Test hook: make get_order report a different payee (e.g. the order was changed on PayPal's side). */
  setPayee(id: string, merchantId: string | undefined): void {
    const d = this.#details.get(id);
    if (!d) return;
    const { payeeMerchantId: _old, ...rest } = d;
    this.#details.set(id, merchantId === undefined ? rest : { ...rest, payeeMerchantId: merchantId });
  }

  approve(id: string): void {
    if (this.#status.get(id) === 'PAYER_ACTION_REQUIRED') this.#status.set(id, 'APPROVED');
  }

  failNext(code: string): void {
    this.#failure = code;
  }

  #record(method: Method, args: unknown): void {
    this.calls.push({ method, args });
    const f = this.#failure;
    this.#failure = undefined;
    if (f !== undefined) throw new PaypalApiError(f);
  }

  createOrder(args: Readonly<Record<string, unknown>>): Promise<PaypalOrder> {
    this.#record('createOrder', args);
    const id = `MOCK${String(++this.#next).padStart(13, '0')}`;
    this.#status.set(id, 'PAYER_ACTION_REQUIRED');
    this.#details.set(id, { payeeMerchantId: this.payee, ...mockAmount(args) });
    // Same link host as a real sandbox order's payer-action link.
    return Promise.resolve({
      id,
      status: 'PAYER_ACTION_REQUIRED',
      payerActionUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
    });
  }

  getOrder(id: string): Promise<PaypalOrder> {
    this.#record('getOrder', { id });
    const status = this.#status.get(id);
    return status === undefined
      ? Promise.reject(new PaypalApiError('RESOURCE_NOT_FOUND'))
      : Promise.resolve({ id, status, ...this.#details.get(id) });
  }

  captureOrder(id: string): Promise<PaypalOrder> {
    this.#record('captureOrder', { id });
    if (this.#status.get(id) !== 'APPROVED') return Promise.reject(new PaypalApiError('ORDER_NOT_APPROVED'));
    this.#status.set(id, 'COMPLETED');
    return Promise.resolve({ id, status: 'COMPLETED' });
  }
}

/** The order total the mock reports, built the same way the sandbox client builds the request body. */
function mockAmount(args: Readonly<Record<string, unknown>>): Pick<PaypalOrder, 'amount'> {
  try {
    const [unit] = ordersV2Body(args)['purchase_units'] as [
      { amount: { currency_code: string; value: string } },
    ];
    const minor = BigInt(unit.amount.value.replace('.', '')); // formatMinor output: always "<int>.<2 digits>"
    return { amount: { currency: unit.amount.currency_code, minor } };
  } catch {
    return {};
  }
}
