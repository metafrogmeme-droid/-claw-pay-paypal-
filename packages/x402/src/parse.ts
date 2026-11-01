// Fail-closed parsers for x402 payment requirements (docs/DECISIONS.md D-022).
// Field names trace to github.com/x402-foundation/x402 @ e208bd3: specs/x402-specification-v2.md §5.1,
// specs/transports-v2/http.md (PAYMENT-REQUIRED, Base64 JSON), specs/x402-specification-v1.md §5.1 and
// specs/transports-v1/http.md (v1: JSON response body). Anything unreadable → REQUIREMENTS_UNREADABLE.
import { z } from 'zod';

import { V1_NETWORKS } from './networks.js';

export const MAX_HEADER_BYTES = 128 * 1024;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_JSON_DEPTH = 64;
export const MAX_ACCEPTS = 32;
const MAX_UINT256 = 2n ** 256n - 1n;

export interface Accept {
  readonly scheme: string;
  /** CAIP-2. v1 names are mapped through V1_NETWORKS. */
  readonly network: string;
  /** Atomic units. v2 `amount`, v1 `maxAmountRequired`. For `upto` this is the maximum authorised. */
  readonly amount: bigint;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  /** `extra.paymentFlow`; omitted means the default `authorization` (v2 spec §6.1). */
  readonly paymentFlow: string;
  readonly assetTransferMethod?: string;
}

export interface PaymentRequirements {
  readonly x402Version: 1 | 2;
  readonly resourceUrl: string;
  readonly accepts: readonly Accept[];
}

export type ParseResult =
  | { readonly ok: true; readonly value: PaymentRequirements }
  | { readonly ok: false; readonly reason: 'REQUIREMENTS_UNREADABLE'; readonly detail: string };

const fail = (detail: string): ParseResult => ({ ok: false, reason: 'REQUIREMENTS_UNREADABLE', detail });

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const httpUrl = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
});
const nonEmpty = z.string().min(1);
const atomic = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform((s) => BigInt(s))
  .refine((n) => n <= MAX_UINT256);
const extra = z
  .looseObject({
    paymentFlow: z.string().min(1).optional(),
    assetTransferMethod: z.string().min(1).optional(),
  })
  .optional();
const common = {
  scheme: nonEmpty,
  asset: nonEmpty,
  payTo: nonEmpty,
  maxTimeoutSeconds: z.number().int().positive(),
  extra,
};
const v2Schema = z.looseObject({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: z.looseObject({ url: httpUrl }),
  accepts: z
    .array(z.looseObject({ ...common, network: z.string().regex(CAIP2), amount: atomic }))
    .min(1)
    .max(MAX_ACCEPTS),
});
const v1Schema = z.looseObject({
  x402Version: z.literal(1),
  error: z.string().optional(),
  accepts: z
    .array(
      z.looseObject({
        ...common,
        network: z.string(),
        maxAmountRequired: atomic,
        resource: httpUrl,
        description: z.string(),
        mimeType: z.string().optional(),
      }),
    )
    .min(1)
    .max(MAX_ACCEPTS),
});

/** Strict Base64 (RFC 4648 standard alphabet), padding optional, canonical bits, strict UTF-8. */
function decodeBase64(s: string): string | undefined {
  if (!BASE64.test(s)) return undefined;
  const body = s.replace(/=+$/, '');
  if ((body !== s && s.length % 4 !== 0) || body.length % 4 === 1) return undefined;
  const bytes = Buffer.from(body, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== body) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function tooDeep(v: unknown, depth: number): boolean {
  if (depth > MAX_JSON_DEPTH) return true;
  if (typeof v !== 'object' || v === null) return false;
  return Object.values(v).some((child) => tooDeep(child, depth + 1));
}

type Json = { ok: true; value: unknown } | { ok: false; detail: string };
function readJson(text: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'not JSON' };
  }
  return tooDeep(value, 0) ? { ok: false, detail: 'JSON too deep' } : { ok: true, value };
}

function read<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  try {
    return schema.parse(value);
  } catch {
    return undefined;
  }
}

type RawExtra = z.output<typeof extra>;
function flow(e: RawExtra): Pick<Accept, 'paymentFlow' | 'assetTransferMethod'> {
  return {
    paymentFlow: e?.paymentFlow ?? 'authorization',
    ...(e?.assetTransferMethod === undefined ? {} : { assetTransferMethod: e.assetTransferMethod }),
  };
}

/** Parse an x402 v2 `PAYMENT-REQUIRED` header value. Never throws. */
export function parseV2Header(header: string): ParseResult {
  if (header.length > MAX_HEADER_BYTES) return fail('header too large');
  const text = decodeBase64(header);
  if (text === undefined) return fail('not strict Base64 of UTF-8');
  const json = readJson(text);
  if (!json.ok) return fail(json.detail);
  const p = read(v2Schema, json.value);
  if (!p) return fail('does not match the v2 PaymentRequired schema');
  return {
    ok: true,
    value: {
      x402Version: 2,
      resourceUrl: p.resource.url,
      accepts: p.accepts.map((a) => ({
        scheme: a.scheme,
        network: a.network,
        amount: a.amount,
        asset: a.asset,
        payTo: a.payTo,
        maxTimeoutSeconds: a.maxTimeoutSeconds,
        ...flow(a.extra),
      })),
    },
  };
}

/** Parse an x402 v1 402 response body (read-only compatibility). Never throws. */
export function parseV1Body(body: string): ParseResult {
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return fail('body too large');
  const json = readJson(body);
  if (!json.ok) return fail(json.detail);
  const p = read(v1Schema, json.value);
  if (!p) return fail('does not match the v1 PaymentRequirementsResponse schema');
  const resources = new Set(p.accepts.map((a) => a.resource));
  if (resources.size !== 1) return fail('accepts entries name different resources');
  const accepts: Accept[] = [];
  for (const a of p.accepts) {
    const network = Object.hasOwn(V1_NETWORKS, a.network) ? V1_NETWORKS[a.network] : undefined;
    if (network === undefined) return fail(`unknown v1 network name: ${a.network}`);
    accepts.push({
      scheme: a.scheme,
      network,
      amount: a.maxAmountRequired,
      asset: a.asset,
      payTo: a.payTo,
      maxTimeoutSeconds: a.maxTimeoutSeconds,
      ...flow(a.extra),
    });
  }
  return { ok: true, value: { x402Version: 1, resourceUrl: String([...resources][0]), accepts } };
}
