// PayPal sandbox REST client (Orders v2), D-023. Sandbox hosts only; credentials stay in private fields and
// are never logged, printed or put in an error. Every request URL is checked against the sandbox allowlist.
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { PaypalApiError, type PaypalClient, type PaypalOrder } from './client.js';
import { formatMinor, toMinorUnits } from './money.js';
import { PaypalGuardError, SANDBOX_HOSTS, assertAllowedHost, assertSandboxEnv } from './sandbox.js';

/** The part of `fetch` we use, so tests inject recorded replies and CI never touches the network. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
    readonly redirect?: 'error';
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export interface SandboxClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Default `https://api-m.sandbox.paypal.com`. Anything that isn't a sandbox API host is refused. */
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly clock?: () => number;
  readonly timeoutMs?: number;
}

const ORDER_ID = /^[A-Z0-9]{17,32}$/;
const PAYER_ACTION_HOST = 'www.sandbox.paypal.com';
const DEFAULT_RETURN = 'https://example.com/returnUrl';
const DEFAULT_CANCEL = 'https://example.com/cancelUrl';

const optString = z.string().optional();
const item = z.strictObject({
  name: z.string().min(1).max(127),
  quantity: z.number().int().min(1).optional(),
  description: z.string().max(127).optional(),
  itemCost: z.number(),
  taxPercent: z.number().optional(),
  itemTotal: z.number(),
});
/** Same fields as the gate's create_order schema minus `payee` (the gate strips it, D-016). */
const createArgs = z.strictObject({
  currencyCode: z.literal('USD'),
  items: z.array(item).min(1).max(50),
  discount: z.number().optional(),
  shippingCost: z.number().optional(),
  shippingAddress: z
    .strictObject({
      address_line_1: optString,
      address_line_2: optString,
      admin_area_2: optString,
      admin_area_1: optString,
      postal_code: optString,
      country_code: z.string().length(2).optional(),
    })
    .nullable()
    .optional(),
  notes: z.string().nullable().optional(),
  returnUrl: optString,
  cancelUrl: optString,
});

const money = z.object({ currency_code: z.string(), value: z.string() });
const orderReply = z.object({
  id: z.string().regex(ORDER_ID),
  status: z.string().min(1),
  links: z.array(z.object({ href: z.string(), rel: z.string() })).optional(),
  purchase_units: z
    .array(
      z.object({
        amount: money.optional(),
        payee: z.object({ merchant_id: z.string().optional() }).optional(),
        payments: z
          .object({ captures: z.array(z.object({ id: z.string(), amount: money.optional() })).optional() })
          .optional(),
      }),
    )
    .optional(),
});
const tokenReply = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() });
const errorReply = z.object({
  name: z.string().optional(),
  details: z.array(z.object({ issue: z.string() })).optional(),
});

/** zod parse that returns undefined instead of throwing. */
function check<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  try {
    return schema.parse(value);
  } catch {
    return undefined;
  }
}

const unreadable = (): PaypalApiError => new PaypalApiError('REQUIREMENTS_UNREADABLE');
const amt = (currency: string, minor: bigint) => ({ currency_code: currency, value: formatMinor(minor) });

/**
 * Toolkit-shaped create_order args → Orders v2 body, with every amount as an exact decimal string built from
 * bigint minor units (the toolkit itself does this in floats). Throws REQUIREMENTS_UNREADABLE.
 */
export function ordersV2Body(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const o = check(createArgs, args);
  if (o === undefined) throw unreadable();
  const cur = o.currencyCode;
  let itemTotal = 0n;
  let taxTotal = 0n;
  const items = o.items.map((it) => {
    const cost = toMinorUnits(it.itemCost);
    const total = toMinorUnits(it.itemTotal);
    const taxBp = toMinorUnits(it.taxPercent ?? 0);
    if (cost === undefined || total === undefined || taxBp === undefined) throw unreadable();
    const qty = BigInt(it.quantity ?? 1);
    if (total !== cost * qty || (cost * taxBp) % 10_000n !== 0n) throw unreadable();
    const tax = (cost * taxBp) / 10_000n;
    itemTotal += cost * qty;
    taxTotal += tax * qty;
    return {
      name: it.name,
      quantity: String(qty),
      unit_amount: amt(cur, cost),
      ...(tax > 0n ? { tax: amt(cur, tax) } : {}),
      ...(it.description === undefined ? {} : { description: it.description }),
    };
  });
  const shipping = toMinorUnits(o.shippingCost ?? 0);
  const discount = toMinorUnits(o.discount ?? 0);
  if (shipping === undefined || discount === undefined) throw unreadable();
  const value = itemTotal + taxTotal + shipping - discount;
  if (value <= 0n) throw unreadable();
  const breakdown = {
    item_total: amt(cur, itemTotal),
    ...(taxTotal > 0n ? { tax_total: amt(cur, taxTotal) } : {}),
    ...(shipping > 0n ? { shipping: amt(cur, shipping) } : {}),
    ...(discount > 0n ? { discount: amt(cur, discount) } : {}),
  };
  const unit = {
    amount: { ...amt(cur, value), breakdown },
    items,
    ...(o.notes ? { description: o.notes.slice(0, 127) } : {}),
    ...(o.shippingAddress ? { shipping: { address: o.shippingAddress } } : {}),
  };
  return {
    intent: 'CAPTURE',
    purchase_units: [unit],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: o.returnUrl ?? DEFAULT_RETURN,
          cancel_url: o.cancelUrl ?? DEFAULT_CANCEL,
        },
      },
    },
  };
}

function toOrder(json: unknown): PaypalOrder {
  const o = check(orderReply, json);
  if (o === undefined) throw new PaypalApiError('RESPONSE_UNREADABLE');
  const unit = o.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  const money = capture?.amount ?? unit?.amount;
  const minor = money ? toMinorUnits(money.value) : undefined;
  const link = o.links?.find((l) => l.rel === 'payer-action')?.href;
  if (link !== undefined) {
    let host = '';
    try {
      const u = new URL(link);
      host = u.protocol === 'https:' ? u.hostname : '';
    } catch {
      /* unreadable link → refused below */
    }
    if (host !== PAYER_ACTION_HOST) throw new PaypalApiError('PAYER_ACTION_HOST_REFUSED');
  }
  return {
    id: o.id,
    status: o.status,
    ...(link === undefined ? {} : { payerActionUrl: link }),
    ...(unit?.payee?.merchant_id === undefined ? {} : { payeeMerchantId: unit.payee.merchant_id }),
    ...(money && minor !== undefined ? { amount: { currency: money.currency_code, minor } } : {}),
    ...(capture ? { captureId: capture.id } : {}),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class SandboxPaypalClient implements PaypalClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #clock: () => number;
  readonly #timeoutMs: number;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(o: SandboxClientOptions) {
    if (o.clientId === '' || o.clientSecret === '') {
      throw new PaypalGuardError('ERR_CONFIG', 'PayPal sandbox client id and secret are required');
    }
    const base = o.baseUrl ?? `https://${SANDBOX_HOSTS[0]}`;
    assertAllowedHost(base);
    this.#base = new URL(base).origin;
    this.#clientId = o.clientId;
    this.#clientSecret = o.clientSecret;
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#clock = o.clock ?? Date.now;
    this.#timeoutMs = o.timeoutMs ?? 20_000;
  }

  /** No credentials in JSON, String() or util.inspect(). */
  toJSON(): Record<string, string> {
    return { client: 'SandboxPaypalClient', base: this.#base };
  }
  toString(): string {
    return `SandboxPaypalClient(${this.#base})`;
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }

  async #send(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; json: unknown }> {
    const url = `${this.#base}${path}`;
    assertAllowedHost(url);
    const res = await this.#fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      // A redirect could leave the sandbox host allowlist, so it is an error, not followed.
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    return { status: res.status, json: parseJson(await res.text()) };
  }

  async #bearer(): Promise<string> {
    const now = this.#clock();
    if (this.#token && now < this.#token.expiresAt) return this.#token.value;
    const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64');
    const r = await this.#send(
      'POST',
      '/v1/oauth2/token',
      { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      'grant_type=client_credentials',
    );
    const t = check(tokenReply, r.json);
    // Never include PayPal's error text: it can echo request details.
    if (r.status !== 200 || t === undefined) throw new PaypalApiError('OAUTH_FAILED');
    this.#token = { value: t.access_token, expiresAt: now + (t.expires_in - 60) * 1000 };
    return t.access_token;
  }

  async #api(method: 'GET' | 'POST', path: string, extra: Record<string, string>, body?: string) {
    const headers = { Authorization: `Bearer ${await this.#bearer()}`, ...extra };
    const r = await this.#send(method, path, headers, body);
    if (r.status < 200 || r.status > 299) {
      const e = check(errorReply, r.json);
      const code = e === undefined ? undefined : (e.details?.[0]?.issue ?? e.name);
      throw new PaypalApiError(code ?? `HTTP_${String(r.status)}`);
    }
    return toOrder(r.json);
  }

  async createOrder(args: Readonly<Record<string, unknown>>): Promise<PaypalOrder> {
    const body = JSON.stringify(ordersV2Body(args));
    return this.#api(
      'POST',
      '/v2/checkout/orders',
      {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        // One key per order (never one global request id).
        'PayPal-Request-Id': `claw-pay-create-${randomUUID()}`,
      },
      body,
    );
  }

  getOrder(id: string): Promise<PaypalOrder> {
    if (!ORDER_ID.test(id)) return Promise.reject(unreadable());
    return this.#api('GET', `/v2/checkout/orders/${id}`, {});
  }

  captureOrder(id: string): Promise<PaypalOrder> {
    if (!ORDER_ID.test(id)) return Promise.reject(unreadable());
    return this.#api(
      'POST',
      `/v2/checkout/orders/${id}/capture`,
      {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        // Fixed per order: a repeated capture is the same request to PayPal too.
        'PayPal-Request-Id': `claw-pay-capture-${id}`,
      },
      '{}',
    );
  }
}

/** Build the client from env: PAYPAL_ENVIRONMENT must be SANDBOX; creds from PAYPAL_SANDBOX_CLIENT_ID/SECRET. */
export function sandboxClientFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: FetchLike,
): SandboxPaypalClient {
  assertSandboxEnv(env);
  const clientId = env['PAYPAL_SANDBOX_CLIENT_ID'] ?? '';
  const clientSecret = env['PAYPAL_SANDBOX_CLIENT_SECRET'] ?? '';
  if (clientId === '') throw new PaypalGuardError('ERR_CONFIG', 'PAYPAL_SANDBOX_CLIENT_ID is not set');
  if (clientSecret === '')
    throw new PaypalGuardError('ERR_CONFIG', 'PAYPAL_SANDBOX_CLIENT_SECRET is not set');
  return new SandboxPaypalClient({ clientId, clientSecret, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
