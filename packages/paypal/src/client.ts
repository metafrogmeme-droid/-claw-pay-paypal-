// The PayPal calls the gate makes, and a mock that counts them (CI and judges' mock mode).

export interface PaypalOrder {
  readonly id: string;
  readonly status: string;
  readonly payerActionUrl?: string;
}

/** The only PayPal operations the gate performs. The sandbox implementation wraps the Agent Toolkit (P4). */
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
  #next = 0;
  #failure: string | undefined;

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
      : Promise.resolve({ id, status });
  }

  captureOrder(id: string): Promise<PaypalOrder> {
    this.#record('captureOrder', { id });
    if (this.#status.get(id) !== 'APPROVED') return Promise.reject(new PaypalApiError('ORDER_NOT_APPROVED'));
    this.#status.set(id, 'COMPLETED');
    return Promise.resolve({ id, status: 'COMPLETED' });
  }
}
